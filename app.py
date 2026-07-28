import hashlib
import hmac
import json
import os
import secrets
import shlex
import signal
import socket
import sqlite3
import subprocess
import threading
import time
import uuid
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

import psutil
from flask import Flask, Response, abort, jsonify, redirect, render_template, request, url_for


BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
LOG_DIR = DATA_DIR / "logs"
DB_PATH = DATA_DIR / "release_lite.db"
DATA_DIR.mkdir(exist_ok=True)
LOG_DIR.mkdir(exist_ok=True)

app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("RELEASE_LITE_SECRET", secrets.token_hex(32))
deploy_locks = {}
deploy_locks_guard = threading.Lock()


SCHEMA = """
CREATE TABLE IF NOT EXISTS projects (
 id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, root_path TEXT NOT NULL,
 branch TEXT NOT NULL DEFAULT 'main', is_git INTEGER NOT NULL DEFAULT 1, start_command TEXT NOT NULL, stop_command TEXT DEFAULT '',
 pre_deploy_hook TEXT DEFAULT '', post_deploy_hook TEXT DEFAULT '', env_vars TEXT DEFAULT '',
 auto_deploy INTEGER NOT NULL DEFAULT 0, auto_restart INTEGER NOT NULL DEFAULT 0,
 webhook_secret TEXT NOT NULL, git_webhook_secret TEXT DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS deployments (
 id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, action TEXT NOT NULL,
 branch TEXT, revision TEXT, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
 operator TEXT, message TEXT DEFAULT '', log_path TEXT, FOREIGN KEY(project_id) REFERENCES projects(id)
);
CREATE TABLE IF NOT EXISTS process_state (
 project_id INTEGER PRIMARY KEY, pid INTEGER, started_at TEXT, command TEXT, expected_running INTEGER NOT NULL DEFAULT 0,
 updated_at TEXT NOT NULL, FOREIGN KEY(project_id) REFERENCES projects(id)
);
CREATE TABLE IF NOT EXISTS operation_logs (
 id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER, action TEXT NOT NULL, operator TEXT,
 details TEXT DEFAULT '', created_at TEXT NOT NULL, FOREIGN KEY(project_id) REFERENCES projects(id)
);
"""


def now(): return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn
def rows(sql, args=()):
    with closing(db()) as c: return [dict(x) for x in c.execute(sql, args).fetchall()]
def one(sql, args=()):
    result = rows(sql, args)
    return result[0] if result else None
def write(sql, args=()):
    with closing(db()) as c:
        cur = c.execute(sql, args); c.commit(); return cur.lastrowid
def audit(project_id, action, details="", operator=None):
    write("INSERT INTO operation_logs(project_id,action,operator,details,created_at) VALUES(?,?,?,?,?)", (project_id, action, operator or request.headers.get("X-Operator", "web"), details, now()))
def project_or_404(project_id):
    p = one("SELECT * FROM projects WHERE id=?", (project_id,))
    if not p: abort(404)
    return p
def env_dict(raw):
    result = {}
    for line in (raw or "").splitlines():
        if line.strip() and not line.lstrip().startswith("#") and "=" in line:
            key, value = line.split("=", 1); result[key.strip()] = value.strip()
    return result
def safe_project_path(project):
    path = Path(project["root_path"]).expanduser().resolve()
    if not path.is_dir(): raise RuntimeError(f"项目目录不存在或不可访问：{path}")
    return path
def log_file(project_id, deployment_id): return LOG_DIR / f"project-{project_id}-deployment-{deployment_id}.log"
def append_log(path, text):
    with open(path, "a", encoding="utf-8") as f: f.write(text)
