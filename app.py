import hashlib
import hmac
import json
import os
import pty
import secrets
import shlex
import shutil
import signal
import socket
import sqlite3
import subprocess
import threading
import time
import uuid
import fcntl
import struct
import termios
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

import psutil
from flask import Flask, Response, abort, jsonify, redirect, render_template, request, url_for
from flask_socketio import SocketIO


BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
LOG_DIR = DATA_DIR / "logs"
DB_PATH = DATA_DIR / "release_lite.db"
DATA_DIR.mkdir(exist_ok=True)
LOG_DIR.mkdir(exist_ok=True)
DEFAULT_BROWSE_ROOTS = ("/srv", "/opt", "/var/www", str(Path.home()))

app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("RELEASE_LITE_SECRET", secrets.token_hex(32))
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")
deploy_locks = {}
deploy_locks_guard = threading.Lock()
terminal_sessions = {}
terminal_sessions_guard = threading.Lock()


SCHEMA = """
CREATE TABLE IF NOT EXISTS projects (
 id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, root_path TEXT NOT NULL,
 branch TEXT NOT NULL DEFAULT 'main', is_git INTEGER NOT NULL DEFAULT 1, start_command TEXT NOT NULL, stop_command TEXT DEFAULT '',
 pre_deploy_hook TEXT DEFAULT '', post_deploy_hook TEXT DEFAULT '', env_vars TEXT DEFAULT '',
 auto_deploy INTEGER NOT NULL DEFAULT 0, auto_restart INTEGER NOT NULL DEFAULT 0,
 runtime TEXT NOT NULL DEFAULT 'python', python_executable TEXT DEFAULT 'python3', venv_path TEXT DEFAULT '.venv',
 requirements_file TEXT DEFAULT 'requirements.txt', auto_install_dependencies INTEGER NOT NULL DEFAULT 1, node_version TEXT DEFAULT '',
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
def server_ip():
    # 优先取默认路由对应的网卡地址，而不是 hostname 解析出的回环地址。
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(("8.8.8.8", 80))
            address = probe.getsockname()[0]
            if address and not address.startswith("127."):
                return address
    except OSError:
        pass
    states = psutil.net_if_stats()
    for interface, addresses in psutil.net_if_addrs().items():
        if not states.get(interface) or not states[interface].isup:
            continue
        for address in addresses:
            if address.family == socket.AF_INET and not address.address.startswith(("127.", "169.254.")):
                return address.address
    return "127.0.0.1"
def system_disk_usage():
    # macOS 的 / 是只读系统卷；真实用户文件和应用占用在 APFS Data 卷中。
    # Linux/Windows 环境则继续使用系统根卷。
    data_volume = Path("/System/Volumes/Data")
    if os.uname().sysname == "Darwin" and data_volume.is_dir():
        return psutil.disk_usage(str(data_volume))
    return psutil.disk_usage("/")
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
def project_setting_path(root, configured, default=""):
    value = (configured or default).strip()
    if not value: return None
    path = Path(value).expanduser()
    return path.resolve() if path.is_absolute() else (root / path).resolve()
def nvm_dir():
    return Path(os.environ.get("NVM_DIR") or (Path.home() / ".nvm")).expanduser().resolve()
def installed_node_versions():
    versions_path = nvm_dir() / "versions" / "node"
    if not versions_path.is_dir(): return []
    return sorted((item.name for item in versions_path.iterdir() if item.is_dir() and (item / "bin" / "node").exists()), reverse=True)
def node_bin(version):
    if not version: return None
    candidates = installed_node_versions()
    wanted = version if version.startswith("v") else "v" + version
    matches = [item for item in candidates if item == wanted or item.startswith(wanted + ".")]
    if not matches: raise RuntimeError(f"未找到 NVM 中的 Node.js 版本：{version}")
    return nvm_dir() / "versions" / "node" / matches[0] / "bin"
def apply_runtime_env(project, root, env):
    runtime = project.get("runtime", "python")
    if runtime == "python":
        venv = project_setting_path(root, project.get("venv_path"), ".venv")
        if venv and (venv / "bin").is_dir():
            env["VIRTUAL_ENV"] = str(venv)
            env["PATH"] = str(venv / "bin") + os.pathsep + env.get("PATH", "")
    elif runtime == "node":
        version_bin = node_bin(project.get("node_version"))
        if version_bin:
            env["NVM_DIR"] = str(nvm_dir())
            env["NVM_BIN"] = str(version_bin)
            env["PATH"] = str(version_bin) + os.pathsep + env.get("PATH", "")
    return env
def prepare_python_environment(project, root, env, logfile):
    if project.get("runtime", "python") != "python": return env
    venv = project_setting_path(root, project.get("venv_path"), ".venv")
    if not venv: return env
    python = project.get("python_executable") or "python3"
    if not (venv / "bin" / "python").exists():
        run_command(f"{shlex.quote(python)} -m venv {shlex.quote(str(venv))}", root, env, logfile, "创建 Python 虚拟环境")
    env = apply_runtime_env(project, root, env)
    requirements = project_setting_path(root, project.get("requirements_file"), "requirements.txt")
    if project.get("auto_install_dependencies") and requirements and requirements.is_file():
        pip = venv / "bin" / "pip"
        run_command(f"{shlex.quote(str(pip))} install -r {shlex.quote(str(requirements))}", root, env, logfile, "安装 pip 依赖")
    return env
def safe_project_path(project):
    path = Path(project["root_path"]).expanduser().resolve()
    if not path.is_dir(): raise RuntimeError(f"项目目录不存在或不可访问：{path}")
    return path
def browse_roots():
    configured = os.environ.get("RELEASE_LITE_BROWSE_ROOTS", "")
    raw_roots = configured.split(os.pathsep) if configured else DEFAULT_BROWSE_ROOTS
    roots = []
    for raw in raw_roots:
        path = Path(raw).expanduser().resolve()
        if path.is_dir() and path not in roots: roots.append(path)
    return roots
def allowed_browse_path(path):
    resolved = Path(path).expanduser().resolve()
    if not any(resolved == root or root in resolved.parents for root in browse_roots()):
        raise RuntimeError("该目录不在允许浏览的根目录中")
    if not resolved.is_dir(): raise RuntimeError("目录不存在或不可访问")
    return resolved
def log_file(project_id, deployment_id): return LOG_DIR / f"project-{project_id}-deployment-{deployment_id}.log"
def project_log_path(project_id, kind):
    if kind == "runtime": return LOG_DIR / f"project-{project_id}-runtime.log"
    if kind == "deploy":
        latest = one("SELECT log_path FROM deployments WHERE project_id=? ORDER BY id DESC LIMIT 1", (project_id,))
        return Path(latest["log_path"]) if latest and latest.get("log_path") else LOG_DIR / f"project-{project_id}-no-deploy.log"
    abort(404)
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
    env = os.environ.copy(); env.update(env_dict(project["env_vars"])); env["RELEASE_LITE_PROJECT_ID"] = str(project["id"]); env = apply_runtime_env(project, root, env)
    runtime_log = LOG_DIR / f"project-{project['id']}-runtime.log"
    append_log(runtime_log, f"\n--- start {now()} ---\n$ {project['start_command']}\n")
    _, pid = launch_project_terminal(project, root, env, runtime_log)
    write("INSERT INTO process_state(project_id,pid,started_at,command,expected_running,updated_at) VALUES(?,?,?,?,1,?) ON CONFLICT(project_id) DO UPDATE SET pid=excluded.pid,started_at=excluded.started_at,command=excluded.command,expected_running=1,updated_at=excluded.updated_at", (project["id"], pid, now(), project["start_command"], now()))
    audit(project["id"], "启动", f"PID {pid}", operator); return pid
def stop_project(project, operator="web", intentional=True):
    close_project_terminal(project["id"])
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
    env = os.environ.copy(); env.update(env_dict(project["env_vars"])); env = apply_runtime_env(project, root, env)
    try:
        if not project["is_git"]: raise RuntimeError("非 Git 项目不支持更新代码")
        append_log(logfile, f"代码更新开始：{now()}\n")
        if not (root / ".git").exists(): raise RuntimeError("项目目录不是 Git 仓库")
        if revision:
            git(root, "fetch --all --tags", logfile); git(root, f"checkout --detach {shlex.quote(revision)}", logfile)
        else:
            git(root, "fetch --prune origin", logfile); git(root, f"checkout {shlex.quote(project['branch'])}", logfile); git(root, f"pull --ff-only origin {shlex.quote(project['branch'])}", logfile)
        commit = git_output(root, "rev-parse HEAD")
        env = prepare_python_environment(project, root, env, logfile)
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
    vm, disk = psutil.virtual_memory(), system_disk_usage()
    return jsonify({"projects": projects, "system": {"hostname": socket.gethostname(), "local_ip": server_ip(), "os": f"{os.uname().sysname} {os.uname().release}", "cpu_count": psutil.cpu_count(), "cpu_percent": psutil.cpu_percent(), "memory_total": vm.total, "memory_used": vm.used, "memory_percent": vm.percent, "disk_total": disk.total, "disk_used": disk.used, "disk_percent": disk.percent, "network": psutil.net_io_counters()._asdict()}})
@app.get("/api/projects")
def list_projects(): return jsonify(rows("SELECT * FROM projects ORDER BY name"))
@app.get("/api/node-versions")
def node_versions(): return jsonify({"versions": installed_node_versions(), "nvm_dir": str(nvm_dir())})
@app.post("/api/projects")
def save_project():
    data=request.get_json(force=True); name=(data.get("name") or "").strip(); root=(data.get("root_path") or "").strip(); command=(data.get("start_command") or "").strip()
    if not name or not root or not command: return jsonify(error="名称、项目目录和启动命令均为必填项"), 400
    runtime = data.get("runtime") or "python"
    if runtime not in {"python", "node", "generic"}: return jsonify(error="不支持的运行环境"), 400
    try: safe_project_path({"root_path":root})
    except RuntimeError as e: return jsonify(error=str(e)), 400
    is_git=int(not bool(data.get("non_git")))
    vals=(name,root,data.get("branch") or "main",is_git,command,data.get("stop_command") or "",data.get("pre_deploy_hook") or "",data.get("post_deploy_hook") or "",data.get("env_vars") or "",int(bool(data.get("auto_deploy"))) if is_git else 0,int(bool(data.get("auto_restart"))),runtime,data.get("python_executable") or "python3",data.get("venv_path") or ".venv",data.get("requirements_file") or "requirements.txt",int(bool(data.get("auto_install_dependencies"))),data.get("node_version") if runtime == "node" else "",data.get("git_webhook_secret") if is_git else "",now())
    if data.get("id"):
        project_or_404(data["id"]); write("UPDATE projects SET name=?,root_path=?,branch=?,is_git=?,start_command=?,stop_command=?,pre_deploy_hook=?,post_deploy_hook=?,env_vars=?,auto_deploy=?,auto_restart=?,runtime=?,python_executable=?,venv_path=?,requirements_file=?,auto_install_dependencies=?,node_version=?,git_webhook_secret=?,updated_at=? WHERE id=?", vals+(data["id"],)); audit(data["id"], "更新项目", name); return jsonify(id=data["id"])
    wid=secrets.token_urlsafe(24); pid=write("INSERT INTO projects(name,root_path,branch,is_git,start_command,stop_command,pre_deploy_hook,post_deploy_hook,env_vars,auto_deploy,auto_restart,runtime,python_executable,venv_path,requirements_file,auto_install_dependencies,node_version,webhook_secret,git_webhook_secret,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", vals[:17]+(wid,vals[17],now(),now())); audit(pid,"创建项目",name); return jsonify(id=pid)
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
@app.get("/api/directories")
def directories():
    path = request.args.get("path")
    roots = browse_roots()
    if not path:
        return jsonify({"path": None, "parent": None, "roots": [str(root) for root in roots], "directories": []})
    try:
        current = allowed_browse_path(path)
        directories = []
        for child in sorted(current.iterdir(), key=lambda item: item.name.lower()):
            try:
                if child.is_dir() and not child.name.startswith("."):
                    resolved = child.resolve()
                    if any(resolved == root or root in resolved.parents for root in roots):
                        directories.append({"name": child.name, "path": str(resolved)})
            except OSError:
                continue
        parent = current.parent
        parent_value = str(parent) if any(parent == root or root in parent.parents for root in roots) else None
        return jsonify({"path": str(current), "parent": parent_value, "roots": [str(root) for root in roots], "directories": directories})
    except (RuntimeError, OSError) as e:
        return jsonify(error=str(e)), 400
@app.get("/api/projects/<int:project_id>/logs/<kind>")
def logs(project_id,kind):
    project_or_404(project_id); path = project_log_path(project_id, kind)
    if not path.exists(): return jsonify(text="暂无日志")
    return jsonify(text=path.read_text(encoding="utf-8", errors="replace")[-100000:])
@app.get("/api/projects/<int:project_id>/logs/summary")
def log_summary(project_id):
    project_or_404(project_id)
    runtime, deploy = project_log_path(project_id, "runtime"), project_log_path(project_id, "deploy")
    return jsonify({"runtime_size": runtime.stat().st_size if runtime.exists() else 0, "deploy_size": deploy.stat().st_size if deploy.exists() else 0})
@app.post("/api/projects/<int:project_id>/logs/<kind>/clear")
def clear_log(project_id, kind):
    project_or_404(project_id); path = project_log_path(project_id, kind)
    if path.exists():
        with open(path, "w", encoding="utf-8"): pass
    audit(project_id, f"清除{'运行' if kind == 'runtime' else '代码更新'}日志", str(path))
    return jsonify(ok=True)
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
def terminal_session_name(project_id):
    return f"release-lite-project-{project_id}" if project_id else "release-lite-shell"
def terminal_cwd(project_id):
    return safe_project_path(project_or_404(project_id)) if project_id else Path.home()
def launch_project_terminal(project, root, env, logfile):
    if not shutil.which("tmux"):
        raise RuntimeError("未安装 tmux。请先安装 tmux 后再启动项目。")
    name = terminal_session_name(project["id"])
    close_project_terminal(project["id"])
    shell = os.environ.get("SHELL", "/bin/zsh")
    # tmux server 会保留创建时的环境；不能只依赖 subprocess 的 env，
    # 否则已有 tmux server 可能仍用旧 Node.js 的 PATH。把运行环境写入 pane 命令，
    # 确保 pnpm/corepack 与项目所选的 Node 版本一致。
    runtime_keys = {"PATH", "VIRTUAL_ENV", "NVM_DIR", "NVM_BIN", "RELEASE_LITE_PROJECT_ID", *env_dict(project.get("env_vars", "")).keys()}
    exports = "".join(f"export {key}={shlex.quote(env[key])}; " for key in sorted(runtime_keys) if key in env)
    command = f"{exports}exec {project['start_command']}"
    subprocess.run(["tmux", "new-session", "-d", "-s", name, "-c", str(root), shell, "-lc", command], check=True, env=env)
    try:
        subprocess.run(["tmux", "pipe-pane", "-o", "-t", name, f"cat >> {shlex.quote(str(logfile))}"], check=True)
        for _ in range(10):
            result = subprocess.run(["tmux", "display-message", "-p", "-t", name, "#{pane_pid}"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
            if result.returncode == 0 and result.stdout.strip().isdigit():
                return name, int(result.stdout.strip())
            time.sleep(.05)
    except Exception:
        close_project_terminal(project["id"])
        raise
    close_project_terminal(project["id"])
    raise RuntimeError("项目终端未能启动，请查看运行日志")
def close_project_terminal(project_id):
    if not shutil.which("tmux"):
        return False
    name = terminal_session_name(project_id)
    result = subprocess.run(["tmux", "kill-session", "-t", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return result.returncode == 0
def tmux_session_exists(name):
    return shutil.which("tmux") and subprocess.run(["tmux", "has-session", "-t", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
def managed_tmux_sessions():
    if not shutil.which("tmux"):
        return []
    result = subprocess.run(
        ["tmux", "list-sessions", "-F", "#{session_name}\t#{session_created_string}\t#{session_windows}\t#{session_attached}"],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
    )
    sessions = []
    for line in result.stdout.splitlines():
        name, created_at, windows, attached = (line.split("\t") + ["", "", "", ""])[:4]
        if not name.startswith("release-lite-"):
            continue
        project_id = None
        if name.startswith("release-lite-project-"):
            try: project_id = int(name.rsplit("-", 1)[1])
            except ValueError: continue
        project = one("SELECT id,name,root_path FROM projects WHERE id=?", (project_id,)) if project_id else None
        sessions.append({
            "name": name, "created_at": created_at, "windows": int(windows or 0), "attached": bool(int(attached or 0)),
            "project_id": project_id, "project_name": project["name"] if project else None,
            "root_path": project["root_path"] if project else str(Path.home()),
        })
    return sessions

@app.get("/api/tmux/sessions")
def tmux_sessions_list():
    return jsonify(sessions=managed_tmux_sessions())

@app.delete("/api/tmux/sessions/<session_name>")
def tmux_session_delete(session_name):
    if not session_name.startswith("release-lite-"):
        abort(404)
    managed = {item["name"]: item for item in managed_tmux_sessions()}
    session = managed.get(session_name)
    if not session:
        abort(404)
    if session["project_id"]:
        stop_project(project_or_404(session["project_id"]), "tmux")
    else:
        subprocess.run(["tmux", "kill-session", "-t", session_name], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        audit(None, "关闭 Tmux 会话", session_name)
    return jsonify(ok=True)
def close_terminal_connection(sid):
    with terminal_sessions_guard:
        terminal = terminal_sessions.pop(sid, None)
    if not terminal: return
    try: os.close(terminal["master_fd"])
    except OSError: pass
    if terminal["process"].poll() is None:
        terminal["process"].terminate()
def terminal_reader(sid, master_fd, process):
    try:
        while process.poll() is None:
            try: data = os.read(master_fd, 4096)
            except OSError: break
            if not data: break
            socketio.emit("terminal_output", {"data": data.decode("utf-8", errors="replace")}, to=sid)
    finally:
        socketio.emit("terminal_closed", {}, to=sid)
        close_terminal_connection(sid)
@socketio.on("terminal_open")
def terminal_open(data):
    sid = request.sid
    close_terminal_connection(sid)
    try:
        project_id = int(data.get("project_id")) if data and data.get("project_id") else None
        if not project_id:
            raise RuntimeError("请从项目详情中打开终端")
        project = project_or_404(project_id)
        if not process_info(project)["running"]:
            raise RuntimeError("项目未运行，请先启动项目")
        session_name = terminal_session_name(project_id)
        if not tmux_session_exists(session_name):
            raise RuntimeError("项目终端会话不存在，请重启项目后重试")
        rows = max(1, int(data.get("rows", 24)))
        cols = max(1, int(data.get("cols", 80)))
        master_fd, slave_fd = pty.openpty()
        # 必须在 tmux attach 前设置初始 PTY 尺寸；否则 tmux 会把默认的 24 行
        # 客户端尺寸当成上限，导致浏览器只能缩小、无法放大终端窗口。
        size = struct.pack("HHHH", rows, cols, 0, 0)
        fcntl.ioctl(slave_fd, termios.TIOCSWINSZ, size)
        process = subprocess.Popen(["tmux", "attach-session", "-t", session_name], stdin=slave_fd, stdout=slave_fd, stderr=slave_fd, start_new_session=True, close_fds=True)
        os.close(slave_fd)
        with terminal_sessions_guard:
            terminal_sessions[sid] = {"master_fd": master_fd, "process": process, "session_name": session_name}
        socketio.start_background_task(terminal_reader, sid, master_fd, process)
        socketio.emit("terminal_ready", {"session": session_name}, to=sid)
    except Exception as exc:
        socketio.emit("terminal_error", {"message": str(exc)}, to=sid)
@socketio.on("terminal_input")
def terminal_input(data):
    with terminal_sessions_guard:
        terminal = terminal_sessions.get(request.sid)
    if terminal and data:
        try: os.write(terminal["master_fd"], data.get("data", "").encode())
        except OSError: pass
@socketio.on("terminal_resize")
def terminal_resize(data):
    with terminal_sessions_guard:
        terminal = terminal_sessions.get(request.sid)
    if terminal and data:
        try:
            rows, cols = int(data.get("rows", 24)), int(data.get("cols", 80))
            size = struct.pack("HHHH", rows, cols, 0, 0)
            fcntl.ioctl(terminal["master_fd"], termios.TIOCSWINSZ, size)
            # tmux attach 是独立的会话进程，ioctl 本身不会通知它重读 PTY 尺寸。
            os.killpg(terminal["process"].pid, signal.SIGWINCH)
            # 仅调整浏览器 PTY 时，tmux 可能继续沿用初始的 25 行窗口。
            # 显式调整会话窗口，确保前端输入的列数、行数真正生效。
            subprocess.run(["tmux", "resize-window", "-t", terminal["session_name"], "-x", str(cols), "-y", str(rows)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except (OSError, ValueError): pass
@socketio.on("disconnect")
def terminal_disconnect(): close_terminal_connection(request.sid)
def init():
    with closing(db()) as c:
        c.executescript(SCHEMA)
        columns = {row[1] for row in c.execute("PRAGMA table_info(projects)")}
        migrations = {
            "is_git": "ALTER TABLE projects ADD COLUMN is_git INTEGER NOT NULL DEFAULT 1",
            "runtime": "ALTER TABLE projects ADD COLUMN runtime TEXT NOT NULL DEFAULT 'python'",
            "python_executable": "ALTER TABLE projects ADD COLUMN python_executable TEXT DEFAULT 'python3'",
            "venv_path": "ALTER TABLE projects ADD COLUMN venv_path TEXT DEFAULT '.venv'",
            "requirements_file": "ALTER TABLE projects ADD COLUMN requirements_file TEXT DEFAULT 'requirements.txt'",
            "auto_install_dependencies": "ALTER TABLE projects ADD COLUMN auto_install_dependencies INTEGER NOT NULL DEFAULT 1",
            "node_version": "ALTER TABLE projects ADD COLUMN node_version TEXT DEFAULT ''",
        }
        for column, statement in migrations.items():
            if column not in columns: c.execute(statement)
        c.commit()
init()
if __name__ == "__main__":
    threading.Thread(target=monitor,daemon=True).start(); socketio.run(app, host="0.0.0.0", port=int(os.environ.get("PORT",22993)), debug=False)
