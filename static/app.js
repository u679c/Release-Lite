let projectList = [];
const $ = (s) => document.querySelector(s);
const bytes = (n) => (n == null ? "-" : (n / 1024 / 1024 / 1024).toFixed(1) + " GB");
async function api(url, opts = {}) {
  const r = await fetch(url, { headers: { "Content-Type": "application/json" }, ...opts });
  const j = await r.json();
  if (!r.ok) throw Error(j.error || "请求失败");
  return j;
}
function esc(s = "") {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function activatePage(page) {
  document.querySelectorAll(".page-view").forEach((x) => x.classList.toggle("active", x.id === page + "-page"));
  document.querySelectorAll("[data-page]").forEach((x) => x.classList.toggle("active", x.dataset.page === page));
  window.scrollTo({ top: 0, behavior: "smooth" });
}
function navigate(route) {
  const hash = "#/" + route;
  if (location.hash === hash) applyRoute();
  else location.hash = hash;
}
function showPage(page) {
  navigate(page);
}
async function applyRoute() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const page = parts[0] || "overview";
  if (page !== "detail") return activatePage(["overview", "projects", "operations"].includes(page) ? page : "overview");
  const id = parts[1];
  const tab = ["info", "config", "logs"].includes(parts[2]) ? parts[2] : "info";
  if (id === "new") return openEditor(null, true);
  if (!projectList.some((p) => p.id === Number(id))) await refresh();
  details(Number(id), tab, true);
}
function status(p) {
  return `<span class="status ${p.process?.running ? "running" : "stopped"}">${p.process?.running ? "运行中" : "已停止"}</span>`;
}
async function refresh() {
  try {
    const d = await api("/api/overview");
    projectList = d.projects;
    const s = d.system;
    $("#metrics").innerHTML = [
      ["CPU 使用率", s.cpu_percent + "%", s.cpu_count + " 核心"],
      ["内存使用", s.memory_percent + "%", bytes(s.memory_used) + " / " + bytes(s.memory_total)],
      ["磁盘使用", s.disk_percent + "%", bytes(s.disk_used) + " / " + bytes(s.disk_total)],
      ["网络流量", bytes(s.network.bytes_sent) + " ↑", bytes(s.network.bytes_recv) + " ↓"],
    ]
      .map((x) => `<div class="col-12 col-sm-6 col-xl-3"><div class="metric"><small>${x[0]}</small><b>${x[1]}</b><span class="metric-detail muted">${x[2]}</span></div></div>`)
      .join("");
    $("#systemInfo").innerHTML = [
      ["主机名称", s.hostname],
      ["操作系统", s.os],
      ["CPU 核心数", s.cpu_count + " 核"],
      ["磁盘容量", bytes(s.disk_total)],
    ]
      .map((x) => `<div><b>${esc(x[0])}</b><span>${esc(x[1])}</span></div>`)
      .join("");
    $("#projectSummary").innerHTML = d.projects.length
      ? d.projects.map((p) => `<div class="summary-item"><div><b>${esc(p.name)}</b><small>${p.is_git ? esc(p.branch) + " · " : ""}PID ${p.process.pid || "-"}</small></div>${status(p)}</div>`).join("")
      : '<span class="muted">还没有项目，前往项目管理页新建一个项目。</span>';
    $("#projects").innerHTML = d.projects.length ? d.projects.map(card).join("") : '<tr><td colspan="6" class="empty-row">还没有项目，点击右上角“新建项目”开始管理。</td></tr>';
    const ops = await api("/api/operations");
    $("#operations").innerHTML =
      ops
        .map(
          (x) =>
            `<div class="operation"><b>${esc(x.action)}</b> ${x.project_name ? "· " + esc(x.project_name) : ""}<span>${esc(x.details || "")}</span><small>${esc(x.created_at)}</small></div>`,
        )
        .join("") || '<span class="muted">暂无操作记录</span>';
  } catch (e) {
    console.error(e);
  }
}
function card(p) {
  const x = p.process;
  const startStop = x.running
    ? `<button class="icon-button stop-button" title="停止" onclick="act(${p.id},'stop')"><i class="bi bi-stop-circle"></i></button>`
    : `<button class="icon-button start-button" title="启动" onclick="act(${p.id},'start')"><i class="bi bi-play-circle"></i></button>`;
  return `<tr><td><div class="project-name">${esc(p.name)}</div><div class="project-path">${esc(p.root_path)}</div></td><td>${p.is_git ? esc(p.branch) : ""}</td><td>${status(p)}</td><td><div class="resource">PID ${x.pid || "-"}<br>CPU ${x.cpu || 0}% · ${bytes(x.memory)}</div></td><td>${x.ports.join(", ") || "-"}</td><td><div class="row-actions">${startStop}<button class="icon-button restart-button" title="重启" onclick="act(${p.id},'restart')"><i class="bi bi-arrow-clockwise"></i></button><button class="action-link" onclick="details(${p.id})">详情</button><button class="action-link delete-link" onclick="removeProject(${p.id})">删除</button></div></td></tr>`;
}
async function act(id, a) {
  try {
    const r = await api(`/api/projects/${id}/action/${a}`, { method: "POST" });
    if (r.deployment_id) alert("代码更新任务已开始，可在详情页查看日志。");
    await refresh();
    if ($("#detail-page").classList.contains("active") && a !== "deploy") details(id);
  } catch (e) {
    alert(e.message);
  }
}
async function details(id, tab = "info", fromRoute = false) {
  if (!fromRoute) return navigate(`detail/${id}/${tab}`);
  const p = projectList.find((x) => x.id === id);
  if (!p) return;
  const [run, dep] = await Promise.all([api(`/api/projects/${id}/logs/runtime`), api(`/api/projects/${id}/deployments`)]);
  renderDetail(p, tab, run.text, dep, false);
  activatePage("detail");
}
function openEditor(id, fromRoute = false) {
  if (!fromRoute) return navigate(id ? `detail/${id}/config` : "detail/new/config");
  if (id) return details(id, "config", true);
  renderDetail(
    {
      id: "",
      name: "",
      root_path: "",
      branch: "main",
      start_command: "",
      stop_command: "",
      pre_deploy_hook: "",
      post_deploy_hook: "",
      env_vars: "",
      git_webhook_secret: "",
      auto_deploy: 0,
      auto_restart: 0,
      is_git: 1,
      process: { running: false },
    },
    "config",
    "",
    [],
    true,
  );
  activatePage("detail");
}
function renderDetail(p, tab, runtime, deps, isNew) {
  const x = p.process || {};
  const history = p.is_git && deps.length
    ? deps
        .map(
          (d) =>
            `<div class="deploy"><b>${esc(d.action)} · ${esc(d.status)}</b> ${esc(d.revision || "-")} <small>${esc(d.started_at)}</small> ${d.status === "success" ? `<button onclick="rollback(${p.id},${d.id})">回退到此版本</button>` : ""}<br><span class="muted">${esc(d.message || "")}</span></div>`,
        )
        .join("")
    : '<p class="muted">暂无代码更新记录</p>';
  const runActions = !isNew ? `<div class="runtime-actions">${x.running ? `<button class="btn btn-outline-danger btn-sm" onclick="act(${p.id},'stop')"><i class="bi bi-stop-circle"></i> 停止</button>` : `<button class="btn btn-outline-success btn-sm" onclick="act(${p.id},'start')"><i class="bi bi-play-circle"></i> 启动</button>`}<button class="btn btn-outline-primary btn-sm" onclick="act(${p.id},'restart')"><i class="bi bi-arrow-clockwise"></i> 重启</button></div>` : "";
  const gitInfo = p.is_git ? `<div><small>Git 分支</small><b>${esc(p.branch || "main")}</b></div>` : "";
  const info = `${runActions}<div class="detail-overview"><div><small>项目名称</small><b>${esc(p.name || "未命名项目")}</b></div><div><small>运行状态</small>${status(p)}</div>${gitInfo}<div><small>项目目录</small><b class="mono">${esc(p.root_path || "-")}</b></div><div><small>运行进程</small><b>PID ${x.pid || "-"} · CPU ${x.cpu || 0}% · ${bytes(x.memory)}</b></div><div><small>监听端口</small><b>${x.ports?.join(", ") || "-"}</b></div></div>${p.is_git ? `<h3>代码更新历史</h3>${history}` : ""}`;
  const webhook = p.id ? `${location.origin}/webhook/${p.id}/${p.webhook_secret}` : "保存项目后自动生成";
  $("#details").innerHTML =
    `<div class="detail-topline"><div><b>${esc(p.name || "新建项目")}</b>${!isNew ? status(p) : ""}</div>${!isNew && p.is_git ? `<button class="btn btn-primary btn-sm" onclick="act(${p.id},'deploy')">更新代码</button>` : ""}</div><nav class="detail-tabs"><button class="detail-tab ${tab === "info" ? "active" : ""}" onclick="showDetailTab('info')">项目信息</button><button class="detail-tab ${tab === "config" ? "active" : ""}" onclick="showDetailTab('config')">项目配置</button><button class="detail-tab ${tab === "logs" ? "active" : ""}" onclick="showDetailTab('logs')">日志</button></nav><section class="detail-panel ${tab === "info" ? "active" : ""}" data-tab="info">${info}</section><section class="detail-panel ${tab === "config" ? "active" : ""}" data-tab="config">${configForm(p, isNew)}</section><section class="detail-panel ${tab === "logs" ? "active" : ""}" data-tab="logs">${p.is_git ? `<p class="muted">Webhook 地址（请妥善保管）</p><div class="log">${esc(webhook)}</div>` : ""}<div class="tabs"><button onclick="showLog('runtime')">运行日志</button>${p.is_git ? `<button onclick="showLog('deploy')">代码更新日志</button>` : ""}</div><pre class="log" id="log">${esc(runtime || "暂无运行日志")}</pre></section>`;
  setupGitMode(Boolean(p.is_git));
}
function setupGitMode(isGit) {
  const form = $("#projectForm");
  if (!form) return;
  const mode = document.createElement("label");
  mode.className = "check non-git-mode";
  mode.innerHTML = `<input id="non_git" type="checkbox" ${isGit ? "" : "checked"} onchange="toggleGitProject()"> 非 Git 项目`;
  form.insertBefore(mode, form.firstChild.nextSibling);
  ["branch", "pre_deploy_hook", "post_deploy_hook", "git_webhook_secret", "auto_deploy"].forEach((id) => {
    const field = $("#" + id);
    if (field) field.closest("label").classList.add("git-config-field");
  });
  toggleGitProject();
}
function toggleGitProject() {
  const nonGit = $("#non_git")?.checked;
  document.querySelectorAll(".git-config-field").forEach((field) => (field.hidden = nonGit));
}
function configForm(p, isNew) {
  const v = (k) => esc(p[k] || "");
  return `<form id="projectForm" class="config-form" onsubmit="saveProject(event)"><input id="id" type="hidden" value="${v("id")}"><div class="form-grid"><label>项目名称<input id="name" required value="${v("name")}"></label><label>Git 分支<input id="branch" value="${v("branch") || "main"}"></label></div><label>服务器项目目录（绝对路径）<input id="root_path" required placeholder="/srv/apps/example" value="${v("root_path")}"></label><label>启动命令 <span class="hint">在项目目录中执行</span><input id="start_command" required placeholder="bash start.sh 或 python3 app.py" value="${v("start_command")}"></label><div class="scripts"><button type="button" onclick="loadScripts()">发现目录脚本</button><select id="scriptSelect" onchange="useScript()"><option>可选：选择发现的脚本</option></select></div><label>停止命令（可选）<input id="stop_command" placeholder="例如：docker compose down" value="${v("stop_command")}"></label><div class="form-grid"><label>更新代码前钩子<textarea id="pre_deploy_hook" placeholder="例如：npm ci">${v("pre_deploy_hook")}</textarea></label><label>更新代码后钩子<textarea id="post_deploy_hook" placeholder="例如：npm run build">${v("post_deploy_hook")}</textarea></label></div><label>环境变量 <span class="hint">每行 KEY=value</span><textarea id="env_vars" placeholder="PORT=3000&#10;NODE_ENV=production">${v("env_vars")}</textarea></label><label>GitHub webhook 签名密钥（可选）<input id="git_webhook_secret" type="password" value="${v("git_webhook_secret")}"></label><div class="check-row"><label class="check"><input id="auto_deploy" type="checkbox" ${p.auto_deploy ? "checked" : ""}> 收到 webhook 后自动更新代码</label><label class="check"><input id="auto_restart" type="checkbox" ${p.auto_restart ? "checked" : ""}> 服务异常退出后自动重启</label></div><footer><button type="button" onclick="showPage('projects')">取消</button><button class="primary" type="submit">${isNew ? "创建项目" : "保存配置"}</button></footer></form>`;
}
function showDetailTab(tab) {
  const id = $("#id")?.value || "new";
  navigate(`detail/${id}/${tab}`);
}
async function loadScripts() {
  const root = $("#root_path").value;
  if (!root) return alert("请先填写项目目录");
  try {
    const list = await api("/api/discover-scripts", { method: "POST", body: JSON.stringify({ root_path: root }) });
    $("#scriptSelect").innerHTML = "<option>可选：选择发现的脚本</option>" + list.map((x) => `<option value="${esc(x)}">${esc(x)}</option>`).join("");
  } catch (e) {
    alert(e.message);
  }
}
function useScript() {
  if ($("#scriptSelect").value) $("#start_command").value = $("#scriptSelect").value;
}
async function saveProject(e) {
  e.preventDefault();
  const data = {};
  ["id", "name", "root_path", "branch", "start_command", "stop_command", "pre_deploy_hook", "post_deploy_hook", "env_vars", "git_webhook_secret"].forEach(
    (k) => (data[k] = $("#" + k).value),
  );
  data.auto_deploy = $("#auto_deploy").checked;
  data.auto_restart = $("#auto_restart").checked;
  data.non_git = $("#non_git").checked;
  try {
    const result = await api("/api/projects", { method: "POST", body: JSON.stringify(data) });
    await refresh();
    details(result.id);
  } catch (e) {
    alert(e.message);
  }
}
async function removeProject(id) {
  if (confirm("确定删除此项目的管理配置吗？项目文件不会删除。")) {
    await api("/api/projects/" + id, { method: "DELETE" });
    showPage("projects");
    refresh();
  }
}
async function showLog(kind) {
  const id = $("#id")?.value;
  if (!id) return;
  $("#log").textContent = (await api(`/api/projects/${id}/logs/${kind}`)).text;
}
async function rollback(pid, did) {
  if (confirm("确认回退并重新启动？")) {
    await api(`/api/projects/${pid}/rollback/${did}`, { method: "POST" });
    alert("回退任务已开始");
    details(pid);
  }
}
refresh().then(applyRoute);
window.addEventListener("hashchange", applyRoute);
setInterval(refresh, 10000);
