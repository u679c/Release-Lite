/* Shows locally synced issues; list links inherit saved display settings. */
window.HomeIssues = (() => {
  const root = document.querySelector("#homeIssuesCard");
  const find = selector => root.querySelector(selector);
  const escape = ReleaseLite.escapeHtml;
  let loading = false;

  function route(data, kind, extra = {}) {
    const parameters = new URLSearchParams({ condition_filter: JSON.stringify(data.condition_filter) });
    for (const [key, value] of Object.entries({ ...data.filters, ...extra })) {
      for (const item of Array.isArray(value) ? value : [value]) {
        if (item !== undefined && item !== null && item !== "") parameters.append(key, item);
      }
    }
    return `#/${kind}?${parameters}`;
  }

  function metric(data, label, key, icon, tone, scope, kind = "requirements") {
    const value = data.ranges[kind] ? data.metrics[key] : "—";
    const href = route(data, kind, { dashboard_scope: scope });
    return `<a class="home-issues-metric" data-tone="${tone}" href="${escape(href)}">
      <span class="home-issues-metric-icon"><i class="bi bi-${icon}" aria-hidden="true"></i></span>
      <span><span class="home-issues-metric-label">${label}</span><b>${value}</b></span>
      <i class="bi bi-arrow-up-right home-issues-arrow" aria-hidden="true"></i>
    </a>`;
  }

  function queueRow(data, row, kind) {
    const title = row.title.replace(/^\[([\s\S]*)\]\(https?:\/\/[^\s]+\)$/, "$1");
    const priority = row.priority || "未设置";
    const project = row.project.join(" / ") || "未分配项目";
    const deadline = row.deadline
      ? `${kind === "requirements" ? "提测" : "截止"} ${row.deadline}` : "未安排日期";
    // A supplemented parent may fall outside the filters; navigate via its matching child.
    return `<a class="home-issues-row" href="${escape(route(data, kind, { q: row.match_id || row.id }))}">
      <span class="home-issues-row-main">
        <span class="home-issues-row-title" title="${escape(title)}">${escape(title)}</span>
        <small title="${escape(project)}">${escape(project)}<span> · ${escape(deadline)}</span></small>
      </span>
      <span class="home-issues-row-tags">
        <span class="home-issue-priority" data-priority="${escape(priority)}">${escape(priority)}</span>
        <span class="home-issues-state">${escape(row.status || "状态未填")}</span>
      </span>
    </a>`;
  }

  function render(data) {
    find("#homeIssuesMetrics").innerHTML = [
      metric(data, "今日待提测", "today", "calendar3", "blue", "today"),
      metric(data, "逾期未提测", "overdue", "exclamation-circle", "red", "overdue"),
      metric(data, "3 天内待提测", "soon", "clock", "amber", "soon"),
      metric(data, "待处理 Bug", "bugs", "bug", "purple", "bugs_pending", "bugs"),
    ].join("");
    for (const [kind, selector] of [["requirements", "#homeRequirementsQueue"], ["bugs", "#homeBugsQueue"]]) {
      find(selector).innerHTML = data[kind].length
        ? data[kind].map(row => queueRow(data, row, kind)).join("")
        : `<p class="home-issues-empty">${data.ranges[kind] ? (kind === "requirements" ? "暂无待提测需求" : "暂无待处理 Bug") : "暂无数据，请前往总览同步"}</p>`;
    }
    find("#homeBugsLink").href = route(data, "bugs", { dashboard_scope: "bugs_pending" });
    find("#homeRequirementsLink").href = route(data, "requirements");
    const ready = data.ranges.requirements && data.ranges.bugs;
    const status = find("#homeIssuesStatus");
    status.hidden = Boolean(ready && data.cache_complete);
    status.textContent = !ready
      ? "请前往总览同步数据"
      : "数据未完整同步，请前往总览补充同步";
    status.classList.remove("has-error");
    const stamps = Object.values(data.updated_at).filter(Boolean).sort();
    const stamp = stamps.length ? `更新于 ${stamps[0].slice(0, 19).replace("T", " ")}` : "尚未同步";
    const cacheStatus = ready && data.cache_complete ? "缓存完整" : "缓存待补全";
    find("#homeIssuesNote").textContent = `${stamp} · ${cacheStatus}`;
  }

  async function refresh() {
    if (loading || !root || !document.querySelector("#overview-page").classList.contains("active")) return;
    loading = true;
    root.setAttribute("aria-busy", "true");
    try {
      const parameters = window.IssueManagement?.getOverviewParameters() || "";
      render(await ReleaseLite.request(`/api/issues/home-summary${parameters ? "?" + parameters : ""}`));
    } catch (error) {
      const status = find("#homeIssuesStatus");
      status.hidden = false;
      status.classList.add("has-error");
      status.textContent = `加载失败：${error.message}`;
    } finally {
      loading = false;
      root.setAttribute("aria-busy", "false");
    }
  }

  return { refresh };
})();
