window.IssueDashboard = (() => {
  const escape = ReleaseLite.escapeHtml;
  const colors = { overdue: "#ff595f", soon: "#ffc334", normal: "#5b91ff", later: "#c3c9d8", today: "#246bfe", submitted: "#20c78b", scheduled: "#c3c9d8" };
  const deadlineLabels = [
    ["overdue", "已逾期"],
    ["soon", "≤ 3 天"],
    ["normal", "4 - 7 天"],
    ["later", "> 7 天"],
  ];
  const weekLabels = [
    ["submitted", "已提测"],
    ["today", "今天提测"],
    ["soon", "临近截止 (≤3天)"],
    ["overdue", "已逾期"],
    ["scheduled", "未到截止"],
  ];
  function dot(color) {
    return `<i class="issue-dashboard-dot" style="--dot-color:${color}" aria-hidden="true"></i>`;
  }
  function entries(counts, labels, weekly = false) {
    return labels.map(([key, label]) => ({ label, count: counts[key] || 0, color: colors[key], scope: weekly && key !== "submitted" ? `week_${key}` : key }));
  }
  function donut(items, total, caption) {
    let position = 0;
    const segments = items
      .filter((item) => item.count > 0)
      .map((item) => {
        const start = position;
        position += (item.count / total) * 100;
        return `${item.color} ${start}% ${position}%`;
      });
    const fill = segments.length ? `conic-gradient(${segments.join(",")})` : "#edf1f7";
    return `<div class="issue-dashboard-donut-layout"><div class="issue-dashboard-donut" style="--donut-fill:${fill}" role="img" aria-label="${escape(caption)}：${total}，${escape(items.map((item) => `${item.label} ${item.count}`).join("，"))}"><div class="issue-dashboard-donut-center"><b>${total}</b><span>${escape(caption)}</span></div></div><ul class="issue-dashboard-chart-legend">${items.map((item) => `<li><button type="button" ${item.status ? `data-dashboard-bug-status="${escape(item.status)}"` : `data-dashboard-scope="${item.scope}"`} title="查看${escape(item.label)}记录">${dot(item.color)}<span class="issue-dashboard-legend-label">${escape(item.label)}</span><b>${item.count}</b><small>(${total ? Math.round((item.count / total) * 100) : 0}%)</small></button></li>`).join("")}</ul></div>`;
  }
  function metric(title, value, detail, tone, icon, decoration, scope) {
    return `<button type="button" class="issue-dashboard-metric" data-tone="${tone}" data-dashboard-scope="${scope}"><i class="bi bi-${icon} issue-dashboard-metric-icon" aria-hidden="true"></i><span class="issue-dashboard-metric-content"><span class="issue-dashboard-metric-title">${title}</span><b class="issue-dashboard-metric-value">${value}</b><span class="issue-dashboard-metric-detail">${detail}</span></span><i class="bi bi-${decoration} issue-dashboard-metric-decoration" aria-hidden="true"></i><i class="bi bi-arrow-right issue-dashboard-metric-arrow" aria-hidden="true"></i></button>`;
  }
  function render(root, data) {
    const find = (selector) => root.querySelector(selector);
    const metrics = data.metrics;
    find("#issueDashboardMetrics").innerHTML = [
      metric(
        "本周提测的需求",
        metrics.weekly,
        `共 ${metrics.weekly_total} 个需求，<strong>${metrics.weekly_overdue} 个已逾期</strong>`,
        "red",
        "calendar3",
        "bar-chart-fill",
        "weekly_pending",
      ),
      metric("未提测且即将超时", metrics.soon, "3 天内到提测截止", "yellow", "clock-fill", "clock-fill", "soon"),
      metric("今天是提测日期", metrics.today, "今天需要提测的需求", "blue", "calendar3", "calendar3", "today"),
      metric("已逾期未提测", metrics.overdue, metrics.overdue ? "请尽快处理" : "当前没有逾期需求", "purple", "file-earmark-text-fill", "exclamation-circle-fill", "overdue"),
    ].join("");
    find("#issueDashboardWeekRange").textContent = `${data.week_start} ~ ${data.week_end}`;
    const maximum = Math.max(1, ...data.calendar.map((day) => day.count));
    find("#issueDashboardCalendar").innerHTML = data.calendar
      .map(
        (day, index) =>
          `<button type="button" class="issue-dashboard-day${day.today ? " is-today" : ""}${day.count ? "" : " is-empty"}" data-dashboard-scope="weekly" data-dashboard-date="${day.date}" style="--bar-color:${colors[day.tone]};--bar-height:${(day.count / maximum) * 82}px" aria-label="${day.date}，${day.count} 个提测需求${day.today ? "，今天" : ""}"><span class="issue-dashboard-day-name">周${"一二三四五六日"[index]}</span><time class="issue-dashboard-day-date" datetime="${day.date}">${day.date.slice(5)}</time><span class="issue-dashboard-day-plot"><b class="issue-dashboard-day-count">${day.count}</b><span class="issue-dashboard-day-bar" aria-hidden="true"></span></span></button>`,
      )
      .join("");
    find("#issueDashboardDeadlines").innerHTML = donut(entries(data.deadline_buckets, deadlineLabels), data.dated_pending, "未提测需求");
    find("#issueWeekStatusTitle").textContent = `本周提测需求状态（${data.week_total}）`;
    find("#issueDashboardWeekStatus").innerHTML = donut(entries(data.week_status, weekLabels, true), data.week_total, "本周需求");
    const bugLabels = { "新建": "#ff595f", "处理中": "#307cff", "重新打开": "#ffc334", "已修复待发布": "#9256ff", "已修复": "#20c78b", "挂起": "#99a6bb" };
    const bugNames = [
      ...Object.keys(bugLabels),
      ...Object.keys(data.bug_status)
        .filter((name) => !(name in bugLabels))
        .sort(),
    ];
    const extraColors = ["#80b6f5", "#df85bd", "#7f98b0"];
    const bugEntries = bugNames.map((name, index) => ({
      label: name,
      count: data.bug_status[name] || 0,
      color: bugLabels[name] || extraColors[index % extraColors.length],
      status: name,
    }));
    find("#issueBugStatusTitle").textContent = `正在关注的 Bug（${data.bug_total}）`;
    find("#issueDashboardBugStatus").innerHTML = donut(bugEntries, data.bug_total, "正在关注");
    const projectMaximum = Math.max(1, ...data.projects.map((project) => project.total));
    find("#issueDashboardProjects").innerHTML = data.projects.length
      ? data.projects
          .map(
            (project) =>
              `<button type="button" class="issue-dashboard-project-row" data-dashboard-scope="pending" data-dashboard-project="${escape(project.name || "__empty__")}" title="查看${escape(project.name || "未分配项目")}待提测需求"><span class="issue-dashboard-project-name">${escape(project.name || "未分配项目")}</span><span class="issue-dashboard-project-track" role="img" aria-label="${escape(project.name || "未分配项目")}：${deadlineLabels.map(([key, label]) => `${label} ${project.buckets[key] || 0}`).join("，")}">${deadlineLabels.map(([key]) => `<span style="--segment-width:${((project.buckets[key] || 0) / projectMaximum) * 100}%;--segment-color:${colors[key]}"></span>`).join("")}</span><b>${project.total}</b></button>`,
          )
          .join("")
      : '<p class="issue-dashboard-empty">暂无待提测的项目</p>';
    find("#issueDashboardNote").textContent =
      `统计沿用当前创建时间范围及筛选条件，按北京时间计算，主需求与子需求分别计数。本周按提测截止日期归属；未提测取空状态、产品设计中、需求待评审、待开发、开发中、开发完成。${data.undated_pending} 个未填有效提测日期的待提测需求未计入日期图表；Bug 未填写状态的记录不计入。项目风险按逾期数、临近截止数排序，多项目需求分别计入各项目。`;
  }
  return { render };
})();
