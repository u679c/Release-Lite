let projectList = [];
let serverInfo = {};
let tmuxSessions = [];
let terminal = null;
let terminalSocket = null;
let terminalFitAddon = null;
let terminalConnectionReady = false;
let terminalFontSize = Number(localStorage.getItem("release-lite-terminal-font-size")) || 17;
let terminalColumns = null;
let terminalRows = null;
const TERMINAL_MAX_COLUMNS = 500;
const TERMINAL_MAX_ROWS = 120;
const $ = (s) => document.querySelector(s);
const bytes = (n) => (n == null ? "-" : (n / 1024 / 1024 / 1024).toFixed(1) + " GB");
const fileSize = (n = 0) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
};
function toast(message, type = "info") {
  const item = document.createElement("div");
  item.className = "toast-message " + type;
  item.textContent = message;
  $("#toastContainer").appendChild(item);
  setTimeout(() => item.classList.add("visible"), 10);
  setTimeout(() => {
    item.classList.remove("visible");
    setTimeout(() => item.remove(), 180);
  }, 3000);
}
async function api(url, opts = {}) {
  const r = await fetch(url, { headers: { "Content-Type": "application/json" }, ...opts });
  const j = await r.json();
  if (!r.ok) throw Error(j.error || "请求失败");
  return j;
}
function esc(s = "") {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function parseSubprojectOptions(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((display) => {
      const [command, ...label] = display.split(/\s+/);
      return { command, display, label: label.join(" ") };
    });
}
function activatePage(page) {
  if (page !== "detail") closeTerminal();
  document.querySelectorAll(".page-view").forEach((x) => x.classList.toggle("active", x.id === page + "-page"));
  document.querySelectorAll("[data-page]").forEach((x) => x.classList.toggle("active", x.dataset.page === page));
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (page === "tmux") setTimeout(loadTmuxSessions, 0);
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
  if (page !== "detail") return activatePage(["overview", "projects", "operations", "tmux"].includes(page) ? page : "overview");
  const id = parts[1];
  const tab = ["info", "config", "logs", "terminal"].includes(parts[2]) ? parts[2] : "info";
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
    serverInfo = s;
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
      ? d.projects
          .map(
            (p) =>
              `<button type="button" class="summary-item" onclick="details(${p.id})" aria-label="查看项目 ${esc(p.name)} 详情"><span><b>${esc(p.name)}</b><small>${p.is_git ? esc(p.branch) + " · " : ""}PID ${p.process.pid || "-"}</small><small>内存 ${bytes(p.process.memory)}</small></span>${status(p)}</button>`,
          )
          .join("")
      : '<span class="muted">还没有项目，前往项目管理页新建一个项目。</span>';
    renderProjects();
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
function renderProjects() {
  const target = $("#projects");
  if (!target) return;
  const query = $("#projectNameFilter")?.value.trim().toLocaleLowerCase() || "";
  const runtime = $("#projectRuntimeFilter")?.value || "";
  const projects = projectList.filter((project) => {
    const matchesName =
      !query ||
      String(project.name || "")
        .toLocaleLowerCase()
        .includes(query);
    const matchesRuntime = !runtime || (project.runtime || "python") === runtime;
    return matchesName && matchesRuntime;
  });
  target.innerHTML = projects.length
    ? projects.map(card).join("")
    : `<tr><td colspan="6" class="empty-row">${projectList.length ? "没有符合筛选条件的项目" : "还没有项目，点击右上角“新建项目”开始管理。"}</td></tr>`;
}
function filterProjects() {
  renderProjects();
}
async function loadTmuxSessions() {
  const target = $("#tmuxSessions");
  if (!target) return;
  try {
    const result = await api("/api/tmux/sessions");
    tmuxSessions = result.sessions;
    target.innerHTML = tmuxSessions.length
      ? tmuxSessions
          .map(
            (session) =>
              `<article class="tmux-card"><div class="tmux-card-head"><div><b>${esc(session.project_name || "全局 Shell")}</b><small>${esc(session.name)}</small></div><span class="status running">${session.attached ? "已连接" : "后台运行"}</span></div><div class="tmux-meta"><span><i class="bi bi-grid-1x2"></i> ${session.windows} 个窗口</span><span><i class="bi bi-folder2-open"></i> ${esc(session.root_path || "用户主目录")}</span><span><i class="bi bi-clock"></i> ${esc(session.created_at || "-")}</span></div><div class="tmux-actions">${session.project_id ? `<button class="btn btn-outline-primary btn-sm" onclick="navigate('detail/${session.project_id}/terminal')"><i class="bi bi-terminal"></i> 打开终端</button>` : ""}<button class="icon-button danger" title="关闭会话" aria-label="关闭会话" onclick="closeTmuxSession('${esc(session.name)}')"><i class="bi bi-trash3"></i></button></div></article>`,
          )
          .join("")
      : '<section class="content-card tmux-empty"><i class="bi bi-terminal"></i><p>暂无项目终端会话</p><small>在项目详情的「终端」Tab 打开一个终端后，会话会显示在这里。</small></section>';
  } catch (e) {
    target.innerHTML = `<section class="content-card tmux-empty text-danger">${esc(e.message)}</section>`;
  }
}
async function closeTmuxSession(name) {
  if (!confirm(`确认关闭终端会话「${name}」吗？会话中的运行命令也会停止。`)) return;
  try {
    await api(`/api/tmux/sessions/${encodeURIComponent(name)}`, { method: "DELETE" });
    toast("终端会话已关闭");
    await loadTmuxSessions();
  } catch (e) {
    toast(e.message, "error");
  }
}
function setupProjectTerminal(projectId) {
  if (!terminal) openTerminal(projectId);
}
function closeTerminal() {
  if (terminalSocket) terminalSocket.disconnect();
  terminalSocket = null;
  terminalConnectionReady = false;
  if (terminal) terminal.dispose();
  terminal = null;
  terminalFitAddon = null;
}
function terminalCellSize() {
  const dimensions = terminal?._core?._renderService?.dimensions?.css?.cell;
  return {
    width: dimensions?.width || terminalFontSize * 0.6,
    height: dimensions?.height || terminalFontSize * 1.2,
  };
}
function syncTerminalPanelHeight() {
  const card = $(".terminal-card");
  if (!card) return;
  if (!terminalRows) {
    card.style.removeProperty("height");
    card.style.removeProperty("min-height");
    return;
  }
  const { height: cellHeight } = terminalCellSize();
  // 让可见区域与设置的行数一致；28px 是终端卡片上下内边距。
  card.style.height = `${Math.ceil(terminalRows * cellHeight) + 28}px`;
  card.style.minHeight = "0";
}
function resizeTerminal() {
  const screen = $("#terminalScreen");
  if (!terminal || !screen) return;
  syncTerminalPanelHeight();
  if (!terminalColumns && !terminalRows && terminalFitAddon) {
    terminalFitAddon.fit();
    if (terminalSocket?.connected && terminalConnectionReady) terminalSocket.emit("terminal_resize", { cols: terminal.cols, rows: terminal.rows });
    updateTerminalControls();
    return;
  }
  const { width: cellWidth, height: cellHeight } = terminalCellSize();
  const cols = terminalColumns || Math.max(1, Math.floor(screen.clientWidth / cellWidth));
  const rows = terminalRows || Math.max(1, Math.floor(screen.clientHeight / cellHeight));
  terminal.resize(cols, rows);
  if (terminalSocket?.connected && terminalConnectionReady) terminalSocket.emit("terminal_resize", { cols, rows });
  updateTerminalControls();
}
function updateTerminalControls() {
  const font = $("#terminalFontSize");
  const columns = $("#terminalColumns");
  const rows = $("#terminalRows");
  if (font) font.value = terminalFontSize;
  if (columns && terminal) columns.value = terminal.cols;
  if (rows && terminal) rows.value = terminal.rows;
}
function setTerminalFont(value) {
  const size = Number(value);
  if (!Number.isFinite(size) || size <= 0) return updateTerminalControls();
  terminalFontSize = size;
  localStorage.setItem("release-lite-terminal-font-size", terminalFontSize);
  if (terminal) terminal.options.fontSize = terminalFontSize;
  setTimeout(resizeTerminal, 0);
}
function adjustTerminalFont(delta) {
  setTerminalFont(terminalFontSize + delta);
}
function adjustTerminalWindow(columnsDelta, rowsDelta) {
  const screen = $("#terminalScreen");
  if (!terminal || !screen) return;
  terminalColumns = Math.min(TERMINAL_MAX_COLUMNS, Math.max(1, (terminalColumns || terminal.cols || Math.floor(screen.clientWidth / 9)) + columnsDelta));
  terminalRows = Math.min(TERMINAL_MAX_ROWS, Math.max(1, (terminalRows || terminal.rows || Math.floor(screen.clientHeight / 18)) + rowsDelta));
  resizeTerminal();
}
function setTerminalWindow() {
  const columns = Number($("#terminalColumns")?.value);
  const rows = Number($("#terminalRows")?.value);
  if (!Number.isFinite(columns) || columns <= 0 || !Number.isFinite(rows) || rows <= 0) return updateTerminalControls();
  terminalColumns = Math.min(TERMINAL_MAX_COLUMNS, Math.floor(columns));
  terminalRows = Math.min(TERMINAL_MAX_ROWS, Math.floor(rows));
  if (columns > TERMINAL_MAX_COLUMNS || rows > TERMINAL_MAX_ROWS) toast(`终端最大支持 ${TERMINAL_MAX_COLUMNS} 列 × ${TERMINAL_MAX_ROWS} 行`, "info");
  resizeTerminal();
}
function resetTerminalWindow() {
  terminalColumns = null;
  terminalRows = null;
  resizeTerminal();
}
function openTerminal(projectId) {
  const screen = $("#terminalScreen");
  if (!screen) return;
  const missing = [];
  if (typeof Terminal === "undefined") missing.push("xterm 本地静态资源");
  if (typeof io === "undefined") missing.push("Socket.IO 后端服务");
  if (missing.length) return toast(`终端不可用：未加载${missing.join("、")}。请重启 Release Lite 服务后重试。`, "error");
  closeTerminal();
  screen.innerHTML = "";
  terminal = new Terminal({
    cursorBlink: true,
    scrollback: 10000,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    fontSize: terminalFontSize,
    lineHeight: 1.2,
    theme: { background: "#101828", foreground: "#d0d5dd", cursor: "#f2f4f7" },
  });
  if (typeof FitAddon !== "undefined") {
    terminalFitAddon = new FitAddon.FitAddon();
    terminal.loadAddon(terminalFitAddon);
  }
  terminal.open(screen);
  screen.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      event.stopPropagation();
    },
    { passive: false, capture: true },
  );
  terminal.write("\x1b[36m正在连接 tmux 交互会话…\x1b[0m\r\n");
  terminalSocket = io();
  terminalSocket.on("connect", () => {
    terminalConnectionReady = false;
    resizeTerminal();
    terminalSocket.emit("terminal_open", { project_id: projectId, cols: terminal.cols, rows: terminal.rows });
  });
  terminalSocket.on("terminal_ready", (data) => {
    terminalConnectionReady = true;
    terminal.write(`\x1b[32m已连接会话：${data.session}\x1b[0m\r\n`);
  });
  terminalSocket.on("terminal_output", (data) => terminal.write(data.data));
  terminalSocket.on("terminal_error", (data) => {
    terminal.write(`\r\n\x1b[31m${data.message}\x1b[0m\r\n`);
    toast(data.message, "error");
  });
  terminalSocket.on("terminal_closed", () => terminal.write("\r\n\x1b[33m终端连接已关闭；tmux 会话仍在后台保留。\x1b[0m\r\n"));
  terminal.onData((data) => terminalSocket?.emit("terminal_input", { data }));
  terminal.onResize(({ cols, rows }) => {
    if (terminalSocket?.connected && terminalConnectionReady) terminalSocket.emit("terminal_resize", { cols, rows });
  });
  setTimeout(resizeTerminal, 50);
}
async function act(id, a) {
  try {
    const subproject = $("#subprojectSelect")?.value || "";
    const r = await api(`/api/projects/${id}/action/${a}`, { method: "POST", body: JSON.stringify({ subproject }) });
    if (r.deployment_id) toast("代码更新任务已开始，可在详情页查看日志。");
    if (r.dependency_update) toast("更新依赖任务已开始，可在运行日志中查看结果。");
    await refresh();
    if ($("#detail-page").classList.contains("active") && a !== "deploy") details(id);
    if (["start", "restart"].includes(a)) {
      setTimeout(async () => {
        await refresh();
        if ($("#detail-page").classList.contains("active")) details(id, "info", true);
      }, 1200);
    }
  } catch (e) {
    toast(e.message, "error");
  }
}
async function details(id, tab = "info", fromRoute = false) {
  if (!fromRoute) return navigate(`detail/${id}/${tab}`);
  const p = projectList.find((x) => x.id === id);
  if (!p) return;
  const [run, dep, summary] = await Promise.all([api(`/api/projects/${id}/logs/runtime`), api(`/api/projects/${id}/deployments`), api(`/api/projects/${id}/logs/summary`)]);
  renderDetail(p, tab, run.text, dep, summary, false);
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
      runtime: "generic",
      python_executable: "python3",
      venv_path: ".venv",
      requirements_file: "requirements.txt",
      auto_install_dependencies: 1,
      node_version: "",
      node_dependency_command: "",
      subprojects_enabled: 0,
      subprojects: "",
      process: { running: false },
    },
    "config",
    "",
    [],
    { runtime_size: 0, deploy_size: 0 },
    true,
  );
  activatePage("detail");
}
function renderDetail(p, tab, runtime, deps, logSummary, isNew) {
  closeTerminal();
  const x = p.process || {};
  if (tab === "terminal" && !x.running) tab = "info";
  const history =
    p.is_git && deps.length
      ? deps
          .map(
            (d) =>
              `<div class="deploy"><b>${esc(d.action)} · ${esc(d.status)}</b> ${esc(d.revision || "-")} <small>${esc(d.started_at)}</small> ${d.status === "success" ? `<button onclick="rollback(${p.id},${d.id})">回退到此版本</button>` : ""}<br><span class="muted">${esc(d.message || "")}</span></div>`,
          )
          .join("")
      : '<p class="muted">暂无代码更新记录</p>';
  const subprojectOptions = parseSubprojectOptions(p.subprojects);
  const hasSubprojects = Boolean(p.subprojects_enabled);
  const selectedSubproject = subprojectOptions.find((item) => item.command === x.subproject);
  const subprojectControl = hasSubprojects
    ? `<select id="subprojectSelect" class="form-select subproject-picker" aria-label="选择子项目">${subprojectOptions.map((item) => `<option value="${esc(item.command)}" ${item.command === x.subproject ? "selected" : ""}>${esc(item.display)}</option>`).join("")}</select>`
    : "";
  const actionSize = hasSubprojects ? "" : " btn-sm";
  const updateDependencies = p.runtime === "node" && String(p.node_dependency_command || "").trim()
    ? `<button class="btn btn-outline-secondary${actionSize}" onclick="act(${p.id},'update-dependencies')">更新依赖</button>`
    : "";
  const runActions = !isNew
    ? `<div class="runtime-actions"><div class="runtime-actions-left ${hasSubprojects ? "has-subprojects" : ""}">${subprojectControl}${x.running ? `<button class="btn btn-outline-danger${actionSize}" onclick="act(${p.id},'stop')"><i class="bi bi-stop-circle"></i> 停止</button>` : `<button class="btn btn-outline-success${actionSize}" onclick="act(${p.id},'start')"><i class="bi bi-play-circle"></i> 启动</button>`}<button class="btn btn-outline-primary${actionSize}" onclick="act(${p.id},'restart')"><i class="bi bi-arrow-clockwise"></i> 重启</button>${updateDependencies}</div></div>`
    : "";
  const gitInfo = p.is_git ? `<div><small>Git 分支</small><b>${esc(p.branch || "main")}</b></div>` : "";
  const subprojectInfo = hasSubprojects ? `<div><small>当前子项目</small><b>${esc(selectedSubproject?.display || x.subproject || "-")}</b></div>` : "";
  const info = `${runActions}<div class="detail-overview"><div><small>项目名称</small><b>${esc(p.name || "未命名项目")}</b></div><div><small>运行状态</small>${status(p)}</div>${subprojectInfo}<div><small>运行环境</small><b>${runtimeLabel(p.runtime, p.node_version)}</b></div>${gitInfo}<div><small>项目目录</small><b class="mono">${esc(p.root_path || "-")}</b></div><div><small>运行进程</small><b>PID ${x.pid || "-"} · CPU ${x.cpu || 0}% · ${bytes(x.memory)}</b></div><div><small>监听端口</small><b>${x.ports?.join(", ") || "-"}</b></div><div class="service-addresses"><small>服务地址</small>${accessLinks(x.ports || [])}</div></div>${p.is_git ? `<h3>代码更新历史</h3>${history}` : ""}`;
  const webhook = p.id ? `${location.origin}/webhook/${p.id}/${p.webhook_secret}` : "保存项目后自动生成";
  const logs = `${p.is_git ? `<p class="muted">Webhook 地址（请妥善保管）</p><div class="log">${esc(webhook)}</div>` : ""}<div class="log-toolbar"><span id="activeLogMeta">运行日志 · ${fileSize(logSummary.runtime_size)}</span><button id="clearLogButton" class="icon-button danger" title="清空运行日志" aria-label="清空运行日志" onclick="clearLog('runtime')"><i class="bi bi-trash3"></i></button></div><div class="tabs"><button onclick="showLog('runtime', ${logSummary.runtime_size})">运行日志</button>${p.is_git ? `<button onclick="showLog('deploy', ${logSummary.deploy_size})">代码更新日志</button>` : ""}</div><pre class="log" id="log">${esc(runtime || "暂无运行日志")}</pre>`;
  const terminal =
    !isNew && x.running
      ? `<div class="terminal-toolbar"><span class="muted">tmux 分屏：<code>Ctrl-b</code> 后按 <code>%</code>（纵向）或 <code>"</code>（横向）</span><div class="terminal-display-controls"><span>字号</span><button class="icon-button" title="缩小字号" onclick="adjustTerminalFont(-1)"><i class="bi bi-dash-lg"></i></button><input id="terminalFontSize" class="terminal-number-input" type="number" min="1" value="${terminalFontSize}" onchange="setTerminalFont(this.value)"><button class="icon-button" title="放大字号" onclick="adjustTerminalFont(1)"><i class="bi bi-plus-lg"></i></button><span class="terminal-control-divider"></span><span>终端尺寸</span><button class="icon-button" title="缩窄窗口" onclick="adjustTerminalWindow(-10,0)"><i class="bi bi-arrows-collapse-horizontal"></i></button><input id="terminalColumns" class="terminal-number-input terminal-dimension-input" type="number" min="1" max="${TERMINAL_MAX_COLUMNS}" placeholder="列" onchange="setTerminalWindow()"><span>×</span><input id="terminalRows" class="terminal-number-input terminal-dimension-input" type="number" min="1" max="${TERMINAL_MAX_ROWS}" placeholder="行" onchange="setTerminalWindow()"><button class="icon-button" title="加宽窗口" onclick="adjustTerminalWindow(10,0)"><i class="bi bi-arrows-expand-horizontal"></i></button><button class="icon-button" title="降低窗口" onclick="adjustTerminalWindow(0,-5)"><i class="bi bi-arrows-collapse-vertical"></i></button><button class="icon-button" title="加高窗口" onclick="adjustTerminalWindow(0,5)"><i class="bi bi-arrows-expand-vertical"></i></button><button class="action-link terminal-auto-size" onclick="resetTerminalWindow()">填满面板</button></div></div><section class="terminal-card"><div id="terminalScreen"></div></section>`
      : "";
  const topStartStop = !isNew
    ? x.running
      ? `<button class="icon-button stop-button" title="停止" aria-label="停止" onclick="act(${p.id},'stop')"><i class="bi bi-stop-circle"></i></button>`
      : `<button class="icon-button start-button" title="启动" aria-label="启动" onclick="act(${p.id},'start')"><i class="bi bi-play-circle"></i></button>`
    : "";
  const topRefresh = !isNew
    ? `<button class="btn btn-outline-secondary btn-sm" onclick="refreshProjectDetail(${p.id})">刷新</button>`
    : "";
  const topDeploy = !isNew && p.is_git ? `<button class="btn btn-primary btn-sm" onclick="act(${p.id},'deploy')">更新代码</button>` : "";
  $("#details").innerHTML =
    `<div class="detail-topline"><div><b>${esc(p.name || "新建项目")}</b>${!isNew ? status(p) : ""}</div>${!isNew ? `<div class="detail-topline-actions">${topStartStop}${topRefresh}${topDeploy}</div>` : ""}</div><nav class="detail-tabs"><button class="detail-tab ${tab === "info" ? "active" : ""}" onclick="showDetailTab('info')">项目信息</button><button class="detail-tab ${tab === "config" ? "active" : ""}" onclick="showDetailTab('config')">项目配置</button><button class="detail-tab ${tab === "logs" ? "active" : ""}" onclick="showDetailTab('logs')">日志</button>${!isNew && x.running ? `<button class="detail-tab ${tab === "terminal" ? "active" : ""}" onclick="showDetailTab('terminal')">终端</button>` : ""}</nav><section class="detail-panel ${tab === "info" ? "active" : ""}" data-tab="info">${info}</section><section class="detail-panel ${tab === "config" ? "active" : ""}" data-tab="config">${configForm(p, isNew)}</section><section class="detail-panel ${tab === "logs" ? "active" : ""}" data-tab="logs">${logs}</section>${!isNew && x.running ? `<section class="detail-panel ${tab === "terminal" ? "active" : ""}" data-tab="terminal">${terminal}</section>` : ""}`;
  setupProjectOptions(p);
  if (!isNew && x.running && tab === "terminal") setTimeout(() => setupProjectTerminal(p.id), 0);
}
function accessLinks(ports) {
  if (!ports.length) return '<span class="muted">未检测到监听端口</span>';
  return ports
    .map(
      (port) =>
        `<div class="access-links"><a href="http://localhost:${port}" target="_blank" rel="noreferrer">localhost:${port}</a><a href="http://${esc(serverInfo.local_ip || "127.0.0.1")}:${port}" target="_blank" rel="noreferrer">${esc(serverInfo.local_ip || "127.0.0.1")}:${port}</a></div>`,
    )
    .join("");
}
function setupProjectOptions(project) {
  const isGit = Boolean(project.is_git);
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
  const rootLabel = $("#root_path")?.closest("label");
  if (rootLabel && !$("#directoryBrowseButton")) {
    const button = document.createElement("button");
    button.id = "directoryBrowseButton";
    button.type = "button";
    button.className = "btn btn-outline-secondary btn-sm directory-browse-button";
    button.innerHTML = '<i class="bi bi-folder2-open"></i> 选择服务器目录';
    button.onclick = () => browseDirectories($("#root_path")?.value.trim() || "");
    rootLabel.insertAdjacentElement("afterend", button);
  }
  if (rootLabel && !$("#runtimeConfig")) {
    const runtime = document.createElement("section");
    runtime.id = "runtimeConfig";
    runtime.className = "runtime-config";
    runtime.innerHTML = `<div class="runtime-config-grid"><label>运行环境<select id="runtime" onchange="toggleRuntimeConfig()"><option value="python" ${project.runtime === "python" ? "selected" : ""}>Python</option><option value="node" ${project.runtime === "node" ? "selected" : ""}>Node.js</option><option value="generic" ${project.runtime === "generic" ? "selected" : ""}>通用命令行</option></select></label><div id="nodeRuntimeFields"><label>Node.js 版本<select id="node_version"><option value="">正在读取 NVM 已安装版本…</option></select></label><label>更新依赖命令<input id="node_dependency_command" value="${esc(project.node_dependency_command || "")}" placeholder="例如：pnpm install --frozen-lockfile"></label><span class="hint">选择的 Node.js 版本会用于执行此命令。</span></div><div id="pythonRuntimeFields"><label>Python 命令<input id="python_executable" value="${esc(project.python_executable || "python3")}" placeholder="python3"></label><label>虚拟环境目录<input id="venv_path" value="${esc(project.venv_path || ".venv")}" placeholder=".venv"><span class="hint">相对项目目录</span></label><label>pip 依赖文件<input id="requirements_file" value="${esc(project.requirements_file || "requirements.txt")}" placeholder="requirements.txt"><span class="hint">相对项目目录</span></label><label class="check"><input id="auto_install_dependencies" type="checkbox" ${project.auto_install_dependencies ? "checked" : ""}> 更新代码时自动安装 pip 依赖</label></div><p id="genericRuntimeHint" class="hint">直接执行启动命令，适用于 Docker、Java、Go、Shell 等任意运行方式。</p></div>`;
    $("#directoryBrowseButton").insertAdjacentElement("afterend", runtime);
  }
  loadNodeVersions(project.node_version || "");
  toggleRuntimeConfig();
  toggleSubprojectsConfig();
  toggleGitProject();
}
function toggleRuntimeConfig() {
  const runtime = $("#runtime")?.value || "python";
  $("#pythonRuntimeFields").hidden = runtime !== "python";
  $("#nodeRuntimeFields").hidden = runtime !== "node";
  $("#genericRuntimeHint").hidden = runtime !== "generic";
}
function toggleSubprojectsConfig() {
  const enabled = $("#subprojects_enabled")?.checked;
  const field = $("#subprojectsField");
  const input = $("#subprojects");
  const scriptsDiscovery = $("#scriptsDiscovery");
  if (field) field.hidden = !enabled;
  if (input) input.required = enabled;
  if (scriptsDiscovery) scriptsDiscovery.hidden = enabled;
}
async function loadNodeVersions(selectedVersion) {
  const select = $("#node_version");
  if (!select) return;
  try {
    const data = await api("/api/node-versions");
    const options = data.versions.length
      ? data.versions.map((version) => `<option value="${esc(version)}" ${version === selectedVersion ? "selected" : ""}>${esc(version)}</option>`).join("")
      : "";
    select.innerHTML = `<option value="">不指定（使用系统 PATH）</option>${options}`;
    if (!data.versions.length) toast("未在 NVM 目录中找到已安装的 Node.js 版本", "error");
  } catch (e) {
    select.innerHTML = '<option value="">无法读取 NVM 版本</option>';
    toast(e.message, "error");
  }
}
function runtimeLabel(runtime, nodeVersion = "") {
  if (runtime === "node") return `Node.js${nodeVersion ? " " + esc(nodeVersion) : "（系统 PATH）"}`;
  return { python: "Python", generic: "通用命令行" }[runtime] || "Python";
}
function toggleGitProject() {
  const nonGit = $("#non_git")?.checked;
  document.querySelectorAll(".git-config-field").forEach((field) => (field.hidden = nonGit));
}
async function browseDirectories(path = "") {
  const picker = $("#directoryPicker");
  const dialog = $("#directoryDialog");
  if (!dialog.open) dialog.showModal();
  try {
    const data = await api("/api/directories" + (path ? "?path=" + encodeURIComponent(path) : ""));
    const rootButtons = data.roots.map((root) => `<button type="button" class="directory-root" onclick="browseDirectories('${esc(root)}')">${esc(root)}</button>`).join("");
    const addressInput = (value = "") =>
      `<input id="directoryPathInput" class="directory-path-input" type="text" value="${esc(value)}" data-path="${esc(value)}" placeholder="输入服务器目录" aria-label="服务器目录" onblur="browseDirectoryFromInput()" onkeydown="if (event.key === 'Enter') this.blur()">`;
    if (!data.path) {
      picker.innerHTML = `<div class="directory-picker-title">选择允许浏览的根目录</div><div class="directory-roots">${rootButtons}</div>`;
      return;
    }
    const parent = data.parent ? `<button type="button" class="directory-nav" onclick="browseDirectories('${esc(data.parent)}')">..</button>` : "";
    const folders = data.directories.length
      ? data.directories
          .map((item) => `<button type="button" class="directory-item" onclick="browseDirectories('${esc(item.path)}')"><i class="bi bi-folder"></i> ${esc(item.name)}</button>`)
          .join("")
      : '<span class="muted">当前目录没有可浏览的子目录</span>';
    picker.innerHTML = `<div class="directory-picker-head">${addressInput(data.path)}<button type="button" class="btn btn-primary btn-sm" onclick="selectDirectory('${esc(data.path)}')">使用此目录</button></div><div class="directory-nav-row">${parent}${rootButtons}</div><div class="directory-list">${folders}</div>`;
  } catch (e) {
    picker.innerHTML = `<input id="directoryPathInput" class="directory-path-input" type="text" value="${esc(path)}" data-path="${esc(path)}" placeholder="输入服务器目录" aria-label="服务器目录" onblur="browseDirectoryFromInput()" onkeydown="if (event.key === 'Enter') this.blur()"><span class="text-danger">${esc(e.message)}</span>`;
    toast(e.message, "error");
  }
}
function browseDirectoryFromInput() {
  const input = $("#directoryPathInput");
  if (!input || input.value.trim() === input.dataset.path) return;
  browseDirectories(input.value.trim());
}
function selectDirectory(path) {
  $("#root_path").value = path;
  $("#directoryDialog").close();
  toast("已选择项目目录");
}
function configForm(p, isNew) {
  const v = (k) => esc(p[k] || "");
  const subprojectsConfig = `<label class="check"><input id="subprojects_enabled" type="checkbox" ${p.subprojects_enabled ? "checked" : ""} onchange="toggleSubprojectsConfig()"> 启用子项目</label><label id="subprojectsField">子项目配置 <span class="hint">每行填写“命令 label”；label 可省略，启动命令可使用 {{project}}</span><textarea id="subprojects" placeholder="kp 知识包后台&#10;bs 书架&#10;ss">${v("subprojects")}</textarea></label>`;
  const advancedConfig = `<details class="advanced-config"><summary>高级配置</summary><div class="advanced-config-content"><label>停止命令（可选）<input id="stop_command" placeholder="例如：docker compose down" value="${v("stop_command")}"></label><div class="form-grid"><label>更新代码前钩子<textarea id="pre_deploy_hook" placeholder="例如：npm ci">${v("pre_deploy_hook")}</textarea></label><label>更新代码后钩子<textarea id="post_deploy_hook" placeholder="例如：npm run build">${v("post_deploy_hook")}</textarea></label></div><label>环境变量 <span class="hint">每行 KEY=value</span><textarea id="env_vars" placeholder="PORT=3000&#10;NODE_ENV=production">${v("env_vars")}</textarea></label><label>GitHub webhook 签名密钥（可选）<input id="git_webhook_secret" type="password" value="${v("git_webhook_secret")}"></label><label class="check"><input id="auto_deploy" type="checkbox" ${p.auto_deploy ? "checked" : ""}> 收到 webhook 后自动更新代码</label></div></details>`;
  const autoRestartConfig = `<div class="check-row"><label class="check"><input id="auto_restart" type="checkbox" ${p.auto_restart ? "checked" : ""}> 服务异常退出后自动重启</label></div>`;
  return `<form id="projectForm" class="config-form" onsubmit="saveProject(event)"><input id="id" type="hidden" value="${v("id")}"><div class="form-grid"><label>项目名称<input id="name" required value="${v("name")}"></label><label>Git 分支<input id="branch" value="${v("branch") || "main"}"></label></div><label>服务器项目目录（绝对路径）<input id="root_path" required placeholder="/srv/apps/example" value="${v("root_path")}"></label><label>启动命令 <span class="hint">在项目目录中执行；子项目可用 {{project}}</span><input id="start_command" required placeholder="例如：pnpm --filter {{project}} start" value="${v("start_command")}"></label><div id="scriptsDiscovery" class="scripts"><button type="button" style="width:200px;" onclick="loadScripts()">发现目录脚本</button><select id="scriptSelect" onchange="useScript()"><option>可选：选择发现的脚本</option></select></div>${subprojectsConfig}${advancedConfig}${autoRestartConfig}<footer><button type="button" onclick="showPage('projects')">取消</button><button class="primary" type="submit">${isNew ? "创建项目" : "保存配置"}</button></footer></form>`;
}
function showDetailTab(tab) {
  const id = $("#id")?.value || "new";
  navigate(`detail/${id}/${tab}`);
}
async function refreshProjectDetail(id) {
  await refresh();
  await details(id, "info", true);
  toast("项目信息已刷新");
}
async function loadScripts() {
  const root = $("#root_path").value;
  if (!root) return toast("请先填写项目目录", "error");
  try {
    const list = await api("/api/discover-scripts", { method: "POST", body: JSON.stringify({ root_path: root }) });
    $("#scriptSelect").innerHTML = "<option>可选：选择发现的脚本</option>" + list.map((x) => `<option value="${esc(x)}">${esc(x)}</option>`).join("");
  } catch (e) {
    toast(e.message, "error");
  }
}
function useScript() {
  if ($("#scriptSelect").value) $("#start_command").value = $("#scriptSelect").value;
}
async function saveProject(e) {
  e.preventDefault();
  const data = {};
  [
    "id",
    "name",
    "root_path",
    "branch",
    "start_command",
    "stop_command",
    "pre_deploy_hook",
    "post_deploy_hook",
    "env_vars",
    "git_webhook_secret",
    "runtime",
    "python_executable",
    "venv_path",
    "requirements_file",
    "node_version",
    "node_dependency_command",
    "subprojects",
  ].forEach((k) => (data[k] = $("#" + k).value));
  data.auto_deploy = $("#auto_deploy").checked;
  data.auto_restart = $("#auto_restart").checked;
  data.subprojects_enabled = $("#subprojects_enabled").checked;
  data.non_git = $("#non_git").checked;
  data.auto_install_dependencies = $("#auto_install_dependencies").checked;
  try {
    const result = await api("/api/projects", { method: "POST", body: JSON.stringify(data) });
    await refresh();
    details(result.id);
  } catch (e) {
    toast(e.message, "error");
  }
}
async function removeProject(id) {
  if (confirm("确定删除此项目的管理配置吗？项目文件不会删除。")) {
    await api("/api/projects/" + id, { method: "DELETE" });
    showPage("projects");
    refresh();
  }
}
async function showLog(kind, size = 0) {
  const id = $("#id")?.value;
  if (!id) return;
  $("#log").textContent = (await api(`/api/projects/${id}/logs/${kind}`)).text;
  const label = kind === "deploy" ? "代码更新日志" : "运行日志";
  $("#activeLogMeta").textContent = `${label} · ${fileSize(size)}`;
  const clear = $("#clearLogButton");
  clear.title = `清空${label}`;
  clear.setAttribute("aria-label", `清空${label}`);
  clear.setAttribute("onclick", `clearLog('${kind}')`);
}
async function clearLog(kind) {
  const id = $("#id")?.value;
  if (!id) return;
  const label = kind === "deploy" ? "代码更新日志" : "运行日志";
  if (!confirm(`确认清空${label}吗？此操作不可恢复。`)) return;
  try {
    await api(`/api/projects/${id}/logs/${kind}/clear`, { method: "POST" });
    toast(`${label}已清空`);
    await details(Number(id), "logs", true);
  } catch (e) {
    toast(e.message, "error");
  }
}
async function rollback(pid, did) {
  if (confirm("确认回退并重新启动？")) {
    await api(`/api/projects/${pid}/rollback/${did}`, { method: "POST" });
    toast("代码回退任务已开始");
    details(pid);
  }
}
refresh().then(applyRoute);
window.addEventListener("hashchange", applyRoute);
window.addEventListener("resize", resizeTerminal);
setInterval(refresh, 10000);