def run_command(command, cwd, env, logfile, title):
    append_log(logfile, f"\n$ {title}: {command}\n")
    p = subprocess.Popen(command, shell=True, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    assert p.stdout
    for line in iter(p.stdout.readline, ""): append_log(logfile, line)
    p.wait()
    if p.returncode: raise RuntimeError(f"{title} 失败，退出码 {p.returncode}")
def git(cwd, args, logfile):
    return run_command("git " + args, cwd, os.environ.copy(), logfile, "Git")
def git_output(cwd, args):
    return subprocess.check_output("git " + args, shell=True, cwd=cwd, text=True, stderr=subprocess.STDOUT).strip()
def alive(pid):
    try:
        if not pid or not psutil.pid_exists(pid): return False
        process = psutil.Process(pid)
        # 已退出但尚未被父进程回收的 zombie 不能视为运行中的服务。
        return process.is_running() and process.status() != psutil.STATUS_ZOMBIE
    except (psutil.Error, ValueError): return False
def process_info(project):
    state = one("SELECT * FROM process_state WHERE project_id=?", (project["id"],))
    pid = state["pid"] if state else None
    process_alive = alive(pid)
    expected_running = bool(state and state["expected_running"])
    # 用户停止后的状态以期望状态为准；这样进程退出回收的瞬间不会在界面上继续显示“运行中”。
    running = process_alive and expected_running
    info = {"pid": pid, "running": running, "process_alive": process_alive, "started_at": state["started_at"] if state else None, "expected_running": expected_running, "cpu": 0, "memory": 0, "ports": []}
    if process_alive:
        try:
            proc = psutil.Process(pid)
            # shell、npm、Python 启动脚本经常会派生真正的服务子进程；
            # 资源与监听端口都需按整个进程树汇总，而不是只看父进程。
            processes = [proc, *proc.children(recursive=True)]
            ports = set()
            for item in processes:
                try:
                    info["cpu"] += item.cpu_percent(interval=0.05)
                    info["memory"] += item.memory_info().rss
                    ports.update(conn.laddr.port for conn in item.net_connections(kind="inet") if conn.status == psutil.CONN_LISTEN and conn.laddr)
                except (psutil.Error, OSError):
                    continue
            info["cpu"] = round(info["cpu"], 1)
            info["ports"] = sorted(ports)
        except (psutil.Error, OSError): pass
    return info
def start_project(project, operator="web"):
    root = safe_project_path(project); state = process_info(project)
    if state["process_alive"]: raise RuntimeError("项目进程仍在运行，无法重复启动")
    env = os.environ.copy(); env.update(env_dict(project["env_vars"])); env["RELEASE_LITE_PROJECT_ID"] = str(project["id"])
    runtime_log = LOG_DIR / f"project-{project['id']}-runtime.log"
    output = open(runtime_log, "a", encoding="utf-8")
    output.write(f"\n--- start {now()} ---\n$ {project['start_command']}\n"); output.flush()
    proc = subprocess.Popen(project["start_command"], shell=True, cwd=root, env=env, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
    write("INSERT INTO process_state(project_id,pid,started_at,command,expected_running,updated_at) VALUES(?,?,?,?,1,?) ON CONFLICT(project_id) DO UPDATE SET pid=excluded.pid,started_at=excluded.started_at,command=excluded.command,expected_running=1,updated_at=excluded.updated_at", (project["id"], proc.pid, now(), project["start_command"], now()))
    audit(project["id"], "启动", f"PID {proc.pid}", operator); return proc.pid
def stop_project(project, operator="web", intentional=True):
    state = one("SELECT * FROM process_state WHERE project_id=?", (project["id"],))
    if not state or not alive(state["pid"]):
        write("UPDATE process_state SET expected_running=0,updated_at=? WHERE project_id=?", (now(), project["id"])); return
    if project["stop_command"]:
        env = os.environ.copy(); env.update(env_dict(project["env_vars"]))
        subprocess.run(project["stop_command"], shell=True, cwd=safe_project_path(project), env=env, timeout=45)
    if alive(state["pid"]):
        try: os.killpg(os.getpgid(state["pid"]), signal.SIGTERM)
        except (ProcessLookupError, PermissionError): pass
        for _ in range(30):
            if not alive(state["pid"]): break
            time.sleep(.1)
        if alive(state["pid"]):
            try: os.killpg(os.getpgid(state["pid"]), signal.SIGKILL)
            except (ProcessLookupError, PermissionError): pass
    write("UPDATE process_state SET expected_running=0,updated_at=? WHERE project_id=?", (now(), project["id"])); audit(project["id"], "停止", f"PID {state['pid']}", operator)
def deploy_worker(project_id, deployment_id, revision=None):
    project = project_or_404(project_id); logfile = log_file(project_id, deployment_id); root = safe_project_path(project)
    env = os.environ.copy(); env.update(env_dict(project["env_vars"]))
    try:
        if not project["is_git"]: raise RuntimeError("非 Git 项目不支持更新代码")
        append_log(logfile, f"代码更新开始：{now()}\n")
        if not (root / ".git").exists(): raise RuntimeError("项目目录不是 Git 仓库")
        if revision:
            git(root, "fetch --all --tags", logfile); git(root, f"checkout --detach {shlex.quote(revision)}", logfile)
        else:
            git(root, "fetch --prune origin", logfile); git(root, f"checkout {shlex.quote(project['branch'])}", logfile); git(root, f"pull --ff-only origin {shlex.quote(project['branch'])}", logfile)
        commit = git_output(root, "rev-parse HEAD")
        if project["pre_deploy_hook"]: run_command(project["pre_deploy_hook"], root, env, logfile, "更新代码前钩子")
        stop_project(project, "deploy", intentional=False)
        if project["post_deploy_hook"]: run_command(project["post_deploy_hook"], root, env, logfile, "更新代码后钩子")
        start_project(project, "deploy")
        write("UPDATE deployments SET status='success',revision=?,finished_at=?,message=? WHERE id=?", (commit, now(), "代码更新完成", deployment_id))
        audit(project_id, "代码更新成功", commit, "deploy")
        append_log(logfile, f"代码更新成功：{commit}\n")
    except Exception as exc:
        msg = str(exc); append_log(logfile, f"\n代码更新失败：{msg}\n")
        write("UPDATE deployments SET status='failed',finished_at=?,message=? WHERE id=?", (now(), msg, deployment_id)); audit(project_id, "代码更新失败", msg, "deploy")
    finally:
        with deploy_locks_guard: deploy_locks.pop(project_id, None)
def queue_deploy(project, operator="web", revision=None, action="deploy"):
    if not project["is_git"]: raise RuntimeError("非 Git 项目不支持更新代码")
    with deploy_locks_guard:
        if project["id"] in deploy_locks: raise RuntimeError("该项目已有代码更新任务在执行")
        did = write("INSERT INTO deployments(project_id,action,branch,revision,status,started_at,operator,log_path) VALUES(?,?,?,?,?,?,?,?)", (project["id"], action, project["branch"], revision, "running", now(), operator, str(log_file(project["id"], "pending"))))
        path = str(log_file(project["id"], did)); write("UPDATE deployments SET log_path=? WHERE id=?", (path, did))
        t = threading.Thread(target=deploy_worker, args=(project["id"], did, revision), daemon=True); deploy_locks[project["id"]] = t; t.start(); return did
def discover_scripts(root_path):
    try:
        root = Path(root_path).expanduser().resolve(); scripts=[]
        for p in root.glob("*.sh"): scripts.append(f"bash {shlex.quote(p.name)}")
        for p in root.glob("*.py"):
            if p.name not in {"app.py", "manage.py"}: scripts.append(f"python3 {shlex.quote(p.name)}")
        package = root / "package.json"
        if package.exists():
            for name in json.loads(package.read_text()).get("scripts", {}): scripts.append(f"npm run {name}")
        return scripts
    except Exception: return []

@app.route("/")
def index(): return render_template("index.html")
@app.get("/api/overview")
def overview():
    projects = rows("SELECT * FROM projects ORDER BY name")
    for p in projects: p["process"] = process_info(p)
    vm, disk = psutil.virtual_memory(), psutil.disk_usage("/")
    return jsonify({"projects": projects, "system": {"hostname": socket.gethostname(), "os": f"{os.uname().sysname} {os.uname().release}", "cpu_count": psutil.cpu_count(), "cpu_percent": psutil.cpu_percent(), "memory_total": vm.total, "memory_used": vm.used, "memory_percent": vm.percent, "disk_total": disk.total, "disk_used": disk.used, "disk_percent": disk.percent, "network": psutil.net_io_counters()._asdict()}})
@app.get("/api/projects")
def list_projects(): return jsonify(rows("SELECT * FROM projects ORDER BY name"))
@app.post("/api/projects")
def save_project():
    data=request.get_json(force=True); name=(data.get("name") or "").strip(); root=(data.get("root_path") or "").strip(); command=(data.get("start_command") or "").strip()
    if not name or not root or not command: return jsonify(error="名称、项目目录和启动命令均为必填项"), 400
    try: safe_project_path({"root_path":root})
    except RuntimeError as e: return jsonify(error=str(e)), 400
    is_git=int(not bool(data.get("non_git")))
    vals=(name,root,data.get("branch") or "main",is_git,command,data.get("stop_command") or "",data.get("pre_deploy_hook") or "",data.get("post_deploy_hook") or "",data.get("env_vars") or "",int(bool(data.get("auto_deploy"))) if is_git else 0,int(bool(data.get("auto_restart"))),data.get("git_webhook_secret") if is_git else "",now())
    if data.get("id"):
        project_or_404(data["id"]); write("UPDATE projects SET name=?,root_path=?,branch=?,is_git=?,start_command=?,stop_command=?,pre_deploy_hook=?,post_deploy_hook=?,env_vars=?,auto_deploy=?,auto_restart=?,git_webhook_secret=?,updated_at=? WHERE id=?", vals+(data["id"],)); audit(data["id"], "更新项目", name); return jsonify(id=data["id"])
    wid=secrets.token_urlsafe(24); pid=write("INSERT INTO projects(name,root_path,branch,is_git,start_command,stop_command,pre_deploy_hook,post_deploy_hook,env_vars,auto_deploy,auto_restart,webhook_secret,git_webhook_secret,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", vals[:11]+(wid,vals[11],now(),now())); audit(pid,"创建项目",name); return jsonify(id=pid)
@app.delete("/api/projects/<int:project_id>")
def delete_project(project_id):
    p=project_or_404(project_id); stop_project(p); write("DELETE FROM projects WHERE id=?",(project_id,)); audit(None,"删除项目",p["name"]); return jsonify(ok=True)
@app.post("/api/projects/<int:project_id>/action/<action>")
def action(project_id,action):
    p=project_or_404(project_id)
    try:
        if action=="start": start_project(p)
        elif action=="stop": stop_project(p)
        elif action=="restart": stop_project(p); start_project(p); audit(project_id,"重启",p["name"])
        elif action=="deploy": return jsonify(deployment_id=queue_deploy(p))
        else: abort(404)
        return jsonify(ok=True)
    except Exception as e: return jsonify(error=str(e)),400
@app.get("/api/projects/<int:project_id>/scripts")
def scripts(project_id): return jsonify(discover_scripts(project_or_404(project_id)["root_path"]))
@app.post("/api/discover-scripts")
def discover_scripts_api():
    root = (request.get_json(force=True).get("root_path") or "").strip()
    try:
        safe_project_path({"root_path": root})
        return jsonify(discover_scripts(root))
    except RuntimeError as e:
        return jsonify(error=str(e)), 400
@app.get("/api/projects/<int:project_id>/logs/<kind>")
def logs(project_id,kind):
    project_or_404(project_id); path = LOG_DIR / f"project-{project_id}-runtime.log" if kind=="runtime" else Path((one("SELECT log_path FROM deployments WHERE project_id=? ORDER BY id DESC LIMIT 1",(project_id,)) or {}).get("log_path", ""))
    if not path.exists(): return jsonify(text="暂无日志")
    return jsonify(text=path.read_text(encoding="utf-8", errors="replace")[-100000:])
@app.get("/api/projects/<int:project_id>/deployments")
def deployments(project_id): return jsonify(rows("SELECT * FROM deployments WHERE project_id=? ORDER BY id DESC LIMIT 50",(project_id,)))
@app.post("/api/projects/<int:project_id>/rollback/<int:deployment_id>")
def rollback(project_id,deployment_id):
    p=project_or_404(project_id); d=one("SELECT * FROM deployments WHERE id=? AND project_id=? AND status='success' AND revision IS NOT NULL",(deployment_id,project_id))
    if not d:return jsonify(error="未找到可回退的成功版本"),404
    return jsonify(deployment_id=queue_deploy(p,revision=d["revision"],action="rollback"))
@app.get("/api/operations")
def operations(): return jsonify(rows("SELECT o.*,p.name project_name FROM operation_logs o LEFT JOIN projects p ON p.id=o.project_id ORDER BY o.id DESC LIMIT 100"))
@app.post("/webhook/<int:project_id>/<secret>")
def webhook(project_id,secret):
    p=project_or_404(project_id)
    if not p["is_git"]: return jsonify(message="非 Git 项目不支持自动更新代码"),202
    if not hmac.compare_digest(secret,p["webhook_secret"]): abort(403)
    body=request.get_data()
    if p["git_webhook_secret"]:
        sig=request.headers.get("X-Hub-Signature-256",""); expected="sha256="+hmac.new(p["git_webhook_secret"].encode(),body,hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig,expected): abort(403)
    payload=request.get_json(silent=True) or {}; ref=payload.get("ref","")
    if not p["auto_deploy"]: return jsonify(message="自动更新代码未开启"),202
    if ref and ref not in (p["branch"],"refs/heads/"+p["branch"]): return jsonify(message="分支不匹配，已忽略"),202
    try: return jsonify(deployment_id=queue_deploy(p,"webhook")),202
    except RuntimeError as e:return jsonify(message=str(e)),202
def monitor():
    while True:
        time.sleep(20)
        for p in rows("SELECT * FROM projects WHERE auto_restart=1"):
            state=one("SELECT * FROM process_state WHERE project_id=?",(p["id"],))
            if state and state["expected_running"] and not alive(state["pid"]):
                try: start_project(p,"monitor"); audit(p["id"],"异常自动重启",f"原 PID {state['pid']}","monitor")
                except Exception as e:audit(p["id"],"自动重启失败",str(e),"monitor")
def init():
    with closing(db()) as c:
        c.executescript(SCHEMA)
        columns = {row[1] for row in c.execute("PRAGMA table_info(projects)")}
        if "is_git" not in columns:
            c.execute("ALTER TABLE projects ADD COLUMN is_git INTEGER NOT NULL DEFAULT 1")
        c.commit()
init()
if __name__ == "__main__":
    threading.Thread(target=monitor,daemon=True).start(); app.run(host="0.0.0.0",port=int(os.environ.get("PORT",8080)),debug=False)
