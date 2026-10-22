/* Issue workspace; the host calls IssueManagement.open(kind, parameters). */
window.IssueManagement = (() => {
  const root = document.querySelector("#issues-page");
  const find = (selector) => root.querySelector(selector);
  const form = find("#issueFilters");
  const escape = ReleaseLite.escapeHtml;
  const labels = { overview: "需求与bug管理", requirements: "需求管理", bugs: "bug管理" };
  const autoSyncControl = find("#issueAutoSync");
  const autoSyncInterval = 60 * 1000;
  const autoSyncSettings = { overview: false, requirements: false, bugs: false };
  let autoSyncTimer = null,
    syncRequestPending = false;
  let kind = "overview",
    filters = {},
    page = 1,
    data = null,
    sequence = 0,
    poll = null,
    searchTimer = null;
  let requirementProjects = [],
    activeRequirementProject = "";
  let conditionFilter = { logic: "and", rules: [] };
  let preferenceQueue = Promise.resolve(),
    searchSavePending = false,
    openSequence = 0;
  let usingUrlFilters = false;
  let allowStaleCache = false;
  let selectedBugId = "",
    bugStage = "all",
    submittingBug = null,
    bugDetailKey = "";
  let creatingDiscussion = "";
  const selectedBugs = new Set();
  let bugSelectionScope = "";
  let attachmentViewer = null;
  const collapsedRequirements = new Set();
  const collapsedVersions = new Set();
  const submittingRequirements = new Set();
  const preferenceKeys = ["q", "include_family", "version_desc"];
  const conditionFields = ["project", "version", "person", "status", "priority", "environment", "hierarchy", "scope"];
  const urlFilterKeys = ["q", "created_from", "created_to", "include_family", "version_desc", ...conditionFields];
  const workspace = find("#issueWorkspace");
  const workspaceResizer = find("#issueWorkspaceResizer");
  const workspaceRatioKey = "release-lite-bug-workspace-ratio";
  const defaultWorkspaceRatio = (100 * 1.05) / 2.05;
  const workspaceDesktop = window.matchMedia("(min-width: 1051px)");
  let workspaceRatio = defaultWorkspaceRatio,
    workspaceDrag = null;
  try {
    const savedRatio = Number(localStorage.getItem(workspaceRatioKey));
    if (Number.isFinite(savedRatio) && savedRatio >= 25 && savedRatio <= 75) workspaceRatio = savedRatio;
  } catch {
    /* Keep resizing available when browser storage is restricted. */
  }
  function workspaceBounds() {
    const width = workspace.clientWidth - workspaceResizer.getBoundingClientRect().width;
    const minimum = width > 0 ? Math.max(25, Math.min(50, (320 / width) * 100)) : 25;
    return { width, minimum, maximum: 100 - minimum };
  }
  function applyWorkspaceRatio() {
    const { minimum, maximum } = workspaceBounds();
    const ratio = Math.max(minimum, Math.min(maximum, workspaceRatio));
    workspace.style.setProperty("--issue-queue-fr", `${ratio}fr`);
    workspace.style.setProperty("--issue-desk-fr", `${100 - ratio}fr`);
    workspaceResizer.setAttribute("aria-valuemin", minimum.toFixed(1));
    workspaceResizer.setAttribute("aria-valuemax", maximum.toFixed(1));
    workspaceResizer.setAttribute("aria-valuenow", ratio.toFixed(1));
    workspaceResizer.setAttribute("aria-valuetext", `表格 ${Math.round(ratio)}%，操作台 ${Math.round(100 - ratio)}%`);
    return ratio;
  }
  function saveWorkspaceRatio() {
    try {
      localStorage.setItem(workspaceRatioKey, String(workspaceRatio));
    } catch {
      /* Retain the current ratio for this page if storage is unavailable. */
    }
  }
  function finishWorkspaceResize() {
    if (!workspaceDrag) return;
    const { pointerId } = workspaceDrag;
    workspaceDrag = null;
    workspaceResizer.classList.remove("is-dragging");
    document.body.classList.remove("issue-workspace-resizing");
    if (workspaceResizer.hasPointerCapture(pointerId)) workspaceResizer.releasePointerCapture(pointerId);
    saveWorkspaceRatio();
  }
  workspaceResizer.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !event.isPrimary || !workspaceDesktop.matches || workspaceDrag) return;
    event.preventDefault();
    workspaceDrag = { pointerId: event.pointerId, startX: event.clientX, ratio: applyWorkspaceRatio() };
    workspaceResizer.setPointerCapture(event.pointerId);
    workspaceResizer.focus({ preventScroll: true });
    workspaceResizer.classList.add("is-dragging");
    document.body.classList.add("issue-workspace-resizing");
  });
  workspaceResizer.addEventListener("pointermove", (event) => {
    if (!workspaceDrag || event.pointerId !== workspaceDrag.pointerId) return;
    const { width, minimum, maximum } = workspaceBounds();
    if (width <= 0) return;
    workspaceRatio = Math.max(minimum, Math.min(maximum, workspaceDrag.ratio + ((event.clientX - workspaceDrag.startX) / width) * 100));
    applyWorkspaceRatio();
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
    workspaceResizer.addEventListener(type, (event) => {
      if (event.pointerId === workspaceDrag?.pointerId) finishWorkspaceResize();
    });
  }
  workspaceResizer.addEventListener("keydown", (event) => {
    if (!workspaceDesktop.matches || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const ratio = applyWorkspaceRatio();
    const { minimum, maximum } = workspaceBounds();
    workspaceRatio = event.key === "Home" ? minimum : event.key === "End" ? maximum : Math.max(minimum, Math.min(maximum, ratio + (event.key === "ArrowLeft" ? -2 : 2)));
    applyWorkspaceRatio();
    saveWorkspaceRatio();
  });
  workspaceResizer.addEventListener("dblclick", () => {
    workspaceRatio = defaultWorkspaceRatio;
    applyWorkspaceRatio();
    saveWorkspaceRatio();
  });
  workspaceDesktop.addEventListener("change", () => {
    finishWorkspaceResize();
    applyWorkspaceRatio();
  });
  window.addEventListener("blur", finishWorkspaceResize);
  const workspaceObserver = new ResizeObserver(() => {
    if (workspaceDesktop.matches && workspace.clientWidth > 0) applyWorkspaceRatio();
  });
  workspaceObserver.observe(workspace);
  applyWorkspaceRatio();
  const dropdownControls = IssueFilterControls.create(form, renderProjectOptions);
  const conditionBuilder = IssueConditionBuilder.create(find("#issueConditionRows"), (value) => {
    conditionFilter = value;
    form.elements.condition_logic.value = value.logic;
    dropdownControls.refresh();
    page = 1;
    savePreferences();
    load();
  });
  const date = (value) => (value ? escape(value.slice(0, 10)) : "");
  const names = (people) => (people || []).map((person) => person.name || person.id).join("、");
  const list = (values) => (values?.length ? values.join("、") : "");
  const badge = (value, tone = "") => (value ? `<span class="issue-badge ${tone}">${escape(value)}</span>` : "");
  const statusTag = (value) => (value ? `<span class="issue-status-tag" data-status="${escape(value)}">${escape(value)}</span>` : "");
  const testDeadline = (row) =>
    row.test_deadline ? `<span class="issue-test-deadline" data-tone="${escape(row.test_deadline_tone || "")}">${date(row.test_deadline)}</span>` : "";
  function recordTitle(row) {
    const raw = String(row.title || "无标题").trim();
    const markdown = raw.match(/^\[([\s\S]*)\]\((https?:\/\/[^\s]+)\)$/);
    const title = markdown?.[1] || raw;
    try {
      const url = new URL(markdown?.[2] || row.source_url);
      if (["http:", "https:"].includes(url.protocol)) {
        return `<a class="issue-title-link" href="${escape(url.href)}" target="_blank" rel="noopener noreferrer" data-detail="${escape(row.id)}" title="点击查看详情；Ctrl / Command + 点击打开链接">${escape(title)}</a>`;
      }
    } catch {
      /* Records without a valid external URL still open the detail dialog. */
    }
    return `<button class="issue-title-button" type="button" data-detail="${escape(row.id)}">${escape(title)}</button>`;
  }
  const safeLink = (value, label) => {
    if (!value) return "";
    // CLI text URL cells can contain either a plain URL or a Markdown link.
    const url = String(value).match(/^\[[^\]]*\]\((https?:\/\/[^\s]+)\)$/)?.[1] || String(value);
    try {
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol)) return escape(value);
      return `<a href="${escape(parsed.href)}" target="_blank" rel="noopener noreferrer">${escape(label || value)} <i class="bi bi-box-arrow-up-right"></i></a>`;
    } catch {
      return escape(value);
    }
  };
  function mediaAttachments(row) {
    return (
      (row.attachments || [])
        .filter((item) => ["image", "video"].includes(item.media_kind) && item.preview_url)
        .map((item) => {
          const source = escape(item.preview_url),
            name = escape(item.name || "附件");
          const preview =
            item.media_kind === "image"
              ? `<button class="issue-media-image" type="button" data-preview-image aria-label="预览图片：${name}"><img src="${source}" alt="${name}" loading="lazy" decoding="async" data-attachment-media></button>`
              : `<video src="${source}" controls playsinline preload="none" aria-label="${name}" data-attachment-media>浏览器不支持播放此视频。</video>`;
          return `<figure class="issue-media">${preview}<figcaption><i class="bi bi-${item.media_kind === "image" ? "image" : "play-circle"}" aria-hidden="true"></i><span>${name}</span>${item.media_kind === "image" ? '<small class="muted">点击预览图片</small>' : ""}</figcaption><div class="issue-media-error" data-attachment-error hidden><p>附件加载失败或浏览器不支持此格式。</p><button type="button" class="btn btn-outline-secondary btn-sm" data-retry-attachment>重试</button> ${safeLink(row.source_url, "在飞书查看")}</div></figure>`;
        })
        .join("") || '<span class="muted">暂无图片或视频附件</span>'
    );
  }
  function previewAttachment(button) {
    if (typeof window.Viewer !== "function") {
      toast("图片预览组件加载失败，请刷新页面重试", "error");
      return;
    }
    const buttons = [...button.closest(".issue-desk-attachments").querySelectorAll("[data-preview-image]")];
    // Keep the gallery independent of desk updates during background synchronization.
    const gallery = document.createElement("div");
    for (const item of buttons) {
      const source = item.querySelector("img");
      const image = document.createElement("img");
      image.src = source.src;
      image.alt = source.alt;
      gallery.appendChild(image);
    }
    attachmentViewer?.destroy();
    const viewer = new window.Viewer(gallery, {
      toolbar: { zoomIn: true, zoomOut: true, oneToOne: true, reset: true, prev: true, next: true, rotateLeft: true, rotateRight: true },
      hidden() {
        viewer.destroy();
        if (attachmentViewer === viewer) attachmentViewer = null;
        if (button.isConnected) button.focus({ preventScroll: true });
      },
    });
    attachmentViewer = viewer;
    viewer.view(buttons.indexOf(button));
  }
  const request = ReleaseLite.request;
  function preferenceError(message) {
    find("#issuePreferenceStatus").textContent = message;
    find("#issuePreferenceStatus").hidden = false;
  }
  function savePreferences() {
    if (usingUrlFilters) return Promise.resolve();
    const target = kind;
    const payload = {
      filters: Object.fromEntries(preferenceKeys.filter((key) => filters[key] !== undefined).map((key) => [key, Array.isArray(filters[key]) ? [...filters[key]] : filters[key]])),
      condition_filter: JSON.parse(JSON.stringify(conditionFilter)),
      requirement_projects: target === "requirements" ? [...requirementProjects] : [],
      active_project: target === "requirements" ? activeRequirementProject : "",
    };
    preferenceQueue = preferenceQueue
      .then(async () => {
        await request(`/api/issues/preferences/${target}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        if (kind === target) find("#issuePreferenceStatus").hidden = true;
      })
      .catch((error) => preferenceError(`${labels[target]}的筛选条件保存失败：${error.message}`));
    return preferenceQueue;
  }
  function applyAutoSyncPreferences(preferences, target = kind) {
    if (preferences?.auto_sync_states) {
      for (const pageKind of Object.keys(autoSyncSettings)) autoSyncSettings[pageKind] = preferences.auto_sync_states[pageKind] === true;
    } else {
      autoSyncSettings[target] = preferences?.auto_sync === true;
    }
  }
  function renderAutoSyncControl() {
    autoSyncControl.checked = autoSyncSettings[kind];
    autoSyncControl.indeterminate = kind === "overview" && autoSyncSettings.requirements !== autoSyncSettings.bugs;
    autoSyncControl.setAttribute("aria-checked", autoSyncControl.indeterminate ? "mixed" : String(autoSyncControl.checked));
  }
  function scheduleAutoSync() {
    clearTimeout(autoSyncTimer);
    autoSyncTimer = null;
    if (!autoSyncSettings[kind]) return;
    const target = kind,
      opening = openSequence;
    autoSyncTimer = setTimeout(async () => {
      autoSyncTimer = null;
      if (kind !== target || opening !== openSequence || !autoSyncSettings[target]) return;
      try {
        await syncData(true);
      } finally {
        if (kind === target && opening === openSequence && autoSyncSettings[target]) scheduleAutoSync();
      }
    }, autoSyncInterval);
  }
  function setStatus(sync) {
    const status = find("#issueSyncStatus");
    const range = sync.date_range;
    if (range) {
      for (const key of ["created_from", "created_to"]) {
        filters[key] = range[key];
        if (document.activeElement !== form.elements[key]) form.elements[key].value = range[key];
      }
    }
    const stamp = sync.updated_at ? `上次成功同步：${sync.updated_at.replace("T", " ").replace(/\+08:00$/, "")}（北京时间）` : "尚未同步数据";
    const coverage = Object.entries(sync.cached_date_ranges || {})
      .map(([target, range]) => `${target === "requirements" ? "需求" : "bug"} ${range.created_from} 至 ${range.created_to}`)
      .join("；");
    const cacheNote = sync.stale ? `当前显示缓存（覆盖范围：${coverage}）。${sync.syncing ? "最新数据正在后台同步。" : "请同步获取最新数据。"} ` : "";
    status.classList.toggle("issue-sync-error", Boolean(sync.error));
    status.textContent =
      cacheNote + (sync.error ? `${sync.error}${sync.ready ? " 当前展示上次成功同步的数据。" : ""} ${stamp}` : `${sync.syncing ? `${sync.progress || "正在同步…"} ` : ""}${stamp}`);
    find("#issueSyncButton").disabled = sync.syncing || sync.submitting || submittingRequirements.size > 0 || Boolean(submittingBug || creatingDiscussion);
    find("#issueSyncButton").textContent = sync.syncing ? "同步中…" : "同步数据";
  }
  async function load() {
    clearTimeout(poll);
    const current = ++sequence;
    const selectionScope = bugSelectionKey();
    if (selectionScope !== bugSelectionScope) selectedBugs.clear();
    bugSelectionScope = selectionScope;
    if (filters.created_from !== undefined && (!filters.created_from || !filters.created_to || filters.created_from > filters.created_to)) {
      root.setAttribute("aria-busy", "false");
      find("#issueContent").hidden = true;
      find("#issueSyncStatus").textContent = "请选择完整的创建时间范围，开始日期不能晚于结束日期。";
      find("#issueSyncStatus").classList.add("issue-sync-error");
      find("#issueFilterError").textContent = "请选择完整的创建时间范围，开始日期不能晚于结束日期。";
      find("#issueFilterError").hidden = false;
      return;
    }
    find("#issueFilterError").hidden = true;
    root.setAttribute("aria-busy", "true");
    renderBugSelection();
    try {
      const parameters = new URLSearchParams({ kind, page });
      if (allowStaleCache) parameters.set("allow_stale", "1");
      if (kind === "bugs") parameters.set("bug_stage", bugStage);
      for (const [key, value] of Object.entries(filters)) {
        for (const item of Array.isArray(value) ? value : [value]) {
          if (item !== undefined && item !== null && item !== "") parameters.append(key, item);
        }
      }
      parameters.set("condition_filter", JSON.stringify(conditionFilter));
      const result = await request("/api/issues/data?" + parameters);
      if (current !== sequence) return;
      setStatus(result.sync);
      if (result.sync.ready) {
        if (!result.sync.stale) allowStaleCache = false;
        if (kind === "bugs" && bugStage !== "all" && !(result.bug_stages[bugStage] > 0)) {
          bugStage = "all";
          page = 1;
          selectedBugId = "";
          await load();
          return;
        }
        data = result;
        page = result.page;
        bugSelectionScope = bugSelectionKey();
        render();
      } else {
        data = null;
        find("#issueContent").hidden = true;
      }
      if ((result.sync.syncing || result.sync.submitting) && root.classList.contains("active")) poll = setTimeout(load, 1000);
    } catch (error) {
      if (current !== sequence) return;
      find("#issueSyncStatus").textContent = `读取失败：${error.message}，请点击“同步数据”重试。`;
      find("#issueSyncStatus").classList.add("issue-sync-error");
      find("#issueSyncButton").disabled = false;
      find("#issueSyncButton").textContent = "同步数据";
    } finally {
      if (current === sequence) {
        root.setAttribute("aria-busy", "false");
        renderBugSelection();
      }
    }
  }
  function renderFilters() {
    form.elements.condition_logic.value = conditionFilter.logic;
    form.elements.include_family.checked = filters.include_family === "1";
    form.elements.version_desc.checked = filters.version_desc === "1";
    if (document.activeElement !== form.elements.q) form.elements.q.value = filters.q || "";
    conditionBuilder.updateOptions(data.options);
    if (kind === "requirements") renderProjectOptions();
    dropdownControls.refresh();
    renderProjectTabs();
  }
  function renderProjectOptions() {
    const projects = [...new Set(["__empty__", ...(data?.options.project || []), ...requirementProjects])];
    const query = find("#issueProjectSearch").value.trim().toLocaleLowerCase();
    const html =
      projects
        .filter((project) => (project === "__empty__" ? "未填写" : project).toLocaleLowerCase().includes(query))
        .map(
          (project) =>
            `<button type="button" class="issue-project-option" role="option" aria-selected="${requirementProjects.includes(project)}" data-requirement-project="${escape(project)}"><span>${escape(project === "__empty__" ? "未填写" : project)}</span><i class="bi bi-check2" aria-hidden="true"></i></button>`,
        )
        .join("") || '<span class="issue-dropdown-empty">无匹配项目</span>';
    if (find("#issueProjectChoices").innerHTML !== html) find("#issueProjectChoices").innerHTML = html;
    const selectedText = requirementProjects.map((project) => (project === "__empty__" ? "未填写" : project)).join("、") || "全部项目";
    find("#issueProjectSelectedText").textContent = selectedText;
    find("#issueProjectSelectedText").title = selectedText;
  }
  function applyRequirementProject() {
    if (activeRequirementProject) filters.project = activeRequirementProject;
    else if (requirementProjects.length) filters.project = [...requirementProjects];
    else delete filters.project;
  }
  function renderProjectTabs() {
    const tabs = find("#issueProjectTabs");
    tabs.hidden = kind !== "requirements";
    if (tabs.hidden) return;
    const projects = ["", ...requirementProjects];
    tabs.innerHTML = projects
      .map(
        (project) =>
          `<button type="button" class="issue-project-tab ${project === activeRequirementProject ? "active" : ""}" role="tab" aria-selected="${project === activeRequirementProject}" aria-controls="issueContent" tabindex="${project === activeRequirementProject ? 0 : -1}" data-requirement-project-tab="${escape(project)}">${escape(project === "" ? "全部" : project === "__empty__" ? "未填写" : project)}</button>`,
      )
      .join("");
  }
  function metric(title, value, target, scope = "", detail = "") {
    return `<button type="button" class="issue-metric" data-jump="${target}" data-scope="${scope}"><small>${title}</small><b>${value}</b><span class="muted">${detail || "查看对应记录"} <i class="bi bi-arrow-up-right"></i></span></button>`;
  }
  function chart(title, entries, chartKind, field = "status") {
    const maximum = Math.max(1, ...entries.map((entry) => entry.count));
    const bugStatus = chartKind === "bugs" && field === "status";
    return `<section class="content-card issue-chart"><h3>${title}</h3>${entries.length ? entries.map((entry) => `<button type="button" class="issue-chart-row${bugStatus ? " issue-chart-status-row" : ""}" data-chart-kind="${chartKind}" data-chart-field="${field}" data-chart-value="${escape(entry.name === "未填写" ? "__empty__" : entry.name)}"><span title="${escape(entry.name)}">${bugStatus && entry.name !== "未填写" ? statusTag(entry.name) : escape(entry.name)}</span><span class="issue-bar"><span style="width:${(entry.count / maximum) * 100}%"></span></span><b>${entry.count}</b></button>`).join("") : '<p class="muted">暂无数据</p>'}</section>`;
  }
  function tableHeader() {
    const columns =
      kind === "requirements" ? ["标题", "优先级", "状态", "开发人员", "提测截止日期", "产品", "测试人员", "设计稿", "设计人员"] : ["标题 / 项目", "状态", "优先级", "处理人"];
    return columns
      .map(
        (label, index) =>
          `<th>${kind === "bugs" && index === 0 ? `<label class="issue-bug-title-heading"><input class="issue-bug-checkbox" type="checkbox" data-bug-select-all aria-label="全选当前页 bug"><span>${label}</span></label>` : label}</th>`,
      )
      .join("");
  }
  function renderTableHeader() {
    find("#issueTable").dataset.kind = kind;
    find("#issueTableHead").innerHTML = tableHeader();
  }
  function bugSelectionKey() {
    return JSON.stringify([kind, page, bugStage, filters, conditionFilter]);
  }
  function renderBugSelection() {
    const rows = kind === "bugs" ? data?.items || [] : [];
    const count = rows.filter((row) => selectedBugs.has(row.id)).length;
    const busy = Boolean(!data || submittingBug || creatingDiscussion || data.sync.syncing || data.sync.submitting || root.getAttribute("aria-busy") === "true");
    find("#issueBugBatchActions").hidden = kind !== "bugs" || count === 0;
    find("#issueBugSelectionCount").textContent = `已选 ${count} 条`;
    for (const checkbox of root.querySelectorAll("[data-bug-check]")) {
      checkbox.checked = selectedBugs.has(checkbox.dataset.bugCheck);
      checkbox.disabled = busy;
      checkbox.closest("tr").classList.toggle("issue-bug-checked", checkbox.checked);
    }
    const selectAll = find("[data-bug-select-all]");
    if (selectAll) {
      selectAll.checked = rows.length > 0 && count === rows.length;
      selectAll.indeterminate = count > 0 && count < rows.length;
      selectAll.disabled = busy || rows.length === 0;
    }
    for (const button of root.querySelectorAll("[data-bug-batch-status], [data-bug-stage]")) button.disabled = busy;
    if (kind === "bugs" && data) {
      find("#issuePrevious").disabled = busy || page <= 1;
      find("#issueNext").disabled = busy || page >= data.page_count;
    }
  }
  function rowHtml(row) {
    if (row.kind === "bugs") {
      return `<tr data-select-bug="${escape(row.id)}" class="${row.id === selectedBugId ? "issue-bug-selected" : ""}"><td><div class="issue-bug-row-heading"><input class="issue-bug-checkbox" type="checkbox" data-bug-check="${escape(row.id)}" aria-label="选择 bug：${escape(row.title || row.id)}" ${selectedBugs.has(row.id) ? "checked" : ""}><div class="issue-bug-row-content"><div class="issue-bug-row-title">${recordTitle(row)}</div><small class="muted issue-bug-row-meta">${escape([list(row.project), list(row.version)].filter(Boolean).join(" · ") || "未填写项目 / 版本")}${row.overdue ? ' <span class="text-danger">逾期</span>' : ""}</small></div></div></td><td>${statusTag(row.status) || '<span class="muted">未填写</span>'}</td><td>${badge(row.priority, ["紧急", "高"].includes(row.priority) ? "red" : "")}</td><td>${escape(names(row.owners)) || '<span class="muted">未分配</span>'}</td></tr>`;
    }
    const hasChildren = row.tree_child_count > 0;
    const collapsed = collapsedRequirements.has(row.id);
    const hidden = (row.tree_ancestors || []).some((id) => collapsedRequirements.has(id));
    const toggle = hasChildren
      ? `<button type="button" class="issue-tree-toggle" data-toggle-requirement="${escape(row.id)}" aria-expanded="${!collapsed}" aria-label="${collapsed ? "展开" : "收起"}子需求"><i class="bi bi-chevron-${collapsed ? "right" : "down"}" aria-hidden="true"></i></button>`
      : '<span class="issue-tree-spacer" aria-hidden="true"></span>';
    const title = `${recordTitle(row)}${row.filter_match === false ? '<span class="issue-context-label">补充展示</span>' : ""}`;
    const priority = badge(row.priority, ["紧急", "高"].includes(row.priority) ? "red" : "");
    const submissionDisabled = Boolean(submittingRequirements.size || data.sync.syncing || data.sync.submitting);
    const status =
      !row.is_child
        ? `<a href="#" role="button" class="issue-submit-link" data-submit-requirement="${escape(row.id)}" aria-disabled="${submissionDisabled}" ${submissionDisabled ? 'tabindex="-1"' : ""}>${submittingRequirements.has(row.id) ? "提测中…" : "提测"}</a>`
        : statusTag(row.status);
    const cells = [
      priority,
      status,
      escape(names(row.developers)),
      testDeadline(row),
      escape(names(row.products)),
      escape(names(row.testers)),
      safeLink(row.design, "打开设计稿"),
      escape(names(row.designers)),
    ];
    return `<tr${hidden ? " hidden" : ""}><td><div class="issue-record-heading" style="--issue-depth:${row.tree_depth || 0}">${toggle}<div>${title}</div></div></td>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`;
  }
  function renderRows() {
    const versionLists = find("#issueVersionLists");
    const grouped = kind === "requirements";
    versionLists.hidden = !grouped;
    find("#issueFlatList").hidden = grouped;
    if (grouped) {
      const rowsByVersion = new Map(data.version_groups.map((group) => [group.key, []]));
      for (const row of data.items) rowsByVersion.get(row.version_group).push(row);
      versionLists.innerHTML = data.version_groups.length
        ? data.version_groups
            .map((group) => {
              const count = `共 ${group.matched_total} 条`;
              return `<details class="issue-version-group" data-version-group="${escape(group.key)}" ${collapsedVersions.has(group.key) ? "" : "open"}><summary><i class="bi bi-chevron-right" aria-hidden="true"></i><span class="issue-version-name">${escape(group.name)}</span><span class="muted issue-version-count">${count}</span></summary><div class="table-responsive"><table class="table align-middle mb-0 issue-table" data-kind="requirements"><thead><tr>${tableHeader()}</tr></thead><tbody>${rowsByVersion.get(group.key).map(rowHtml).join("")}</tbody></table></div></details>`;
            })
            .join("")
        : '<p class="empty-row">没有符合筛选条件的记录</p>';
      for (const details of versionLists.querySelectorAll("[data-version-group]")) {
        details.addEventListener("toggle", () => {
          if (!details.isConnected) return;
          if (details.open) collapsedVersions.delete(details.dataset.versionGroup);
          else collapsedVersions.add(details.dataset.versionGroup);
        });
      }
      return;
    }
    if (kind === "bugs") {
      for (const id of selectedBugs) if (!data.items.some((row) => row.id === id)) selectedBugs.delete(id);
      if (!data.items.some((row) => row.id === selectedBugId)) selectedBugId = data.items[0]?.id || "";
    }
    find("#issueRows").innerHTML = data.items.length ? data.items.map(rowHtml).join("") : '<tr><td colspan="4" class="empty-row">没有符合筛选条件的记录</td></tr>';
    if (kind === "bugs") renderBugDesk();
  }
  function selectBug(id) {
    if (id === selectedBugId || !data?.items.some((row) => row.id === id)) return;
    selectedBugId = id;
    find("#issueBugActionStatus").textContent = "";
    find("#issueBugDiscussionStatus").hidden = true;
    renderRows();
  }
  function renderBugDiscussion(row, busy) {
    const container = find("#issueBugDiscussion");
    if (!row) {
      container.innerHTML = "";
      return;
    }
    const chat = row.discussion;
    const link = chat
      ? `<a class="issue-discussion-link" href="${escape(chat.url)}" target="_blank" rel="noopener noreferrer" title="在飞书打开：${escape(chat.name)}"><i class="bi bi-chat-dots" aria-hidden="true"></i><span>${escape(chat.name)}</span><i class="bi bi-box-arrow-up-right" aria-hidden="true"></i></a>`
      : "";
    const label = creatingDiscussion === row.id ? "处理中…" : row.discussion_creation_pending ? "建群待确认" : row.discussion_needs_link ? "重试关联" : "一键建群";
    const button =
      !chat || row.discussion_needs_link
        ? `<button class="btn btn-outline-primary btn-sm" type="button" data-create-bug-discussion ${busy || row.discussion_creation_pending ? "disabled" : ""} title="${row.discussion_creation_pending ? "请先在飞书确认上次建群结果并关联讨论群，然后同步数据" : "创建讨论群，包含当前登录用户、bug 创建人和处理人"}">${label}</button>`
        : "";
    const html = link + button;
    if (container.innerHTML !== html) container.innerHTML = html;
  }
  async function createBugDiscussion() {
    const row = data?.items.find((item) => item.id === selectedBugId);
    if (
      kind !== "bugs" ||
      !row ||
      creatingDiscussion ||
      submittingBug ||
      data.sync.syncing ||
      data.sync.submitting ||
      row.discussion_creation_pending ||
      (row.discussion && !row.discussion_needs_link)
    )
      return;
    const opening = openSequence;
    const showStatus = (message, failed = false) => {
      if (selectedBugId !== row.id) return;
      const element = find("#issueBugDiscussionStatus");
      element.textContent = message;
      element.classList.toggle("text-danger", failed);
      element.classList.toggle("text-success", !failed);
      element.hidden = false;
    };
    creatingDiscussion = row.id;
    renderBugDesk();
    find("#issueSyncButton").disabled = true;
    showStatus(row.discussion_needs_link ? "正在关联已创建的讨论群…" : "正在创建并关联讨论群…");
    try {
      const result = await request(`/api/issues/bugs/${encodeURIComponent(row.id)}/discussion`, { method: "POST" });
      if (opening !== openSequence) return;
      const current = data?.items.find((item) => item.id === row.id);
      if (current) Object.assign(current, { discussion: result.discussion, discussion_needs_link: false, discussion_creation_pending: false });
      showStatus(result.warning || "讨论群已关联，点击群名即可在飞书打开。", Boolean(result.warning));
      await load();
    } catch (error) {
      if (opening !== openSequence) return;
      showStatus(`建群或关联失败：${error.message}`, true);
      await load();
    } finally {
      creatingDiscussion = "";
      if (data) {
        setStatus(data.sync);
        if (kind === "bugs") renderBugDesk();
      }
    }
  }
  function renderBugDesk() {
    const row = data.items.find((item) => item.id === selectedBugId);
    const index = data.items.indexOf(row);
    const busy = Boolean(submittingBug || creatingDiscussion || data.sync.syncing || data.sync.submitting);
    renderBugDiscussion(row, busy);
    find("#issueBugPosition").textContent = row ? `${(page - 1) * data.page_size + index + 1} / ${data.total}` : "";
    const key = JSON.stringify(row || null);
    if (key !== bugDetailKey) {
      bugDetailKey = key;
      if (!row) {
        find("#issueBugDetail").innerHTML =
          '<div class="issue-desk-empty"><i class="bi bi-check2-circle" aria-hidden="true"></i><h4>当前没有可处理的 bug</h4><p class="muted">可以切换处理阶段或调整筛选条件</p></div>';
      } else {
        const title = String(row.title || "无标题").replace(/^\[([\s\S]*)\]\(https?:\/\/[^\s]+\)$/, "$1");
        const pairs = [
          ["项目", escape(list(row.project))],
          ["版本", escape(list(row.version))],
          ["处理人", escape(names(row.owners))],
          ["创建人", escape(names(row.creators))],
          ["发现环境", escape(row.environment)],
        ];
        const related =
          (row.related || [])
            .map(
              (item) =>
                `<button class="issue-related-link" type="button" data-related-kind="${escape(item.kind)}" data-related-id="${escape(item.id)}">${escape(item.title)}</button>`,
            )
            .join("") || '<span class="muted">暂无关联需求</span>';
        const attachments = mediaAttachments(row);
        find("#issueBugDetail").innerHTML =
          `<div class="issue-desk-tags">${statusTag(row.status) || badge("未填写状态")}${badge(row.priority, ["紧急", "高"].includes(row.priority) ? "red" : "")}${row.overdue ? badge("已逾期", "red") : ""}</div><h4 class="issue-desk-title"><button type="button" data-copy-bug-title title="点击复制标题">${escape(title)}</button></h4><small class="muted">${escape(row.id)}</small><dl class="issue-detail-grid">${pairs.map(([label, value]) => `<div><dt>${label}</dt><dd>${value || "未填写"}</dd></div>`).join("")}</dl><section class="issue-desk-section"><h4>问题说明与链接</h4><div class="issue-desk-text">${escape(row.notes) || '<span class="muted">暂无备注说明</span>'}</div>${row.link ? `<div class="issue-desk-link">${safeLink(row.link, "打开问题链接")}</div>` : ""}</section><section class="issue-desk-section"><h4>根因分析与解决方式</h4><div class="issue-desk-text">${escape(row.solution) || '<span class="muted">暂无记录</span>'}</div></section><section class="issue-desk-section"><h4>附件</h4><div class="issue-desk-attachments">${attachments}</div></section><section class="issue-desk-section"><h4>关联需求</h4><div class="issue-related">${related}</div></section><details class="issue-desk-more"><summary>更多信息</summary><dl class="issue-detail-grid"><div><dt>创建时间</dt><dd>${escape(row.created_at?.replace("T", " ")) || "未填写"}</dd></div><div><dt>预计修复完成</dt><dd>${date(row.due_at) || "未填写"}</dd></div><div><dt>截止日期</dt><dd>${date(row.deadline) || "未填写"}</dd></div><div><dt>bug 分类</dt><dd>${escape(row.category) || "未填写"}</dd></div><div><dt>bug 属性</dt><dd>${escape(row.attribute) || "未填写"}</dd></div></dl></details><div class="issue-detail-footer">${safeLink(row.source_url, "在飞书打开详情")}</div>`;
      }
      find("#issueBugDetail").scrollTop = 0;
    }
    for (const button of root.querySelectorAll("[data-bug-status]")) {
      button.disabled = !row || busy || row.status === button.dataset.bugStatus;
      button.textContent =
        submittingBug?.id === row?.id && submittingBug?.status === button.dataset.bugStatus ? "保存中…" : button.dataset.bugStatusLabel || button.dataset.bugStatus;
    }
    find("#issueBugSkip").disabled = !row || busy || (index === data.items.length - 1 && page >= data.page_count);
    for (const title of find("#issueRows").querySelectorAll("[data-detail]")) {
      if (title.dataset.detail === selectedBugId) title.setAttribute("aria-current", "true");
    }
    renderBugSelection();
  }
  async function copyBugTitle(button) {
    const title = button.textContent;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(title);
      } else {
        const input = document.createElement("textarea");
        input.value = title;
        input.readOnly = true;
        input.style.position = "fixed";
        input.style.opacity = "0";
        document.body.appendChild(input);
        const focused = document.activeElement;
        try {
          input.select();
          if (!document.execCommand("copy")) throw new Error("复制失败");
        } finally {
          input.remove();
          focused?.focus({ preventScroll: true });
        }
      }
      toast("已复制", "success");
    } catch {
      toast("复制失败，请重试", "error");
    }
  }
  async function nextBug() {
    if (!data || submittingBug || creatingDiscussion) return;
    const index = data.items.findIndex((row) => row.id === selectedBugId);
    if (index < data.items.length - 1) selectBug(data.items[index + 1].id);
    else if (page < data.page_count) {
      selectedBugId = "";
      page++;
      await load();
    }
  }
  async function updateBugStatus(status) {
    const row = data?.items.find((item) => item.id === selectedBugId);
    if (kind !== "bugs" || !row || submittingBug || creatingDiscussion || data.sync.syncing || data.sync.submitting || row.status === status) return;
    const opening = openSequence;
    const showStatus = (message, failed = false) => {
      const element = find("#issueBugActionStatus");
      element.textContent = message;
      element.classList.toggle("text-danger", failed);
      element.classList.toggle("text-success", !failed);
    };
    submittingBug = { id: row.id, status };
    renderBugDesk();
    find("#issueSyncButton").disabled = true;
    showStatus(`正在将当前 bug 标记为“${status}”…`);
    try {
      const result = await request(`/api/issues/bugs/${encodeURIComponent(row.id)}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, expected_status: row.status }),
      });
      if (opening !== openSequence) return;
      showStatus(result.warning || `“${String(row.title || "bug").slice(0, 40)}”已标记为“${result.status}”。`, Boolean(result.warning));
      await load();
    } catch (error) {
      if (opening !== openSequence) return;
      showStatus(`保存失败：${error.message}`, true);
      await load();
    } finally {
      submittingBug = null;
      if (data) {
        setStatus(data.sync);
        if (kind === "bugs") renderBugDesk();
      }
    }
  }
  async function updateSelectedBugStatuses(status) {
    if (kind !== "bugs" || !data || submittingBug || creatingDiscussion || data.sync.syncing || data.sync.submitting || root.getAttribute("aria-busy") === "true") return;
    const records = data.items.filter((row) => selectedBugs.has(row.id)).map((row) => ({ id: row.id, expected_status: row.status }));
    if (!records.length) return;
    const opening = openSequence;
    const showStatus = (message, failed = false) => {
      const element = find("#issueBugBatchStatus");
      element.textContent = message;
      element.classList.toggle("text-danger", failed);
      element.classList.toggle("text-success", !failed);
      element.hidden = false;
    };
    submittingBug = { ids: records.map((row) => row.id), status };
    form.inert = true;
    form.elements.q.disabled = true;
    renderBugDesk();
    find("#issueSyncButton").disabled = true;
    showStatus(`正在将选中的 ${records.length} 条 bug 标记为“${status}”…`);
    try {
      const result = await request("/api/issues/bugs/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ records, status }),
      });
      if (opening !== openSequence) return;
      selectedBugs.clear();
      showStatus(result.warning || `已将 ${result.updated_count} 条 bug 标记为“${result.status}”。`, Boolean(result.warning));
      await load();
    } catch (error) {
      if (opening !== openSequence) return;
      showStatus(`批量更新失败：${error.message}`, true);
      await load();
    } finally {
      submittingBug = null;
      if (opening === openSequence) {
        form.inert = false;
        form.elements.q.disabled = false;
      }
      if (data) {
        setStatus(data.sync);
        if (kind === "bugs") renderBugDesk();
      }
    }
  }
  function renderOverview() {
    const counts = data.counts;
    find("#issueMetrics").innerHTML = [
      metric("需求记录", counts.requirements, "requirements", "", `主需求 ${counts.main} · 子需求 ${counts.children}`),
      metric("未结项需求", counts.pending_requirements, "requirements", "pending"),
      metric("bug 记录", counts.bugs, "bugs"),
      metric("未结项 bug", counts.pending_bugs, "bugs", "pending"),
      metric("紧急 / 高优先级未结项", counts.urgent, "overview", "urgent"),
      metric("已逾期未结项", counts.overdue, "overview", "overdue"),
    ].join("");
    find("#issueCountNote").textContent =
      `统计限定在所选创建时间范围内，按记录计数，主需求和子需求分别计入。${counts.missing_status} 条未填写状态，不计入未结项。逾期按北京时间判断：需求取预计结束；bug 优先取预计修复完成，未填时取截止日期。`;
    find("#issueCharts").innerHTML =
      chart("需求状态分布", data.charts.requirements, "requirements") +
      chart("bug 状态分布", data.charts.bugs, "bugs") +
      chart("各项目未结项", data.charts.projects, "overview", "project");
  }
  function render() {
    find("#issueContent").hidden = false;
    renderFilters();
    const overview = kind === "overview";
    for (const selector of ["#issueMetrics", "#issueCountNote", "#issueCharts"]) find(selector).hidden = !overview;
    find("#issueList").hidden = overview;
    const source = find("#issueSource");
    source.hidden = overview;
    if (overview) return renderOverview();
    source.href = data.sources[kind];
    find("#issueWorkspace").classList.toggle("is-bug-workspace", kind === "bugs");
    workspaceResizer.hidden = kind !== "bugs";
    if (kind === "bugs") applyWorkspaceRatio();
    find("#issueBugDesk").hidden = kind !== "bugs";
    find("#issueBugToolbar").hidden = kind !== "bugs";
    find("#issueBugStages").hidden = kind !== "bugs";
    if (kind === "bugs")
      find("#issueBugStages").innerHTML = [
        ["all", "全部"],
        ["pending", "待处理"],
        ["release", "已修复待发布"],
        ["fixed", "已修复"],
      ]
        .filter(([value]) => value === "all" || data.bug_stages[value] > 0)
        .map(
          ([value, label]) =>
            `<button type="button"
              data-bug-stage="${value}"
              aria-pressed="${value === bugStage}"
              class="issue-bug-stage ${value === bugStage ? "active" : ""}">
                  ${["release", "fixed"].includes(value) ? statusTag(label) : escape(label)}
                  <span class="issue-bug-stage-count">${data.bug_stages[value]}</span>
              </button>`,
        )
        .join("");
    renderRows();
    const pages = data.page_count;
    find("#issuePageInfo").textContent =
      `第 ${page} / ${pages} 页 · ${kind === "requirements" ? `共 ${data.total_versions} 个版本，每页 ${data.page_size} 个版本` : `每页 ${data.page_size} 条`}`;
    find("#issuePrevious").disabled = page <= 1;
    find("#issueNext").disabled = page >= pages;
  }
  function readUrlFilters(parameters) {
    const urlFilters = {};
    for (const key of urlFilterKeys) {
      if (parameters.has(key)) urlFilters[key] = key === "project" ? parameters.getAll(key) : parameters.get(key);
    }
    const conditions = JSON.parse(parameters.get("condition_filter") || '{"logic":"and","rules":[]}');
    if (parameters.has("include_family") && !["0", "1"].includes(parameters.get("include_family"))) throw new Error("父记录和兄弟元素开关格式不正确");
    if (parameters.has("version_desc") && !["0", "1"].includes(parameters.get("version_desc"))) throw new Error("按版本倒序开关格式不正确");
    if (
      !conditions ||
      !["and", "or"].includes(conditions.logic) ||
      !Array.isArray(conditions.rules) ||
      conditions.rules.length > 50 ||
      conditions.rules.some(
        (rule) =>
          !rule ||
          !conditionFields.includes(rule.field) ||
          !["includes", "excludes"].includes(rule.operator) ||
          !Array.isArray(rule.values) ||
          rule.values.some((value) => typeof value !== "string"),
      )
    ) {
      throw new Error("URL 筛选条件格式不正确");
    }
    return { filters: urlFilters, condition_filter: conditions };
  }
  async function open(nextKind, parameters = new URLSearchParams()) {
    if (!(nextKind in labels)) return;
    attachmentViewer?.destroy();
    attachmentViewer = null;
    autoSyncControl.disabled = true;
    clearTimeout(autoSyncTimer);
    autoSyncTimer = null;
    finishWorkspaceResize();
    const opening = ++openSequence;
    ++sequence;
    clearTimeout(poll);
    clearTimeout(searchTimer);
    const dateFilters =
      !usingUrlFilters && filters.created_from && filters.created_to && filters.created_from <= filters.created_to
        ? { created_from: filters.created_from, created_to: filters.created_to }
        : {};
    if (searchSavePending) {
      searchSavePending = false;
      await savePreferences();
    } else await preferenceQueue;
    if (opening !== openSequence) return;
    kind = nextKind;
    allowStaleCache = true;
    renderAutoSyncControl();
    selectedBugId = "";
    selectedBugs.clear();
    bugSelectionScope = "";
    bugStage = "all";
    bugDetailKey = "";
    find("#issueBugActionStatus").textContent = "";
    find("#issueBugBatchStatus").hidden = true;
    find("#issueBugBatchActions").hidden = true;
    find("#issueBugDiscussionStatus").hidden = true;
    collapsedRequirements.clear();
    collapsedVersions.clear();
    usingUrlFilters = parameters.has("condition_filter") || urlFilterKeys.some((key) => parameters.has(key));
    page = 1;
    data = null;
    find("#issueActionStatus").hidden = true;
    find("#issueContent").hidden = true;
    find("#issueList").hidden = kind === "overview";
    if (find("#issueDetailDialog").open) find("#issueDetailDialog").close();
    if (find("#issueFilterDialog").open) find("#issueFilterDialog").close();
    find("#issueFilterButton").hidden = usingUrlFilters;
    dropdownControls.closeAll();
    form.inert = true;
    form.elements.q.disabled = true;
    find("#issueSyncButton").disabled = true;
    renderTableHeader();
    find("#issueProjectMultiFilter").hidden = kind !== "requirements";
    find("#issueFamilyFilter").hidden = kind !== "requirements";
    find("#issueVersionSort").hidden = kind !== "requirements";
    find("#issueSource").hidden = true;
    document.querySelectorAll("[data-issue-kind]").forEach((button) => button.classList.toggle("active", button.dataset.issueKind === kind));
    const menu = document.querySelector("#issueMenu");
    menu.hidden = false;
    document.querySelector("#issueMenuToggle").setAttribute("aria-expanded", "true");
    try {
      let preferences = null,
        autoSyncError = "";
      try {
        preferences = await request(`/api/issues/preferences/${kind}`);
      } catch (error) {
        if (!usingUrlFilters) throw error;
        autoSyncError = `读取自动同步配置失败：${error.message}`;
      }
      if (opening !== openSequence) return;
      applyAutoSyncPreferences(preferences);
      renderAutoSyncControl();
      autoSyncControl.disabled = !preferences;
      const saved = usingUrlFilters ? readUrlFilters(parameters) : preferences;
      filters = usingUrlFilters ? saved.filters : { q: saved.filters.q || "", include_family: saved.filters.include_family || "0", version_desc: saved.filters.version_desc || "0", ...dateFilters };
      conditionFilter = saved.condition_filter;
      if (kind === "requirements") {
        requirementProjects = usingUrlFilters ? [...(filters.project || [])] : saved.requirement_projects;
        activeRequirementProject = usingUrlFilters ? "" : saved.active_project;
      }
      if (autoSyncError) preferenceError(autoSyncError);
      else find("#issuePreferenceStatus").hidden = true;
    } catch (error) {
      if (opening !== openSequence) return;
      autoSyncSettings[kind] = false;
      autoSyncControl.checked = false;
      autoSyncControl.indeterminate = false;
      autoSyncControl.setAttribute("aria-checked", "false");
      if (usingUrlFilters) {
        find("#issueProjectTabs").hidden = true;
        root.setAttribute("aria-busy", "false");
        preferenceError(`读取 URL 筛选条件失败：${error.message}`);
        return;
      }
      filters = { ...dateFilters };
      conditionFilter = { logic: "and", rules: [] };
      if (kind === "requirements") {
        requirementProjects = [];
        activeRequirementProject = "";
      }
      preferenceError(`读取已保存的筛选条件失败：${error.message}`);
    }
    if (kind === "requirements") applyRequirementProject();
    else if (!usingUrlFilters) delete filters.project;
    for (const control of form.elements) {
      if (!control.name) continue;
      if (control.type === "checkbox") {
        control.checked = filters[control.name] === "1";
        continue;
      }
      const value = Array.isArray(filters[control.name]) ? filters[control.name][0] || "" : filters[control.name] || "";
      if (control.tagName === "SELECT" && value && ![...control.options].some((option) => option.value === value)) control.add(new Option(value, value));
      control.value = value;
    }
    form.inert = false;
    form.elements.q.disabled = false;
    conditionBuilder.set(kind, {}, conditionFilter);
    form.elements.condition_logic.value = conditionFilter.logic;
    dropdownControls.refresh();
    renderProjectOptions();
    renderProjectTabs();
    find("#issueSyncButton").disabled = false;
    load();
    scheduleAutoSync();
  }
  function combineScope(target) {
    const current = conditionFilter.rules.find((rule) => rule.field === "scope" && rule.operator === "includes")?.values[0] || "";
    if (!target || target === "pending") return current || target;
    if (!current || current === "pending") return target;
    return current === target ? current : "urgent_overdue";
  }
  function jump(target, changes, resetFilters = false) {
    const jumpFilters = resetFilters ? { created_from: filters.created_from, created_to: filters.created_to } : { ...filters };
    const conditions = resetFilters ? { logic: "and", rules: [] } : JSON.parse(JSON.stringify(conditionFilter));
    for (const [field, value] of Object.entries(changes)) {
      if (field === "q") jumpFilters.q = value;
      else {
        delete jumpFilters[field];
        conditions.rules = conditions.rules.filter((rule) => rule.field !== field);
        if (value) conditions.rules.push({ field, operator: "includes", values: Array.isArray(value) ? value : [value] });
      }
    }
    const parameters = new URLSearchParams({ condition_filter: JSON.stringify(conditions) });
    for (const [key, value] of Object.entries(jumpFilters)) {
      for (const item of Array.isArray(value) ? value : [value]) {
        if (item !== undefined && item !== null && item !== "") parameters.append(key, item);
      }
    }
    navigate(`${target === "overview" ? "issues" : target}?${parameters}`);
  }
  function detail(id) {
    const row = data?.items.find((item) => item.id === id);
    if (!row) return;
    if (kind === "bugs") {
      selectBug(id);
      return;
    }
    const pairs = [
      ["项目", escape(list(row.project))],
      ["版本", escape(list(row.version))],
      ["状态", statusTag(row.status)],
      ["优先级", badge(row.priority)],
      ["开发人员", escape(names(row.developers))],
      ["创建时间", escape(row.created_at?.replace("T", " ") || "")],
      ["计划完成", date(row.due_at || row.deadline)],
      ["需求层级", row.is_child ? "子需求" : "主需求"],
      ["提测截止日期", testDeadline(row)],
      ["产品", escape(names(row.products))],
      ["测试人员", escape(names(row.testers))],
      ["预计开始", date(row.start_at)],
      ["需求分类", escape(row.category)],
      ["产品文档", safeLink(row.document)],
      ["设计稿", safeLink(row.design)],
      ["设计人员", escape(names(row.designers))],
    ];
    const related =
      row.related
        .map((item) => `<button class="issue-related-link" type="button" data-related-kind="${item.kind}" data-related-id="${escape(item.id)}">${escape(item.title)}</button>`)
        .join("") || '<span class="muted">暂无关联记录</span>';
    find("#issueDetailContent").innerHTML =
      `<div class="issue-detail-title">${recordTitle(row)}</div><small class="muted">${escape(row.id)}</small><dl class="issue-detail-grid">${pairs.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join("")}</dl><h3>关联bug</h3><div class="issue-related">${related}</div><div class="issue-detail-footer">${safeLink(row.source_url, "在飞书打开详情")}</div>`;
    const dialog = find("#issueDetailDialog");
    if (!dialog.open) dialog.showModal();
  }
  async function submitForTesting(id) {
    if (submittingRequirements.size) return;
    const opening = openSequence;
    const actionStatus = find("#issueActionStatus");
    const showStatus = (message, failed = false) => {
      actionStatus.textContent = message;
      actionStatus.classList.toggle("text-danger", failed);
      actionStatus.classList.toggle("text-success", !failed);
      actionStatus.hidden = false;
    };
    submittingRequirements.add(id);
    renderRows();
    find("#issueSyncButton").disabled = true;
    showStatus("正在将父需求及全部子需求提测…");
    try {
      const result = await request(`/api/issues/requirements/${encodeURIComponent(id)}/submit-testing`, { method: "POST" });
      if (opening !== openSequence) return;
      showStatus(result.warning || `提测成功，父需求及子需求共 ${result.updated_count} 条记录已更新为“测试中”。`, Boolean(result.warning));
      await load();
    } catch (error) {
      if (opening !== openSequence) return;
      showStatus(`提测失败：${error.message}`, true);
      await load();
    } finally {
      submittingRequirements.delete(id);
      if (data) {
        renderRows();
        find("#issueSyncButton").disabled = data.sync.syncing || data.sync.submitting;
      }
    }
  }
  form.addEventListener("change", (event) => {
    if (!event.target.name || event.target.name === "q") return;
    if (event.target.name === "condition_logic") return conditionBuilder.setLogic(event.target.value);
    filters[event.target.name] = event.target.type === "checkbox" ? (event.target.checked ? "1" : "0") : event.target.value;
    if (["created_from", "created_to"].includes(event.target.name)) {
      allowStaleCache = false;
      data = null;
      find("#issueContent").hidden = true;
    } else savePreferences();
    page = 1;
    load();
  });
  form.elements.q.addEventListener("input", (event) => {
    filters.q = event.target.value;
    selectedBugs.clear();
    renderBugSelection();
    searchSavePending = true;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchSavePending = false;
      page = 1;
      savePreferences();
      load();
    }, 300);
  });
  find("#issueRecentDates").addEventListener("click", () => {
    allowStaleCache = false;
    delete filters.created_from;
    delete filters.created_to;
    form.elements.created_from.value = "";
    form.elements.created_to.value = "";
    data = null;
    find("#issueContent").hidden = true;
    page = 1;
    load();
  });
  find("#issueReset").addEventListener("click", () => {
    allowStaleCache = false;
    clearTimeout(searchTimer);
    searchSavePending = false;
    filters = {};
    conditionFilter = { logic: "and", rules: [] };
    requirementProjects = [];
    activeRequirementProject = "";
    renderProjectTabs();
    page = 1;
    data = null;
    find("#issueContent").hidden = true;
    form.reset();
    conditionBuilder.set(kind, {}, conditionFilter);
    dropdownControls.refresh();
    renderProjectOptions();
    savePreferences();
    load();
  });
  find("#issuePrevious").addEventListener("click", () => {
    page--;
    load();
  });
  find("#issueNext").addEventListener("click", () => {
    page++;
    load();
  });
  find("#issueAddCondition").addEventListener("click", () => conditionBuilder.add());
  find("#issueFilterButton").addEventListener("click", () => {
    if (!find("#issueFilterDialog").open) find("#issueFilterDialog").showModal();
  });
  find("#issueCloseFilter").addEventListener("click", () => find("#issueFilterDialog").close());
  find("#issueFilterDialog").addEventListener("close", () => dropdownControls.closeAll());
  find("#issueFilterDone").addEventListener("click", () => {
    if (!form.reportValidity()) return;
    if (filters.created_from > filters.created_to) return load();
    find("#issueFilterDialog").close();
  });
  async function syncData(automatic = false) {
    if (syncRequestPending || form.inert || submittingRequirements.size || submittingBug || creatingDiscussion) return;
    if (automatic && (!root.classList.contains("active") || find("#issueSyncButton").disabled || root.getAttribute("aria-busy") === "true")) return;
    if (!form.checkValidity() || filters.created_from > filters.created_to) {
      if (automatic) return;
      if (!find("#issueFilterDialog").open) find("#issueFilterDialog").showModal();
      form.reportValidity();
      return load();
    }
    const current = sequence;
    syncRequestPending = true;
    find("#issueSyncButton").disabled = true;
    try {
      const result = await request(
        "/api/issues/sync?" +
          new URLSearchParams({
            kind,
            created_from: filters.created_from,
            created_to: filters.created_to,
            include_family: kind === "requirements" ? filters.include_family || "0" : "0",
          }),
        { method: "POST" },
      );
      if (current !== sequence) return;
      setStatus(result);
      await load();
    } catch (error) {
      if (current !== sequence) return;
      find("#issueSyncStatus").textContent = `同步失败：${error.message}`;
      find("#issueSyncStatus").classList.add("issue-sync-error");
      find("#issueSyncButton").disabled = false;
    } finally {
      syncRequestPending = false;
    }
  }
  find("#issueSyncButton").addEventListener("click", () => syncData());
  autoSyncControl.addEventListener("change", () => {
    const target = kind,
      opening = openSequence;
    const previous = { ...autoSyncSettings },
      enabled = autoSyncControl.checked;
    autoSyncControl.disabled = true;
    clearTimeout(autoSyncTimer);
    autoSyncTimer = null;
    preferenceQueue = preferenceQueue
      .then(async () => {
        const saved = await request(`/api/issues/preferences/${target}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ auto_sync: enabled }),
        });
        applyAutoSyncPreferences(saved, target);
        if (opening === openSequence && kind === target) {
          renderAutoSyncControl();
          find("#issuePreferenceStatus").hidden = true;
        }
      })
      .catch((error) => {
        Object.assign(autoSyncSettings, previous);
        if (opening === openSequence && kind === target) {
          renderAutoSyncControl();
          preferenceError(`自动同步配置保存失败：${error.message}`);
        }
      })
      .finally(() => {
        if (opening === openSequence && kind === target) {
          autoSyncControl.disabled = false;
          scheduleAutoSync();
        }
      });
  });
  find("#issueCloseDetail").addEventListener("click", () => find("#issueDetailDialog").close());
  find("#issueBugSkip").addEventListener("click", nextBug);
  find("#issueBugDetail").addEventListener(
    "error",
    (event) => {
      if (!event.target.matches("[data-attachment-media]")) return;
      event.target.hidden = true;
      event.target.closest(".issue-media").querySelector("[data-attachment-error]").hidden = false;
    },
    true,
  );
  root.addEventListener("change", (event) => {
    const checkbox = event.target;
    if (!checkbox.matches("[data-bug-check], [data-bug-select-all]") || checkbox.disabled || kind !== "bugs" || !data) return;
    const ids = checkbox.hasAttribute("data-bug-select-all") ? data.items.map((row) => row.id) : [checkbox.dataset.bugCheck];
    for (const id of ids) {
      if (checkbox.checked) selectedBugs.add(id);
      else selectedBugs.delete(id);
    }
    find("#issueBugBatchStatus").hidden = true;
    renderBugSelection();
  });
  root.addEventListener("click", (event) => {
    if (event.target.closest("[data-bug-check], [data-bug-select-all]")) return;
    const title = event.target.closest("[data-detail]");
    if (title) {
      if (title.tagName === "A" && (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0)) return;
      event.preventDefault();
      detail(title.dataset.detail);
      return;
    }
    const submission = event.target.closest("[data-submit-requirement]");
    if (submission) {
      event.preventDefault();
      if (submission.getAttribute("aria-disabled") !== "true") submitForTesting(submission.dataset.submitRequirement);
      return;
    }
    const button = event.target.closest("button");
    const bugRow = event.target.closest("[data-select-bug]");
    if (bugRow && !event.target.closest("a, button")) {
      selectBug(bugRow.dataset.selectBug);
      return;
    }
    if (!button) return;
    if (button.hasAttribute("data-preview-image")) {
      previewAttachment(button);
      return;
    }
    if (button.hasAttribute("data-copy-bug-title")) {
      copyBugTitle(button);
      return;
    }
    if (button.hasAttribute("data-create-bug-discussion")) {
      createBugDiscussion();
      return;
    }
    if (button.hasAttribute("data-retry-attachment")) {
      const card = button.closest(".issue-media");
      const media = card.querySelector("[data-attachment-media]");
      const source = new URL(media.src);
      source.searchParams.set("retry", String(Date.now()));
      card.querySelector("[data-attachment-error]").hidden = true;
      media.hidden = false;
      media.src = source.href;
      if (media.tagName === "VIDEO") media.load();
      return;
    }
    if (button.hasAttribute("data-bug-batch-status")) {
      updateSelectedBugStatuses(button.dataset.bugBatchStatus);
      return;
    }
    if (button.hasAttribute("data-bug-status")) {
      updateBugStatus(button.dataset.bugStatus);
      return;
    }
    if (button.hasAttribute("data-bug-stage")) {
      if (bugStage === button.dataset.bugStage || submittingBug || creatingDiscussion) return;
      bugStage = button.dataset.bugStage;
      page = 1;
      selectedBugId = "";
      find("#issueBugActionStatus").textContent = "";
      return load();
    }
    if (button.hasAttribute("data-toggle-requirement")) {
      const id = button.dataset.toggleRequirement;
      if (collapsedRequirements.has(id)) collapsedRequirements.delete(id);
      else collapsedRequirements.add(id);
      renderRows();
      [...root.querySelectorAll("[data-toggle-requirement]")].find((toggle) => toggle.dataset.toggleRequirement === id)?.focus();
      return;
    }
    if (button.hasAttribute("data-requirement-project")) {
      const project = button.dataset.requirementProject;
      requirementProjects = requirementProjects.includes(project) ? requirementProjects.filter((value) => value !== project) : [...requirementProjects, project];
      if (!requirementProjects.includes(activeRequirementProject)) activeRequirementProject = "";
      applyRequirementProject();
      savePreferences();
      renderProjectOptions();
      renderProjectTabs();
      [...find("#issueProjectChoices").querySelectorAll("button")].find((option) => option.dataset.requirementProject === project)?.focus();
      find("#issueContent").hidden = true;
      page = 1;
      return load();
    }
    if (button.hasAttribute("data-requirement-project-tab")) {
      activeRequirementProject = button.dataset.requirementProjectTab;
      applyRequirementProject();
      savePreferences();
      renderProjectTabs();
      page = 1;
      find("#issueContent").hidden = true;
      return load();
    }
    if (button.dataset.jump) jump(button.dataset.jump, { scope: combineScope(button.dataset.scope) });
    if (button.dataset.chartKind)
      jump(button.dataset.chartKind, {
        [button.dataset.chartField]: button.dataset.chartValue,
        ...(button.dataset.chartField === "project" ? { scope: combineScope("pending") } : {}),
      });
    if (button.dataset.relatedId) {
      find("#issueDetailDialog").close();
      jump(button.dataset.relatedKind, { q: button.dataset.relatedId }, true);
    }
  });
  root.addEventListener("keydown", (event) => {
    const submission = event.target.closest("[data-submit-requirement]");
    if (submission && event.key === " ") {
      event.preventDefault();
      if (submission.getAttribute("aria-disabled") !== "true") submission.click();
    }
  });
  find("#issueProjectTabs").addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tabs = [...find("#issueProjectTabs").querySelectorAll('[role="tab"]')];
    const index = tabs.indexOf(document.activeElement);
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next].click();
    find('#issueProjectTabs [aria-selected="true"]')?.focus();
  });
  return { open };
})();
