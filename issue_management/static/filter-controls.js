/* Searchable dropdowns keep native select values as the form's source of truth. */
window.IssueFilterControls = {
  position(details) {
    if (!details.open || !details.isConnected) return;
    const panel = details.querySelector(".issue-dropdown-panel");
    const list = panel?.querySelector('[role="listbox"]');
    if (!panel || !list) return;
    details.classList.remove("issue-dropdown-up");
    list.style.maxHeight = "";
    const anchor = details.querySelector("summary").getBoundingClientRect();
    const dialog = details.closest("dialog")?.getBoundingClientRect();
    const top = Math.max(8, (dialog?.top ?? 0) + 8);
    const bottom = Math.min(window.innerHeight - 8, (dialog?.bottom ?? window.innerHeight) - 8);
    const below = Math.max(0, bottom - anchor.bottom - 5);
    const above = Math.max(0, anchor.top - top - 5);
    const height = panel.getBoundingClientRect().height;
    const upward = below < height && above > below;
    details.classList.toggle("issue-dropdown-up", upward);
    const available = upward ? above : below;
    const chrome = height - list.getBoundingClientRect().height;
    list.style.maxHeight = `${Math.max(36, Math.min(180, available - chrome - 2))}px`;
  },
  create(form, renderProjects) {
    const escape = ReleaseLite.escapeHtml;
    const widgets = [];
    function renderOptions(widget) {
      const query = widget.search.value.trim().toLocaleLowerCase();
      const options = [...widget.select.options].filter((option) => option.text.toLocaleLowerCase().includes(query));
      const html = options.map((option) => `<button type="button" class="issue-project-option" role="option" aria-selected="${option.value === widget.select.value}" data-filter-value="${escape(option.value)}"><span>${escape(option.text)}</span><i class="bi bi-check2" aria-hidden="true"></i></button>`).join("") || '<span class="issue-dropdown-empty">无匹配选项</span>';
      if (widget.options.innerHTML !== html) widget.options.innerHTML = html;
      widget.selected.textContent = widget.select.selectedOptions[0]?.text || "全部";
      widget.selected.title = widget.selected.textContent;
      widget.summary.setAttribute("aria-label", widget.select.getAttribute("aria-label") || "选择筛选条件");
      IssueFilterControls.position(widget.details);
    }
    for (const select of form.querySelectorAll("select")) {
      const details = document.createElement("details");
      details.className = "issue-project-dropdown issue-select-dropdown";
      details.innerHTML = '<summary aria-haspopup="listbox"><span></span><i class="bi bi-chevron-down" aria-hidden="true"></i></summary><div class="issue-dropdown-panel"><input type="search" class="form-control form-control-sm issue-option-search" placeholder="搜索选项" aria-label="搜索下拉选项" autocomplete="off"><div class="issue-select-options" role="listbox"></div></div>';
      select.hidden = true;
      select.after(details);
      const widget = { select, details, summary: details.querySelector("summary"), selected: details.querySelector("summary span"), search: details.querySelector("input"), options: details.querySelector('[role="listbox"]') };
      widget.search.addEventListener("input", () => renderOptions(widget));
      widget.options.addEventListener("click", (event) => {
        const option = event.target.closest("[data-filter-value]");
        if (!option) return;
        select.value = option.dataset.filterValue;
        details.open = false;
        renderOptions(widget);
        select.dispatchEvent(new Event("change", { bubbles: true }));
        widget.summary.focus();
      });
      widgets.push(widget);
      renderOptions(widget);
    }
    const projectDropdown = form.querySelector("#issueProjectDropdown");
    const projectSearch = form.querySelector("#issueProjectSearch");
    projectSearch.addEventListener("input", () => { renderProjects(); IssueFilterControls.position(projectDropdown); });
    const allDropdowns = [...widgets.map((widget) => widget.details), projectDropdown];
    for (const details of allDropdowns) {
      const search = details.querySelector(".issue-option-search");
      details.addEventListener("toggle", () => {
        if (!details.open) return;
        for (const other of form.querySelectorAll("details[open]")) if (other !== details) other.open = false;
        search.value = "";
        const widget = widgets.find((item) => item.details === details);
        if (widget) renderOptions(widget);
        else renderProjects();
        IssueFilterControls.position(details);
        search.focus();
      });
      details.addEventListener("keydown", (event) => {
        if (!details.open) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          details.open = false;
          details.querySelector("summary").focus();
        } else if (["ArrowDown", "ArrowUp"].includes(event.key)) {
          event.preventDefault();
          const options = [...details.querySelectorAll('[role="option"]')];
          if (!options.length) return;
          const index = options.indexOf(document.activeElement);
          const next = index < 0 ? (event.key === "ArrowDown" ? 0 : options.length - 1) : (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
          options[next].focus();
        } else if (event.key === "Enter" && event.target === search) {
          event.preventDefault();
          details.querySelector('[role="option"]')?.click();
        }
      });
    }
    form.closest(".issue-module").addEventListener("click", (event) => {
      const conditionMenu = event.composedPath().find((node) => node.dataset?.conditionMenu)?.dataset.conditionMenu;
      for (const details of form.querySelectorAll("details[open]")) if (!details.contains(event.target) && (!conditionMenu || details.dataset.conditionMenu !== conditionMenu)) details.open = false;
    });
    const positionOpenMenus = () => form.querySelectorAll("details[open]").forEach((details) => IssueFilterControls.position(details));
    form.closest("dialog").addEventListener("scroll", positionOpenMenus, { passive: true });
    window.addEventListener("resize", positionOpenMenus);
    return {
      refresh() { widgets.forEach(renderOptions); },
      closeAll() { form.querySelectorAll("details[open]").forEach((details) => { details.open = false; }); },
    };
  },
};
