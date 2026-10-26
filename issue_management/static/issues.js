/* Issue workspace; the host calls IssueManagement.open(kind, parameters). */
window.IssueManagement = (() => {
  const root = document.querySelector("#issues-page");
  const find = selector => root.querySelector(selector);
  const form = find("#issueFilters");
  const escape = ReleaseLite.escapeHtml;
  const labels = {
    overview: "需求与 Bug 管理",
    requirements: "需求管理",
    bugs: "Bug 管理"
  };
  const autoSyncControl = find("#issueAutoSync");
  const notificationControl = find("#issueBugNotifications");
  const bugNotifications = BugNotifications.create(notificationControl, () => {
    if (data) observeBugNotifications(data);
  });
  const autoSyncInterval = 60 * 1000;
  const autoSyncSettings = {
    overview: false,
    requirements: false,
    bugs: false
  };
  let autoSyncTimer = null,
    syncRequestPending = false;
  let filterSyncPending = false,
    latestSyncStatus = null;
  let kind = "overview",
    filters = {},
    page = 1,
    data = null,
    sequence = 0,
    poll = null,
    searchTimer = null;
  let requirementProjects = [],
    activeRequirementProject = "";
  let conditionFilter = {
    logic: "and",
    rules: []
  };
  let preferenceQueue = Promise.resolve(),
    searchSavePending = false,
    openSequence = 0;
  let usingUrlFilters = false;
  let allowStaleCache = false;
  let overviewParameters = "";
  let selectedBugId = "",
    bugStage = "all",
    submittingBug = null,
    bugDetailKey = "";
  let creatingDiscussion = "";
  let savingRequirementPriority = false;
  const selectedBugs = new Set();
  let bugSelectionScope = "";
  let attachmentViewer = null;
  const collapsedRequirements = new Set();
  const collapsedVersions = new Set();
  const submittingRequirements = new Set();
  let submittingRequirementStatus = "";
  const selectedRequirements = new Set();
  const canSubmitRequirement = row => row.can_submit_testing === true;
  let requirementSelectionScope = "";
  const preferenceKeys = ["q", "include_family", "sort_by", "sort_order"];
  const conditionFields = ["project", "version", "person", "status", "priority", "environment", "hierarchy", "scope"];
  const urlFilterKeys = [
    "q",
    "created_from",
    "created_to",
    "include_family",
    "version_desc",
    "sort_by",
    "sort_order",
    "dashboard_scope",
    "test_date",
    ...conditionFields
  ];
  const workspace = find("#issueWorkspace");
  const workspaceResizer = find("#issueWorkspaceResizer");
  const workspaceRatioKey = "release-lite-bug-workspace-ratio";
  const defaultWorkspaceRatio = 100 * 1.05 / 2.05;
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
    const minimum = width > 0 ? Math.max(25, Math.min(50, 320 / width * 100)) : 25;
    return {
      width,
      minimum,
      maximum: 100 - minimum
    };
  }
  function applyWorkspaceRatio() {
    const {
      minimum,
      maximum
    } = workspaceBounds();
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
    const {
      pointerId
    } = workspaceDrag;
    workspaceDrag = null;
    workspaceResizer.classList.remove("is-dragging");
    document.body.classList.remove("issue-workspace-resizing");
    if (workspaceResizer.hasPointerCapture(pointerId)) workspaceResizer.releasePointerCapture(pointerId);
    saveWorkspaceRatio();
  }
  workspaceResizer.addEventListener(
    "pointerdown",
    event => {
    if (event.button !== 0 || !event.isPrimary || !workspaceDesktop.matches || workspaceDrag) return;
    event.preventDefault();
    workspaceDrag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      ratio: applyWorkspaceRatio()
    };
    workspaceResizer.setPointerCapture(event.pointerId);
    workspaceResizer.focus({
      preventScroll: true
    });
    workspaceResizer.classList.add("is-dragging");
    document.body.classList.add("issue-workspace-resizing");
  }
  );
  workspaceResizer.addEventListener(
    "pointermove",
    event => {
    if (!workspaceDrag || event.pointerId !== workspaceDrag.pointerId) return;
    const {
      width,
      minimum,
      maximum
    } = workspaceBounds();
    if (width <= 0) return;
    workspaceRatio = Math.max(minimum, Math.min(maximum, workspaceDrag.ratio + (event.clientX - workspaceDrag.startX) / width * 100));
    applyWorkspaceRatio();
  }
  );
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
    workspaceResizer.addEventListener(type, event => {
      if (event.pointerId === workspaceDrag?.pointerId) finishWorkspaceResize();
    });
  }
  workspaceResizer.addEventListener(
    "keydown",
    event => {
    if (!workspaceDesktop.matches || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const ratio = applyWorkspaceRatio();
    const {
      minimum,
      maximum
    } = workspaceBounds();
    workspaceRatio = event.key === "Home" ? minimum : event.key === "End" ? maximum : Math.max(minimum, Math.min(maximum, ratio + (event.key === "ArrowLeft" ? -2 : 2)));
    applyWorkspaceRatio();
    saveWorkspaceRatio();
  }
  );
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
  const conditionBuilder = IssueConditionBuilder.create(
    find("#issueConditionRows"),
    value => {
    conditionFilter = value;
    form.elements.condition_logic.value = value.logic;
    dropdownControls.refresh();
    page = 1;
    savePreferences();
    load(true);
  }
  );
  const date = value => value ? escape(value.slice(0, 10)) : "";
  const names = people => (people || []).map(person => person.name || person.id).join("、");
  const list = values => values?.length ? values.join("、") : "";
  const badge = (value, tone = "") => value ? `<span class="issue-badge ${tone}">${escape(value)}</span>` : "";
  const priorityStyle = value => ReleaseLite.priorityStyle(data?.requirement_priority_colors?.[value]);
  const priorityBadge = (value, label = value) => value ? `<span class="issue-badge issue-priority-tag" data-priority="${escape(value)}" style="${priorityStyle(value)}">${escape(label)}</span>` : "";
  const statusTag = value => value ? `<span class="issue-status-tag" data-status="${escape(value)}">${escape(value)}</span>` : "";
  const testDeadline = row => row.test_deadline ? `<span class="issue-test-deadline" data-tone="${escape(row.test_deadline_tone || "")}">${date(row.test_deadline)}</span>` : "";
  function recordTitle(row) {
    const raw = String(row.title || "无标题").trim();
    const markdown = raw.match(/^\[([\s\S]*)\]\((https?:\/\/[^\s]+)\)$/);
    const title = markdown?.[1] || raw;
    try {
      const url = new URL(markdown?.[2] || row.source_url);
      if (["http:", "https:"].includes(url.protocol)) {
        return `<a class="issue-title-link" href="${escape(url.href)}" target="_blank" rel="noopener noreferrer" data-detail="${escape(row.id)}" title="查看详情 · Ctrl / ⌘ + 点击打开链接">${escape(title)}</a>`;
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
    return (row.attachments || []).filter(item => ["image", "video"].includes(item.media_kind) && item.preview_url).map(item => {
      const source = escape(item.preview_url),
        name = escape(item.name || "附件");
      const preview = item.media_kind === "image" ?
        `<button class="issue-media-image" type="button" data-preview-image aria-label="预览图片：${name}"><img src="${source}" alt="${name}" loading="lazy" decoding="async" data-attachment-media></button>` :
        `<video src="${source}" controls playsinline preload="none" aria-label="${name}" data-attachment-media>浏览器不支持播放此视频。</video>`;
      return `<figure class="issue-media">${preview}<figcaption>` +
        `<i class="bi bi-${item.media_kind === "image" ? "image" : "play-circle"}" aria-hidden="true"></i>` +
        `<span>${name}</span>${item.media_kind === "image" ? '<small class="muted">预览图片</small>' : ""}</figcaption>` +
        `<div class="issue-media-error" data-attachment-error hidden><p>附件无法显示，请重试或在飞书查看</p>` +
        `<button type="button" class="btn btn-outline-secondary btn-sm" data-retry-attachment>重试` +
        `</button> ${safeLink(row.source_url, "在飞书查看")}</div></figure>`;
    }).join("") || '<span class="muted">暂无图片或视频附件</span>';
  }
  function previewAttachment(button) {
    if (typeof window.Viewer !== "function") {
      toast("图片预览不可用，请刷新页面", "error");
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
      toolbar: {
        zoomIn: true,
        zoomOut: true,
        oneToOne: true,
        reset: true,
        prev: true,
        next: true,
        rotateLeft: true,
        rotateRight: true
      },
      hidden() {
        viewer.destroy();
        if (attachmentViewer === viewer) attachmentViewer = null;
        if (button.isConnected) button.focus({
          preventScroll: true
        });
      }
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
      filters: Object.fromEntries(preferenceKeys.filter(key => filters[key] !== undefined).map(key => [key, Array.isArray(filters[key]) ? [...filters[key]] : filters[key]])),
      condition_filter: JSON.parse(JSON.stringify(conditionFilter)),
      requirement_projects: target === "requirements" ? [...requirementProjects] : [],
      active_project: target === "requirements" ? activeRequirementProject : ""
    };
    preferenceQueue = preferenceQueue.then(async () => {
      await request(
        `/api/issues/preferences/${target}`,
        {
        method: "PUT",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      }
      );
      if (kind === target) find("#issuePreferenceStatus").hidden = true;
    }).catch(error => preferenceError(`${labels[target]}筛选保存失败：${error.message}`));
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
    autoSyncTimer = setTimeout(
      async () => {
      autoSyncTimer = null;
      if (kind !== target || opening !== openSequence || !autoSyncSettings[target]) return;
      try {
        await syncData(true);
      } finally {
        if (kind === target && opening === openSequence && autoSyncSettings[target]) scheduleAutoSync();
      }
    },
      autoSyncInterval
    );
  }
  function setStatus(sync) {
    latestSyncStatus = sync;
    const status = find("#issueSyncStatus");
    const range = sync.date_range;
    if (range) {
      for (const key of ["created_from", "created_to"]) {
        filters[key] = range[key];
        if (document.activeElement !== form.elements[key]) form.elements[key].value = range[key];
      }
    }
    const stamp = sync.updated_at ? `更新于 ${sync.updated_at.replace("T", " ").replace(/\+08:00$/, "")}` : "尚未同步";
    const cacheNote = sync.stale ? "数据未完整同步" : "";
    status.classList.toggle("issue-sync-error", Boolean(sync.error));
    status.textContent = [
      sync.error || (sync.syncing ? sync.progress || "同步中…" : ""),
      cacheNote,
      sync.error && sync.ready ? "显示上次同步数据" : "",
      stamp,
    ].filter(Boolean).join(" · ");
    find("#issueSyncButton").disabled = sync.syncing || sync.submitting || submittingRequirements.size > 0 || Boolean(submittingBug || creatingDiscussion);
    find("#issueSyncButton").textContent = sync.syncing ? "同步中…" : "同步数据";
  }
  function observeBugNotifications(result) {
    const parameters = new URLSearchParams({ condition_filter: JSON.stringify(conditionFilter) });
    for (const [key, value] of Object.entries(filters).sort(([left], [right]) => left.localeCompare(right))) {
      for (const item of Array.isArray(value) ? value : [value]) {
        if (item !== undefined && item !== null && item !== "") parameters.append(key, item);
      }
    }
    if (kind === "bugs") parameters.set("bug_stage", bugStage);
    const scope = `${kind}?${parameters}`;
    bugNotifications.observe(result.bug_notifications, scope, result.sync, autoSyncSettings[kind], (id) => {
      const target = id ? new URLSearchParams({
        created_from: parameters.get("created_from"),
        created_to: parameters.get("created_to"),
        q: id,
        condition_filter: JSON.stringify({ logic: "and", rules: [] }),
      }) : new URLSearchParams(parameters);
      navigate(`bugs?${target}`);
    });
  }
  function flushFilterSync() {
    if (!filterSyncPending || !latestSyncStatus || latestSyncStatus.syncing || latestSyncStatus.submitting || syncRequestPending || form.inert || submittingRequirements.size || submittingBug || creatingDiscussion || root.getAttribute("aria-busy") === "true" || !root.classList.contains("active")) return;
    if (!form.checkValidity() || filters.created_from > filters.created_to) return;
    filterSyncPending = false;
    syncData(false, true);
  }
  async function load(syncFilters = false) {
    if (syncFilters === true) {
      filterSyncPending = true;
      bugNotifications.beginSync(null, false);
    }
    clearTimeout(poll);
    const current = ++sequence;
    const selectionScope = bugSelectionKey();
    if (selectionScope !== bugSelectionScope) selectedBugs.clear();
    bugSelectionScope = selectionScope;
    if (selectionScope !== requirementSelectionScope) selectedRequirements.clear();
    requirementSelectionScope = selectionScope;
    if (filters.created_from !== undefined && (!filters.created_from || !filters.created_to || filters.created_from > filters.created_to)) {
      root.setAttribute("aria-busy", "false");
      find("#issueContent").hidden = true;
      find("#issueSyncStatus").textContent = "请选择完整日期，开始日期须不晚于结束日期";
      find("#issueSyncStatus").classList.add("issue-sync-error");
      find("#issueFilterError").textContent = "请选择完整日期，开始日期须不晚于结束日期";
      find("#issueFilterError").hidden = false;
      renderRequirementSelection();
      return;
    }
    find("#issueFilterError").hidden = true;
    root.setAttribute("aria-busy", "true");
    renderBugSelection();
    renderRequirementSelection();
    let receivedStatus = false;
    try {
      const parameters = new URLSearchParams({
        kind,
        page
      });
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
      receivedStatus = true;
      if (kind === "overview") overviewParameters = currentOverviewParameters();
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
        if (kind === "requirements") {
          filters.sort_by = result.sort_by;
          filters.sort_order = result.sort_order;
        }
        page = result.page;
        bugSelectionScope = bugSelectionKey();
        if (requirementSelectionScope !== bugSelectionKey()) selectedRequirements.clear();
        requirementSelectionScope = bugSelectionKey();
        render();
        observeBugNotifications(result);
      } else {
        data = null;
        find("#issueContent").hidden = true;
      }
      if (result.sync.syncing || result.sync.submitting) poll = setTimeout(load, 1000);
    } catch (error) {
      if (current !== sequence) return;
      find("#issueSyncStatus").textContent = `加载失败：${error.message}`;
      find("#issueSyncStatus").classList.add("issue-sync-error");
      find("#issueSyncButton").disabled = false;
      find("#issueSyncButton").textContent = "同步数据";
    } finally {
      if (current === sequence) {
        root.setAttribute("aria-busy", "false");
        renderBugSelection();
        renderRequirementSelection();
        if (receivedStatus) flushFilterSync();
      }
    }
  }
  function renderFilters() {
    form.elements.condition_logic.value = conditionFilter.logic;
    form.elements.include_family.checked = filters.include_family === "1";
    form.elements.sort_by.value = filters.sort_by || "version";
    form.elements.sort_order.value = filters.sort_order || "asc";
    if (document.activeElement !== form.elements.q) form.elements.q.value = filters.q || "";
    conditionBuilder.updateOptions(data.options);
    if (kind === "requirements") renderProjectOptions();
    dropdownControls.refresh();
    renderProjectTabs();
  }
  function renderProjectOptions() {
    const projects = [...new Set(["__empty__", ...(data?.options.project || []), ...requirementProjects])];
    const query = find("#issueProjectSearch").value.trim().toLocaleLowerCase();
    const html = projects.filter(project => (project === "__empty__" ? "未填写" : project).toLocaleLowerCase().includes(query)).map(project => `<button type="button" class="issue-project-option" role="option" aria-selected="${requirementProjects.includes(project)}" data-requirement-project="${escape(project)}">` +
      `<span>${escape(project === "__empty__" ? "未填写" : project)}</span>` +
      `<i class="bi bi-check2" aria-hidden="true"></i>` +
      `</button>`).join("") || '<span class="issue-dropdown-empty">无匹配项目</span>';
    if (find("#issueProjectChoices").innerHTML !== html) find("#issueProjectChoices").innerHTML = html;
    const selectedText = requirementProjects.map(project => project === "__empty__" ? "未填写" : project).join("、") || "全部项目";
    find("#issueProjectSelectedText").textContent = selectedText;
    find("#issueProjectSelectedText").title = selectedText;
  }
  function applyRequirementProject() {
    if (activeRequirementProject) filters.project = activeRequirementProject;else if (requirementProjects.length) filters.project = [...requirementProjects];else delete filters.project;
  }
  function renderProjectTabs() {
    const tabs = find("#issueProjectTabs");
    tabs.hidden = kind !== "requirements";
    if (tabs.hidden) return;
    const projects = ["", ...requirementProjects];
    tabs.innerHTML = projects.map(project => `<button type="button" class="issue-project-tab ${project === activeRequirementProject ? "active" : ""}" role="tab" aria-selected="${project === activeRequirementProject}" aria-controls="issueContent" tabindex="${project === activeRequirementProject ? 0 : -1}" data-requirement-project-tab="${escape(project)}">${escape(project === "" ? "全部" : project === "__empty__" ? "未填写" : project)}</button>`).join("");
  }
  function tableHeader() {
    const columns = kind === "requirements" ? ["标题", filters.sort_by === "priority" ? "版本" : "优先级", "状态", "开发人员", "提测截止日期", "产品", "测试人员", "设计", "群聊"] : ["标题 / 项目", "状态", "优先级", "处理人"];
    return columns.map((label, index) => `<th>${kind === "bugs" && index === 0 ?
      `<label class="issue-bug-title-heading"><input class="issue-bug-checkbox" type="checkbox" data-bug-select-all aria-label="全选当前页 Bug"><span>${label}</span></label>` :
      label}</th>`).join("");
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
    const count = rows.filter(row => selectedBugs.has(row.id)).length;
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
  function renderRequirementSelection() {
    const rows = kind === "requirements" ? data?.items || [] : [];
    const count = rows.filter(row => selectedRequirements.has(row.id)).length;
    const busy = Boolean(!data || searchSavePending || submittingRequirements.size || creatingDiscussion || data.sync.syncing || data.sync.submitting || root.getAttribute("aria-busy") === "true");
    for (const button of root.querySelectorAll("[data-requirement-status]")) {
      const status = button.dataset.requirementStatus;
      const label = status === "测试中" ? "提测" : status;
      button.hidden = kind !== "requirements" || count === 0;
      button.disabled = busy || count === 0 || !form.checkValidity() || filters.created_from > filters.created_to;
      button.textContent = submittingRequirements.size && submittingRequirementStatus === status ? status === "测试中" ? "提测中…" : "更新中…" : count ? `${label} (${count})` : label;
    }
    for (const checkbox of root.querySelectorAll("[data-requirement-check]")) {
      checkbox.checked = selectedRequirements.has(checkbox.dataset.requirementCheck);
      checkbox.indeterminate = false;
      checkbox.disabled = busy;
      checkbox.closest("tr").classList.toggle("issue-requirement-checked", checkbox.checked);
    }
    for (const checkbox of root.querySelectorAll("[data-version-check]")) {
      const versionRows = rows.filter(row => row.version_group === checkbox.dataset.versionCheck);
      const selectedCount = versionRows.filter(row => selectedRequirements.has(row.id)).length;
      checkbox.checked = versionRows.length > 0 && selectedCount === versionRows.length;
      checkbox.indeterminate = selectedCount > 0 && selectedCount < versionRows.length;
      checkbox.disabled = busy || versionRows.length === 0;
    }
    for (const container of root.querySelectorAll("[data-requirement-discussion]")) {
      const row = rows.find(item => item.id === container.dataset.requirementDiscussion);
      if (!row) continue;
      const chat = row.discussion;
      const link = chat ?
        `<a class="issue-discussion-link" href="${escape(chat.url)}" target="_blank" rel="noopener noreferrer" title="${escape(chat.name)}"><i class="bi bi-chat-dots" aria-hidden="true"></i>打开群聊<i class="bi bi-box-arrow-up-right" aria-hidden="true"></i></a>` :
        "";
      const label = creatingDiscussion === row.id ? "创建中…" : row.discussion_creation_pending ? "建群待确认" : row.discussion_needs_link ? "重试关联" : "创建群聊";
      const action = !chat || row.discussion_needs_link ?
        `<button class="btn btn-outline-primary btn-sm" type="button" data-create-requirement-discussion="${escape(row.id)}" ${busy || row.discussion_creation_pending ? "disabled" : ""} title="${row.discussion_creation_pending ? "请在飞书确认并关联群聊后同步" : "邀请主需求及子需求的产品、开发、测试、设计人员"}">${label}</button>` :
        "";
      const html = link + action;
      if (container.innerHTML !== html) container.innerHTML = html;
    }
    if (kind === "requirements" && data) {
      find("#issuePrevious").disabled = busy || page <= 1;
      find("#issueNext").disabled = busy || page >= data.page_count;
    }
  }
  function bugRowHtml(row) {
    return `<tr data-select-bug="${escape(row.id)}" class="${row.id === selectedBugId ? "issue-bug-selected" : ""}">` +
      `<td>` +
      `<div class="issue-bug-row-heading">` +
      `<input class="issue-bug-checkbox" type="checkbox" data-bug-check="${escape(row.id)}" aria-label="选择 Bug：${escape(row.title || row.id)}" ${selectedBugs.has(row.id) ? "checked" : ""}>` +
      `<div class="issue-bug-row-content">` +
      `<div class="issue-bug-row-title">${recordTitle(row)}</div>` +
      `<small class="muted issue-bug-row-meta">${escape([list(row.project), list(row.version)].filter(Boolean).join(" · ") || "未填写项目 / 版本")}${row.overdue ? ' <span class="text-danger">逾期</span>' : ""}</small>` +
      `</div>` +
      `</div></td>` +
      `<td>${statusTag(row.status) || '<span class="muted">未填写</span>'}</td>` +
      `<td>${badge(row.priority, ["紧急", "高"].includes(row.priority) ? "red" : "")}</td>` +
      `<td>${escape(names(row.owners)) || '<span class="muted">未分配</span>'}</td>` +
      `</tr>`;
  }
  function rowHtml(row) {
    if (row.kind === "bugs") {
      return bugRowHtml(row);
    }
    const hasChildren = row.tree_child_count > 0;
    const collapsed = collapsedRequirements.has(row.id);
    const hidden = (row.tree_ancestors || []).some(id => collapsedRequirements.has(id));
    const toggle = hasChildren ?
      `<button type="button" class="issue-tree-toggle" data-toggle-requirement="${escape(row.id)}" aria-expanded="${!collapsed}" aria-label="${collapsed ? "展开" : "收起"}子需求"><i class="bi bi-chevron-${collapsed ? "right" : "down"}" aria-hidden="true"></i></button>` :
      '<span class="issue-tree-spacer" aria-hidden="true"></span>';
    const title = `${recordTitle(row)}${row.filter_match === false ? '<span class="issue-context-label">关联需求</span>' : ""}`;
    const priority = priorityBadge(row.priority);
    const cells = [
      filters.sort_by === "priority" ? escape(list(row.version)) : priority,
      statusTag(row.status),
      escape(names(row.developers)),
      testDeadline(row),
      escape(names(row.products)),
      escape(names(row.testers)),
      `<div class="issue-design-cell">${row.designers?.length ? `<span>${escape(names(row.designers))}</span>` : ""}${safeLink(row.design, "打开设计稿")}</div>`,
      !row.is_child ? `<div class="issue-requirement-discussion" data-requirement-discussion="${escape(row.id)}"></div>` : ""
    ];
    return `<tr${hidden ? " hidden" : ""}>` +
      `<td>` +
      `<div class="issue-requirement-row-heading">` +
      `<input class="issue-requirement-checkbox" type="checkbox" data-requirement-check="${escape(row.id)}" aria-label="选择需求：${escape(row.title || row.id)}">` +
      `<div class="issue-record-heading" style="--issue-depth:${row.tree_depth || 0}">${toggle}<div>${title}</div>` +
      `</div>` +
      `</div></td>${cells.map(cell => `<td>${cell}</td>`).join("")}</tr>`;
  }
  function requirementGroupHtml(group, rowsByVersion) {
    const count = `共 ${group.matched_total} 条`;
    const groupName = filters.sort_by === "priority" ? priorityBadge(group.key.slice("priority:".length), group.name) || escape(group.name) : escape(group.name);
    return `<details class="issue-version-group" data-version-group="${escape(group.key)}" ${collapsedVersions.has(group.key) ? "" : "open"}>` +
      `<summary>` +
      `<input class="issue-requirement-checkbox issue-version-checkbox" type="checkbox" data-version-check="${escape(group.key)}" aria-label="选择该分组全部需求：${escape(group.name)}">` +
      `<i class="bi bi-chevron-right" aria-hidden="true"></i>` +
      `<span class="issue-version-name">${groupName}</span>` +
      `<span class="muted issue-version-count">${count}</span>` +
      `</summary>` +
      `<div class="table-responsive">` +
      `<table class="table align-middle mb-0 issue-table" data-kind="requirements">` +
      `<thead>` +
      `<tr>${tableHeader()}</tr>` +
      `</thead>` +
      `<tbody>${rowsByVersion.get(group.key).map(rowHtml).join("")}</tbody>` +
      `</table>` +
      `</div>` +
      `</details>`;
  }
  function renderRows() {
    const versionLists = find("#issueVersionLists");
    const grouped = kind === "requirements";
    versionLists.hidden = !grouped;
    find("#issueFlatList").hidden = grouped;
    if (grouped) {
      for (const id of selectedRequirements) if (!data.items.some(row => row.id === id)) selectedRequirements.delete(id);
      const rowsByVersion = new Map(data.version_groups.map(group => [group.key, []]));
      for (const row of data.items) rowsByVersion.get(row.version_group).push(row);
      versionLists.innerHTML = data.version_groups.length ? data.version_groups.map(group => requirementGroupHtml(group, rowsByVersion)).join("") : '<p class="empty-row">无匹配记录</p>';
      for (const details of versionLists.querySelectorAll("[data-version-group]")) {
        details.addEventListener(
          "toggle",
          () => {
          if (!details.isConnected) return;
          if (details.open) collapsedVersions.delete(details.dataset.versionGroup);else collapsedVersions.add(details.dataset.versionGroup);
        }
        );
      }
      renderRequirementSelection();
      return;
    }
    if (kind === "bugs") {
      for (const id of selectedBugs) if (!data.items.some(row => row.id === id)) selectedBugs.delete(id);
      if (!data.items.some(row => row.id === selectedBugId)) selectedBugId = data.items[0]?.id || "";
    }
    find("#issueRows").innerHTML = data.items.length ? data.items.map(rowHtml).join("") : '<tr><td colspan="4" class="empty-row">无匹配记录</td></tr>';
    if (kind === "bugs") renderBugDesk();
  }
  function selectBug(id) {
    if (id === selectedBugId || !data?.items.some(row => row.id === id)) return;
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
    const link = chat ?
      `<a class="issue-discussion-link" href="${escape(chat.url)}" target="_blank" rel="noopener noreferrer" title="在飞书打开：${escape(chat.name)}">` +
      `<i class="bi bi-chat-dots" aria-hidden="true"></i>` +
      `<span>${escape(chat.name)}</span>` +
      `<i class="bi bi-box-arrow-up-right" aria-hidden="true"></i></a>` :
      "";
    const label = creatingDiscussion === row.id ? "处理中…" : row.discussion_creation_pending ? "建群待确认" : row.discussion_needs_link ? "重试关联" : "创建群聊";
    const button = !chat || row.discussion_needs_link ?
      `<button class="btn btn-outline-primary btn-sm" type="button" data-create-bug-discussion ${busy || row.discussion_creation_pending ? "disabled" : ""} title="${row.discussion_creation_pending ? "请在飞书确认并关联群聊后同步" : "邀请你、创建人和处理人"}">${label}</button>` :
      "";
    const html = link + button;
    if (container.innerHTML !== html) container.innerHTML = html;
  }
  async function createRequirementDiscussion(id) {
    const row = data?.items.find(item => item.id === id);
    if (kind !== "requirements" || !row || row.is_child || creatingDiscussion || submittingRequirements.size || submittingBug || searchSavePending || data.sync.syncing || data.sync.submitting || root.getAttribute("aria-busy") === "true" || row.discussion_creation_pending || row.discussion && !row.discussion_needs_link) return;
    const opening = openSequence;
    const showStatus = (message, failed = false) => {
      const element = find("#issueActionStatus");
      element.textContent = message;
      element.classList.toggle("text-danger", failed);
      element.classList.toggle("text-success", !failed);
      element.hidden = false;
    };
    creatingDiscussion = row.id;
    form.inert = true;
    form.elements.q.disabled = true;
    renderRequirementSelection();
    find("#issueSyncButton").disabled = true;
    showStatus(row.discussion_needs_link ? "正在关联群聊…" : "正在创建群聊…");
    try {
      const result = await request(`/api/issues/requirements/${encodeURIComponent(row.id)}/discussion`, {
        method: "POST"
      });
      if (opening !== openSequence) return;
      const current = data?.items.find(item => item.id === row.id);
      if (current) Object.assign(current, {
        discussion: result.discussion,
        discussion_needs_link: false,
        discussion_creation_pending: false
      });
      showStatus(result.warning || "群聊已就绪", Boolean(result.warning));
      renderRequirementSelection();
      await load();
    } catch (error) {
      if (opening !== openSequence) return;
      showStatus(`建群或关联失败：${error.message}`, true);
      await load();
    } finally {
      creatingDiscussion = "";
      if (opening === openSequence) {
        form.inert = false;
        form.elements.q.disabled = false;
        renderRequirementSelection();
        if (data) setStatus(data.sync);
      }
    }
  }
  async function createBugDiscussion() {
    const row = data?.items.find(item => item.id === selectedBugId);
    if (kind !== "bugs" || !row || creatingDiscussion || submittingBug || data.sync.syncing || data.sync.submitting || row.discussion_creation_pending || row.discussion && !row.discussion_needs_link) return;
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
    showStatus(row.discussion_needs_link ? "正在关联群聊…" : "正在创建群聊…");
    try {
      const result = await request(`/api/issues/bugs/${encodeURIComponent(row.id)}/discussion`, {
        method: "POST"
      });
      if (opening !== openSequence) return;
      const current = data?.items.find(item => item.id === row.id);
      if (current) Object.assign(current, {
        discussion: result.discussion,
        discussion_needs_link: false,
        discussion_creation_pending: false
      });
      showStatus(result.warning || "群聊已就绪", Boolean(result.warning));
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
  function bugDeskContent(row) {
    const title = String(row.title || "无标题").replace(/^\[([\s\S]*)\]\(https?:\/\/[^\s]+\)$/, "$1");
    const pairs = [
      ["项目", escape(list(row.project))],
      ["版本", escape(list(row.version))],
      ["处理人", escape(names(row.owners))],
      ["创建人", escape(names(row.creators))],
      ["发现环境", escape(row.environment)]
    ];
    const related = (row.related || []).map(item => `<button class="issue-related-link" type="button" data-related-kind="${escape(item.kind)}" data-related-id="${escape(item.id)}">${escape(item.title)}</button>`).join("") || '<span class="muted">暂无关联需求</span>';
    const attachments = mediaAttachments(row);
    return `<div class="issue-desk-tags">${statusTag(row.status) || badge("状态未填")}${badge(row.priority, ["紧急", "高"].includes(row.priority) ? "red" : "")}${row.overdue ? badge("已逾期", "red") : ""}</div><h4 class="issue-desk-title">` +
      `<button type="button" data-copy-bug-title title="复制标题">${escape(title)}</button></h4>` +
      `<small class="muted">${escape(row.id)}</small><dl class="issue-detail-grid">${pairs.map(([label, value]) => `<div><dt>${label}</dt><dd>${value || "未填写"}</dd></div>`).join("")}</dl>` +
      `<section class="issue-desk-section"><h4>问题描述</h4>` +
      `<div class="issue-desk-text">${escape(row.notes) || '<span class="muted">暂无说明</span>'}</div>${row.link ? `<div class="issue-desk-link">${safeLink(row.link, "打开问题链接")}</div>` : ""}</section>` +
      `<section class="issue-desk-section"><h4>原因与解决方案</h4>` +
      `<div class="issue-desk-text">${escape(row.solution) || '<span class="muted">暂无记录</span>'}</div>` +
      `</section>` +
      `<section class="issue-desk-section"><h4>附件</h4>` +
      `<div class="issue-desk-attachments">${attachments}</div>` +
      `</section>` +
      `<section class="issue-desk-section"><h4>关联需求</h4>` +
      `<div class="issue-related">${related}</div>` +
      `</section>` +
      `<details class="issue-desk-more">` +
      `<summary>更多信息` +
      `</summary><dl class="issue-detail-grid">` +
      `<div><dt>创建时间</dt><dd>${escape(row.created_at?.replace("T", " ")) || "未填写"}</dd>` +
      `</div>` +
      `<div><dt>预计修复完成</dt><dd>${date(row.due_at) || "未填写"}</dd>` +
      `</div>` +
      `<div><dt>截止日期</dt><dd>${date(row.deadline) || "未填写"}</dd>` +
      `</div>` +
      `<div><dt>Bug 分类</dt><dd>${escape(row.category) || "未填写"}</dd>` +
      `</div>` +
      `<div><dt>Bug 属性</dt><dd>${escape(row.attribute) || "未填写"}</dd>` +
      `</div></dl>` +
      `</details>` +
      `<div class="issue-detail-footer">${safeLink(row.source_url, "在飞书打开详情")}</div>`;
  }
  function renderBugDesk() {
    const row = data.items.find(item => item.id === selectedBugId);
    const index = data.items.indexOf(row);
    const busy = Boolean(submittingBug || creatingDiscussion || data.sync.syncing || data.sync.submitting);
    renderBugDiscussion(row, busy);
    find("#issueBugPosition").textContent = row ? `${(page - 1) * data.page_size + index + 1} / ${data.total}` : "";
    const key = JSON.stringify(row || null);
    if (key !== bugDetailKey) {
      bugDetailKey = key;
      if (!row) {
        find("#issueBugDetail").innerHTML = '<div class="issue-desk-empty"><i class="bi bi-check2-circle" aria-hidden="true"></i><h4>暂无待处理 Bug</h4><p class="muted">试试其他处理阶段或筛选条件</p></div>';
      } else {
        find("#issueBugDetail").innerHTML = bugDeskContent(row);
      }
      find("#issueBugDetail").scrollTop = 0;
    }
    for (const button of root.querySelectorAll("[data-bug-status]")) {
      button.disabled = !row || busy || row.status === button.dataset.bugStatus;
      button.textContent = submittingBug?.id === row?.id && submittingBug?.status === button.dataset.bugStatus ? "保存中…" : button.dataset.bugStatusLabel || button.dataset.bugStatus;
    }
    find("#issueBugSkip").disabled = !row || busy || index === data.items.length - 1 && page >= data.page_count;
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
          focused?.focus({
            preventScroll: true
          });
        }
      }
      toast("已复制", "success");
    } catch {
      toast("复制失败，请重试", "error");
    }
  }
  async function nextBug() {
    if (!data || submittingBug || creatingDiscussion) return;
    const index = data.items.findIndex(row => row.id === selectedBugId);
    if (index < data.items.length - 1) selectBug(data.items[index + 1].id);else if (page < data.page_count) {
      selectedBugId = "";
      page++;
      await load();
    }
  }
  async function updateBugStatus(status) {
    const row = data?.items.find(item => item.id === selectedBugId);
    if (kind !== "bugs" || !row || submittingBug || creatingDiscussion || data.sync.syncing || data.sync.submitting || row.status === status) return;
    const opening = openSequence;
    const showStatus = (message, failed = false) => {
      const element = find("#issueBugActionStatus");
      element.textContent = message;
      element.classList.toggle("text-danger", failed);
      element.classList.toggle("text-success", !failed);
    };
    submittingBug = {
      id: row.id,
      status
    };
    renderBugDesk();
    find("#issueSyncButton").disabled = true;
    showStatus(`正在标记为“${status}”…`);
    try {
      const result = await request(
        `/api/issues/bugs/${encodeURIComponent(row.id)}/status`,
        {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          status,
          expected_status: row.status
        })
      }
      );
      if (opening !== openSequence) return;
      showStatus(result.warning || `已标记为“${result.status}”`, Boolean(result.warning));
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
    const records = data.items.filter(row => selectedBugs.has(row.id)).map(row => ({
      id: row.id,
      expected_status: row.status
    }));
    if (!records.length) return;
    const opening = openSequence;
    const showStatus = (message, failed = false) => {
      const element = find("#issueBugBatchStatus");
      element.textContent = message;
      element.classList.toggle("text-danger", failed);
      element.classList.toggle("text-success", !failed);
      element.hidden = false;
    };
    submittingBug = {
      ids: records.map(row => row.id),
      status
    };
    form.inert = true;
    form.elements.q.disabled = true;
    renderBugDesk();
    find("#issueSyncButton").disabled = true;
    showStatus(`正在更新 ${records.length} 条 Bug…`);
    try {
      const result = await request(
        "/api/issues/bugs/status",
        {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          records,
          status
        })
      }
      );
      if (opening !== openSequence) return;
      selectedBugs.clear();
      showStatus(result.warning || `${result.updated_count} 条 Bug 已标记为“${result.status}”`, Boolean(result.warning));
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
    IssueDashboard.render(find("#issueDashboard"), data.dashboard);
  }
  function render() {
    find("#issueContent").hidden = false;
    renderFilters();
    const overview = kind === "overview";
    find("#issueDashboard").hidden = !overview;
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
    if (kind === "bugs") find("#issueBugStages").innerHTML = [["all", "全部"], ["pending", "待处理"], ["release", "已修复待发布"], ["fixed", "已修复"]].filter(([value]) => value === "all" || data.bug_stages[value] > 0).map(([value, label]) => `<button type="button"
              data-bug-stage="${value}"
              aria-pressed="${value === bugStage}"
              class="issue-bug-stage ${value === bugStage ? "active" : ""}">
                  ${["release", "fixed"].includes(value) ? statusTag(label) : escape(label)}
                  ` +
      `<span class="issue-bug-stage-count">${data.bug_stages[value]}</span>
              ` +
      `</button>`).join("");
    renderRows();
    const pages = data.page_count;
    const groupLabel = filters.sort_by === "priority" ? "优先级分组" : "版本";
    find("#issuePageInfo").textContent = `第 ${page} / ${pages} 页 · ${kind === "requirements" ? `共 ${data.total_versions} 个${groupLabel}` : `每页 ${data.page_size} 条`}`;
    find("#issuePrevious").disabled = page <= 1;
    find("#issueNext").disabled = page >= pages;
  }
  function readUrlFilters(parameters) {
    const urlFilters = {};
    for (const key of urlFilterKeys) {
      if (parameters.has(key)) urlFilters[key] = key === "project" ? parameters.getAll(key) : parameters.get(key);
    }
    const conditions = JSON.parse(parameters.get("condition_filter") || '{"logic":"and","rules":[]}');
    if (parameters.has("include_family") && !["0", "1"].includes(parameters.get("include_family"))) throw new Error("需求层级显示设置无效");
    if (parameters.has("version_desc") && !["0", "1"].includes(parameters.get("version_desc"))) throw new Error("版本排序设置无效");
    if (parameters.has("version_desc") && !parameters.has("sort_order")) urlFilters.sort_order = parameters.get("version_desc") === "1" ? "desc" : "asc";
    if (parameters.has("version_desc") && !parameters.has("sort_by")) urlFilters.sort_by = "version";
    delete urlFilters.version_desc;
    if (parameters.has("sort_by") && !["version", "priority"].includes(parameters.get("sort_by"))) throw new Error("需求排序方式无效");
    if (parameters.has("sort_order") && !["asc", "desc"].includes(parameters.get("sort_order"))) throw new Error("需求排列顺序无效");
    if (!conditions || !["and", "or"].includes(conditions.logic) || !Array.isArray(conditions.rules) || conditions.rules.length > 50 || conditions.rules.some(rule => !rule || !conditionFields.includes(rule.field) || !["includes", "excludes"].includes(rule.operator) || !Array.isArray(rule.values) || rule.values.some(value => typeof value !== "string"))) {
      throw new Error("链接中的筛选条件无效");
    }
    return {
      filters: urlFilters,
      condition_filter: conditions
    };
  }
  async function open(nextKind, parameters = new URLSearchParams()) {
    if (!(nextKind in labels)) return;
    filterSyncPending = false;
    latestSyncStatus = null;
    if (kind === "overview" && filters.created_from && filters.created_to) {
      overviewParameters = currentOverviewParameters();
    }
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
    const dateFilters = !usingUrlFilters && filters.created_from && filters.created_to && filters.created_from <= filters.created_to ?
      {
      created_from: filters.created_from,
      created_to: filters.created_to
    } :
      {};
    if (searchSavePending) {
      searchSavePending = false;
      await savePreferences();
    } else await preferenceQueue;
    if (opening !== openSequence) return;
    kind = nextKind;
    bugNotifications.reset();
    notificationControl.hidden = kind === "requirements";
    allowStaleCache = true;
    renderAutoSyncControl();
    selectedBugId = "";
    selectedBugs.clear();
    bugSelectionScope = "";
    selectedRequirements.clear();
    requirementSelectionScope = "";
    bugStage = "all";
    bugDetailKey = "";
    find("#issueBugActionStatus").textContent = "";
    find("#issueBugBatchStatus").hidden = true;
    find("#issueBugBatchActions").hidden = true;
    find("#issueBugDiscussionStatus").hidden = true;
    collapsedRequirements.clear();
    collapsedVersions.clear();
    usingUrlFilters = parameters.has("condition_filter") || urlFilterKeys.some(key => parameters.has(key));
    page = 1;
    data = null;
    renderRequirementSelection();
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
    find("#issueRequirementSort").hidden = kind !== "requirements";
    find("#issueSource").hidden = true;
    document.querySelectorAll("[data-issue-kind]").forEach(button => button.classList.toggle("active", button.dataset.issueKind === kind));
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
        autoSyncError = `读取页面配置失败：${error.message}`;
      }
      if (opening !== openSequence) return;
      applyAutoSyncPreferences(preferences);
      renderAutoSyncControl();
      autoSyncControl.disabled = !preferences;
      const saved = usingUrlFilters ? readUrlFilters(parameters) : preferences;
      filters = usingUrlFilters ?
        saved.filters :
        {
        q: saved.filters.q || "",
        include_family: saved.filters.include_family || "0",
        sort_by: saved.filters.sort_by || "version",
        sort_order: saved.filters.sort_order || "asc",
        ...dateFilters
      };
      conditionFilter = saved.condition_filter;
      if (kind === "requirements") {
        conditionFilter = {
          ...conditionFilter,
          rules: conditionFilter.rules.map(rule => rule.field === "scope" ? {
            ...rule,
            values: rule.values.filter(value => !["urgent", "urgent_overdue"].includes(value))
          } : rule).filter(rule => rule.values.length)
        };
        if (["urgent", "urgent_overdue"].includes(filters.scope)) delete filters.scope;
        if (usingUrlFilters && filters.include_family === undefined) {
          filters.include_family = preferences?.filters?.include_family || "0";
        }
        if (usingUrlFilters) {
          filters.sort_by ??= preferences?.filters?.sort_by || "version";
          filters.sort_order ??= preferences?.filters?.sort_order || "asc";
        }
        requirementProjects = usingUrlFilters ? [...(filters.project || [])] : saved.requirement_projects;
        activeRequirementProject = usingUrlFilters ? "" : saved.active_project;
      }
      if (autoSyncError) preferenceError(autoSyncError);else find("#issuePreferenceStatus").hidden = true;
    } catch (error) {
      if (opening !== openSequence) return;
      autoSyncSettings[kind] = false;
      autoSyncControl.checked = false;
      autoSyncControl.indeterminate = false;
      autoSyncControl.setAttribute("aria-checked", "false");
      if (usingUrlFilters) {
        find("#issueProjectTabs").hidden = true;
        root.setAttribute("aria-busy", "false");
        preferenceError(`链接中的筛选条件加载失败：${error.message}`);
        return;
      }
      filters = {
        ...dateFilters
      };
      conditionFilter = {
        logic: "and",
        rules: []
      };
      if (kind === "requirements") {
        requirementProjects = [];
        activeRequirementProject = "";
      }
      preferenceError(`筛选设置加载失败：${error.message}`);
    }
    if (kind === "requirements") applyRequirementProject();else if (!usingUrlFilters) delete filters.project;
    for (const control of form.elements) {
      if (!control.name) continue;
      if (control.type === "checkbox") {
        control.checked = filters[control.name] === "1";
        continue;
      }
      const defaultValue = {
        sort_by: "version",
        sort_order: "asc"
      }[control.name] || "";
      const value = Array.isArray(filters[control.name]) ? filters[control.name][0] || defaultValue : filters[control.name] || defaultValue;
      if (control.tagName === "SELECT" && value && ![...control.options].some(option => option.value === value)) control.add(new Option(value, value));
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
  function jump(target, changes, resetFilters = false) {
    const jumpFilters = resetFilters ? {
      created_from: filters.created_from,
      created_to: filters.created_to
    } : {
      ...filters
    };
    // Cross-page links inherit the requirement page's saved display settings.
    if (target === "requirements" && kind !== "requirements") {
      for (const key of ["include_family", "version_desc", "sort_by", "sort_order"]) delete jumpFilters[key];
    }
    const conditions = resetFilters ? {
      logic: "and",
      rules: []
    } : JSON.parse(JSON.stringify(conditionFilter));
    for (const [field, value] of Object.entries(changes)) {
      if (["q", "dashboard_scope", "test_date"].includes(field)) jumpFilters[field] = value;else {
        delete jumpFilters[field];
        conditions.rules = conditions.rules.filter(rule => rule.field !== field);
        if (value) conditions.rules.push({
          field,
          operator: "includes",
          values: Array.isArray(value) ? value : [value]
        });
      }
    }
    const parameters = new URLSearchParams({
      condition_filter: JSON.stringify(conditions)
    });
    for (const [key, value] of Object.entries(jumpFilters)) {
      for (const item of Array.isArray(value) ? value : [value]) {
        if (item !== undefined && item !== null && item !== "") parameters.append(key, item);
      }
    }
    navigate(`${target === "overview" ? "issues" : target}?${parameters}`);
  }
  function requirementPriorityEditor(row) {
    const currentPriority = row.priority || "";
    const options = ["", ...(data.requirement_priorities || [])].map(priority => {
      const value = escape(priority);
      const selected = priority === currentPriority ? "selected" : "";
      return `<option value="${value}" data-priority="${value}" style="${priorityStyle(priority)}" ${selected}>${escape(priority || "未设置")}</option>`;
    }).join("");
    return `<div class="issue-priority-editor">
      <select
        id="issueRequirementPriority"
        class="form-select form-select-sm"
        data-record-id="${escape(row.id)}"
        data-priority="${escape(currentPriority)}"
        style="${priorityStyle(currentPriority)}"
        aria-label="设置需求优先级，选择后自动保存"
        ${savingRequirementPriority ? "disabled" : ""}
      >${options}</select>
      <p id="issueRequirementPriorityStatus" class="small mb-0" role="status" aria-live="polite"></p>
    </div>`;
  }
  function detail(id) {
    const row = data?.items.find(item => item.id === id);
    if (!row) return;
    if (kind === "bugs") {
      selectBug(id);
      return;
    }
    const pairs = [
      ["项目", escape(list(row.project))],
      ["版本", escape(list(row.version))],
      ["状态", statusTag(row.status)],
      ["优先级", requirementPriorityEditor(row)],
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
      ["设计人员", escape(names(row.designers))]
    ];
    const related = row.related.map(item => `<button class="issue-related-link" type="button" data-related-kind="${item.kind}" data-related-id="${escape(item.id)}">${escape(item.title)}</button>`).join("") || '<span class="muted">暂无关联记录</span>';
    find("#issueDetailContent").innerHTML = `<div class="issue-detail-title">${recordTitle(row)}</div>` +
      `<small class="muted">${escape(row.id)}</small><dl class="issue-detail-grid">${pairs.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join("")}</dl><h3>关联 Bug</h3>` +
      `<div class="issue-related">${related}</div>` +
      `<div class="issue-detail-footer">${safeLink(row.source_url, "在飞书打开详情")}</div>`;
    const dialog = find("#issueDetailDialog");
    if (!dialog.open) dialog.showModal();
  }
  async function saveRequirementPriority(recordId) {
    if (savingRequirementPriority || kind !== "requirements") return;
    const select = find("#issueRequirementPriority");
    if (!select || select.dataset.recordId !== recordId) return;
    const priority = select.value;
    const previousPriority = data?.items.find(row => row.id === recordId)?.priority || "";
    const opening = openSequence;
    savingRequirementPriority = true;
    select.disabled = true;
    const showStatus = (message, failed = false) => {
      if (opening !== openSequence || find("#issueRequirementPriority")?.dataset.recordId !== recordId) return;
      const status = find("#issueRequirementPriorityStatus");
      status.textContent = message;
      status.classList.toggle("text-danger", failed);
      status.classList.toggle("text-success", !failed);
    };
    // showStatus("正在保存优先级…");
    try {
      const result = await request(
        `/api/issues/requirements/${encodeURIComponent(recordId)}/priority`,
        {
        method: "PUT",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          priority
        })
      }
      );
      if (opening !== openSequence) return;
      const family = new Set(result.record_ids);
      for (const row of data?.items || []) if (family.has(row.id)) row.priority = result.priority;
      const currentSelect = find("#issueRequirementPriority");
      if (currentSelect && family.has(currentSelect.dataset.recordId)) {
        currentSelect.value = result.priority;
        currentSelect.dataset.priority = result.priority;
        currentSelect.style.cssText = priorityStyle(result.priority);
      }
      selectedRequirements.clear();
      // showStatus("优先级已保存，父子需求已同步更新。");
      await load();
    } catch (error) {
      const currentSelect = find("#issueRequirementPriority");
      if (opening === openSequence && currentSelect?.dataset.recordId === recordId) {
        currentSelect.value = previousPriority;
        currentSelect.dataset.priority = previousPriority;
        currentSelect.style.cssText = priorityStyle(previousPriority);
      }
      showStatus(`保存失败：${error.message}`, true);
    } finally {
      savingRequirementPriority = false;
      const currentSelect = find("#issueRequirementPriority");
      if (currentSelect) currentSelect.disabled = false;
    }
  }
  async function updateSelectedRequirementStatuses(status) {
    if (kind !== "requirements" || !data || searchSavePending || submittingRequirements.size || creatingDiscussion || data.sync.syncing || data.sync.submitting || root.getAttribute("aria-busy") === "true" || !form.checkValidity() || filters.created_from > filters.created_to) return;
    const selectedRows = data.items.filter(row => selectedRequirements.has(row.id));
    const records = selectedRows.map(row => ({
      id: row.id,
      expected_status: row.status
    }));
    if (!records.length) return;
    const opening = openSequence;
    const actionStatus = find("#issueActionStatus");
    const showStatus = (message, failed = false) => {
      actionStatus.textContent = message;
      actionStatus.classList.toggle("text-danger", failed);
      actionStatus.classList.toggle("text-success", !failed);
      actionStatus.hidden = false;
    };
    const submittingTesting = status === "测试中";
    const action = submittingTesting ? "提测" : "状态更新";
    if (submittingTesting && selectedRows.some(row => !canSubmitRequirement(row))) {
      showStatus("部分需求当前无法提测，请取消勾选后重试", true);
      return;
    }
    for (const record of records) submittingRequirements.add(record.id);
    submittingRequirementStatus = status;
    form.inert = true;
    form.elements.q.disabled = true;
    renderRequirementSelection();
    find("#issueSyncButton").disabled = true;
    showStatus(submittingTesting ? `正在提测 ${records.length} 条需求…` : `正在将 ${records.length} 条需求标记为“${status}”…`);
    try {
      const result = await request(
        submittingTesting ? "/api/issues/requirements/submit-testing" : "/api/issues/requirements/status",
        {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          records,
          status
        })
      }
      );
      if (opening !== openSequence) return;
      selectedRequirements.clear();
      showStatus(result.warning || (submittingTesting ? `${result.updated_count} 条需求已提测` : `${result.updated_count} 条需求已标记为“${result.status}”`), Boolean(result.warning));
      await load();
    } catch (error) {
      if (opening !== openSequence) return;
      showStatus(`${action}失败：${error.message}`, true);
      await load();
    } finally {
      submittingRequirements.clear();
      submittingRequirementStatus = "";
      if (opening === openSequence) {
        form.inert = false;
        form.elements.q.disabled = false;
        renderRequirementSelection();
        if (data) setStatus(data.sync);
      }
    }
  }
  form.addEventListener(
    "change",
    event => {
    if (!event.target.name || event.target.name === "q") return;
    if (event.target.name === "condition_logic") return conditionBuilder.setLogic(event.target.value);
    filters[event.target.name] = event.target.type === "checkbox" ? event.target.checked ? "1" : "0" : event.target.value;
    if (["sort_by", "sort_order"].includes(event.target.name)) collapsedVersions.clear();
    if (["created_from", "created_to"].includes(event.target.name)) {
      allowStaleCache = false;
      data = null;
      find("#issueContent").hidden = true;
    } else savePreferences();
    page = 1;
    load(true);
  }
  );
  form.elements.q.addEventListener(
    "input",
    event => {
    filters.q = event.target.value;
    selectedBugs.clear();
    renderBugSelection();
    searchSavePending = true;
    selectedRequirements.clear();
    renderRequirementSelection();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchSavePending = false;
      page = 1;
      savePreferences();
      load(true);
    }, 300);
  }
  );
  find("#issueRecentDates").addEventListener(
    "click",
    () => {
    allowStaleCache = false;
    delete filters.created_from;
    delete filters.created_to;
    form.elements.created_from.value = "";
    form.elements.created_to.value = "";
    data = null;
    find("#issueContent").hidden = true;
    page = 1;
    load(true);
  }
  );
  find("#issueReset").addEventListener(
    "click",
    () => {
    allowStaleCache = false;
    clearTimeout(searchTimer);
    searchSavePending = false;
    filters = {};
    conditionFilter = {
      logic: "and",
      rules: []
    };
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
    load(true);
  }
  );
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
  find("#issueFilterDone").addEventListener(
    "click",
    () => {
    if (!form.reportValidity()) return;
    if (filters.created_from > filters.created_to) return load();
    find("#issueFilterDialog").close();
  }
  );
  async function syncData(automatic = false, filterChange = false) {
    if (syncRequestPending || form.inert || submittingRequirements.size || submittingBug || creatingDiscussion) return;
    if (automatic && (find("#issueSyncButton").disabled || root.getAttribute("aria-busy") === "true")) return;
    if (!form.checkValidity() || filters.created_from > filters.created_to) {
      if (automatic) return;
      if (!find("#issueFilterDialog").open) find("#issueFilterDialog").showModal();
      form.reportValidity();
      return load();
    }
    const current = sequence,
      opening = openSequence;
    let syncRequested = false;
    bugNotifications.beginSync(null, false);
    syncRequestPending = true;
    find("#issueSyncButton").disabled = true;
    try {
      const result = await request(
        "/api/issues/sync?" + new URLSearchParams({
        kind,
        created_from: filters.created_from,
        created_to: filters.created_to,
        include_family: kind === "requirements" ? filters.include_family || "0" : "0"
      }),
        {
        method: "POST"
      }
      );
      syncRequested = true;
      if (filterChange && opening === openSequence && !result.sync_id) filterSyncPending = true;
      if (current !== sequence) return;
      bugNotifications.beginSync(result.sync_id, automatic);
      setStatus(result);
      await load();
    } catch (error) {
      if (current !== sequence) return;
      find("#issueSyncStatus").textContent = `同步失败：${error.message}`;
      find("#issueSyncStatus").classList.add("issue-sync-error");
      find("#issueSyncButton").disabled = false;
    } finally {
      syncRequestPending = false;
      if (syncRequested && opening === openSequence) flushFilterSync();
    }
  }
  find("#issueSyncButton").addEventListener("click", () => syncData());
  autoSyncControl.addEventListener(
    "change",
    () => {
    const target = kind,
      opening = openSequence;
    const previous = {
        ...autoSyncSettings
      },
      enabled = autoSyncControl.checked;
    autoSyncControl.disabled = true;
    clearTimeout(autoSyncTimer);
    autoSyncTimer = null;
    preferenceQueue = preferenceQueue.then(async () => {
      const saved = await request(
          `/api/issues/preferences/${target}`,
          {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          auto_sync: enabled
        })
      }
        );
      applyAutoSyncPreferences(saved, target);
      if (opening === openSequence && kind === target) {
        renderAutoSyncControl();
        find("#issuePreferenceStatus").hidden = true;
      }
    }).catch(error => {
      Object.assign(autoSyncSettings, previous);
      if (opening === openSequence && kind === target) {
        renderAutoSyncControl();
        preferenceError(`自动同步设置保存失败：${error.message}`);
      }
    }).finally(() => {
      if (opening === openSequence && kind === target) {
        autoSyncControl.disabled = false;
        scheduleAutoSync();
      }
    });
  }
  );
  find("#issueCloseDetail").addEventListener("click", () => find("#issueDetailDialog").close());
  find("#issueBugSkip").addEventListener("click", nextBug);
  for (const button of root.querySelectorAll("[data-requirement-status]")) {
    button.addEventListener("click", () => updateSelectedRequirementStatuses(button.dataset.requirementStatus));
  }
  find("#issueBugDetail").addEventListener(
    "error",
    event => {
    if (!event.target.matches("[data-attachment-media]")) return;
    event.target.hidden = true;
    event.target.closest(".issue-media").querySelector("[data-attachment-error]").hidden = false;
  },
    true
  );
  root.addEventListener(
    "change",
    event => {
    if (event.target.matches("#issueRequirementPriority")) {
      event.target.dataset.priority = event.target.value;
      event.target.style.cssText = priorityStyle(event.target.value);
      saveRequirementPriority(event.target.dataset.recordId);
      return;
    }
    const checkbox = event.target;
    if (checkbox.matches("[data-version-check]")) {
      if (checkbox.disabled || kind !== "requirements" || !data) return;
      for (const row of data.items) {
        if (row.version_group !== checkbox.dataset.versionCheck) continue;
        if (checkbox.checked) selectedRequirements.add(row.id);else selectedRequirements.delete(row.id);
      }
      find("#issueActionStatus").hidden = true;
      renderRequirementSelection();
      return;
    }
    if (checkbox.matches("[data-requirement-check]")) {
      if (checkbox.disabled || kind !== "requirements" || !data) return;
      const id = checkbox.dataset.requirementCheck;
      for (const row of data.items) {
        if (row.id !== id && !(row.tree_ancestors || []).includes(id)) continue;
        if (checkbox.checked) selectedRequirements.add(row.id);else selectedRequirements.delete(row.id);
      }
      find("#issueActionStatus").hidden = true;
      renderRequirementSelection();
      return;
    }
    if (!checkbox.matches("[data-bug-check], [data-bug-select-all]") || checkbox.disabled || kind !== "bugs" || !data) return;
    const ids = checkbox.hasAttribute("data-bug-select-all") ? data.items.map(row => row.id) : [checkbox.dataset.bugCheck];
    for (const id of ids) {
      if (checkbox.checked) selectedBugs.add(id);else selectedBugs.delete(id);
    }
    find("#issueBugBatchStatus").hidden = true;
    renderBugSelection();
  }
  );
  root.addEventListener(
    "click",
    event => {
    if (event.target.closest("[data-bug-check], [data-bug-select-all], [data-version-check]")) return;
    const title = event.target.closest("[data-detail]");
    if (title) {
      if (title.tagName === "A" && (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0)) return;
      event.preventDefault();
      detail(title.dataset.detail);
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
    if (button.hasAttribute("data-create-requirement-discussion")) {
      createRequirementDiscussion(button.dataset.createRequirementDiscussion);
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
      return load(true);
    }
    if (button.hasAttribute("data-toggle-requirement")) {
      const id = button.dataset.toggleRequirement;
      if (collapsedRequirements.has(id)) collapsedRequirements.delete(id);else collapsedRequirements.add(id);
      renderRows();
      [...root.querySelectorAll("[data-toggle-requirement]")].find(toggle => toggle.dataset.toggleRequirement === id)?.focus();
      return;
    }
    if (button.hasAttribute("data-requirement-project")) {
      if (submittingRequirements.size || creatingDiscussion) return;
      const project = button.dataset.requirementProject;
      requirementProjects = requirementProjects.includes(project) ? requirementProjects.filter(value => value !== project) : [...requirementProjects, project];
      if (!requirementProjects.includes(activeRequirementProject)) activeRequirementProject = "";
      applyRequirementProject();
      savePreferences();
      renderProjectOptions();
      renderProjectTabs();
      [...find("#issueProjectChoices").querySelectorAll("button")].find(option => option.dataset.requirementProject === project)?.focus();
      find("#issueContent").hidden = true;
      page = 1;
      return load(true);
    }
    if (button.hasAttribute("data-requirement-project-tab")) {
      if (submittingRequirements.size || creatingDiscussion) return;
      activeRequirementProject = button.dataset.requirementProjectTab;
      applyRequirementProject();
      savePreferences();
      renderProjectTabs();
      page = 1;
      find("#issueContent").hidden = true;
      return load(true);
    }
    if (button.hasAttribute("data-release-projects")) {
      const projects = JSON.parse(button.dataset.releaseProjects);
      const versions = JSON.parse(button.dataset.releaseVersions);
      jump("requirements", {
        project: projects.length ? projects : ["__empty__"],
        version: versions.length ? versions : ["__empty__"]
      }, true);
      return;
    }
    if (button.hasAttribute("data-dashboard-scope")) {
      jump(
          "requirements",
          {
        dashboard_scope: button.dataset.dashboardScope,
        test_date: button.dataset.dashboardDate || "",
        ...(button.hasAttribute("data-dashboard-project") ? {
          project: button.dataset.dashboardProject
        } : {})
      }
        );
      return;
    }
    if (button.hasAttribute("data-dashboard-bug-status")) {
      jump("bugs", {
        dashboard_scope: "bugs",
        test_date: "",
        status: button.dataset.dashboardBugStatus
      });
      return;
    }
    if (button.dataset.relatedId) {
      find("#issueDetailDialog").close();
      jump(button.dataset.relatedKind, {
        q: button.dataset.relatedId
      }, true);
    }
  }
  );
  find("#issueProjectTabs").addEventListener(
    "keydown",
    event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tabs = [...find("#issueProjectTabs").querySelectorAll('[role="tab"]')];
    const index = tabs.indexOf(document.activeElement);
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next].click();
    find('#issueProjectTabs [aria-selected="true"]')?.focus();
  }
  );
  function currentOverviewParameters() {
    if (kind !== "overview") return overviewParameters;
    const parameters = new URLSearchParams({ condition_filter: JSON.stringify(conditionFilter) });
    for (const [key, value] of Object.entries(filters)) {
      if (!["q", "created_from", "created_to", "dashboard_scope", "test_date", ...conditionFields].includes(key)) continue;
      for (const item of Array.isArray(value) ? value : [value]) {
        if (item !== undefined && item !== null && item !== "") parameters.append(key, item);
      }
    }
    return parameters.toString();
  }
  function getOverviewParameters() {
    if (kind === "overview" && filters.created_from && filters.created_to) {
      overviewParameters = currentOverviewParameters();
    }
    return overviewParameters;
  }
  return { open, getOverviewParameters };
})();
