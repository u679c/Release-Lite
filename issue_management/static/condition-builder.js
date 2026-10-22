/* Local condition editor: searchable fields/operators and multiple removable values. */
window.IssueConditionBuilder = {
  create(container, onChange) {
    const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
    let kind = "overview", options = {}, logic = "and", rules = [], nextId = 0;
    const fieldLabels = () => ({ project: "项目", version: "版本", person: kind === "requirements" ? "开发人员" : kind === "bugs" ? "处理人" : "开发人员 / 处理人", status: "状态", priority: "优先级", environment: "发现环境", hierarchy: "需求层级", scope: "待办范围" });
    function choices(field) {
      if (field === "hierarchy") return [["main", "主需求"], ["child", "子需求"]];
      if (field === "scope") return [["pending", "未结项"], ["urgent", "紧急 / 高优先级未结项"], ["overdue", "已逾期未结项"], ["urgent_overdue", "紧急 / 高优先级且逾期"]];
      return [["__empty__", "未填写"], ...(options[field] || []).map((value) => field === "person" ? [value.id, value.name] : [value, value])];
    }
    function ruleChoices(rule) {
      const available = choices(rule.field);
      for (const value of rule.values) if (!available.some(([key]) => key === value)) available.push([value, value]);
      return available;
    }
    function menu(rule, type, label, available, selected, multiple = false) {
      return `<details class="issue-project-dropdown issue-condition-dropdown" data-condition-menu="${rule.id}-${type}" data-rule-id="${rule.id}" data-rule-menu="${type}"><summary aria-label="${escape(label)}" aria-haspopup="listbox"><span class="${multiple ? "issue-condition-values" : ""}">${multiple && rule.values.length ? rule.values.map((value) => `<span class="issue-condition-chip">${escape(available.find(([key]) => key === value)?.[1] || value)}<button type="button" aria-label="移除筛选值" data-condition-action="remove-value" data-rule-id="${rule.id}" data-value="${escape(value)}">×</button></span>`).join("") : escape(label)}</span><i class="bi bi-chevron-down" aria-hidden="true"></i></summary><div class="issue-dropdown-panel"><input class="form-control form-control-sm issue-option-search" type="search" placeholder="搜索选项" aria-label="搜索${escape(label)}" autocomplete="off"><div class="issue-select-options" role="listbox" ${multiple ? 'aria-multiselectable="true"' : ""}>${available.map(([value, text]) => `<button type="button" class="issue-project-option" role="option" aria-selected="${selected.includes(value)}" data-condition-action="${type}" data-rule-id="${rule.id}" data-value="${escape(value)}"><span>${escape(text)}</span><i class="bi bi-check2" aria-hidden="true"></i></button>`).join("")}<span class="issue-dropdown-empty" hidden>无匹配选项</span></div></div></details>`;
    }
    function filterMenu(details) {
      const query = details.querySelector("input").value.trim().toLocaleLowerCase();
      const buttons = [...details.querySelectorAll('[role="option"]')];
      for (const button of buttons) button.hidden = !button.textContent.toLocaleLowerCase().includes(query);
      details.querySelector(".issue-dropdown-empty").hidden = buttons.some((button) => !button.hidden);
      IssueFilterControls.position(details);
    }
    function render() {
      const openMenus = [...container.querySelectorAll("details[open]")].map((details) => ({ key: details.dataset.conditionMenu, query: details.querySelector("input").value }));
      const labels = fieldLabels();
      const fields = Object.entries(labels).filter(([field]) => !(kind === "bugs" && field === "hierarchy") && !(kind === "requirements" && field === "environment"));
      container.innerHTML = rules.map((rule) => `<div class="issue-condition-row">${menu(rule, "field", labels[rule.field], fields, [rule.field])}${menu(rule, "operator", rule.operator === "excludes" ? "不包含" : "包含", [["includes", "包含"], ["excludes", "不包含"]], [rule.operator])}${menu(rule, "value", "请选择筛选值", ruleChoices(rule), rule.values, true)}<button type="button" class="issue-condition-remove" aria-label="删除此条件" data-condition-action="remove" data-rule-id="${rule.id}">×</button></div>`).join("") || '<p class="muted issue-condition-empty">暂无条件，点击下方“添加条件”开始筛选。</p>';
      for (const details of container.querySelectorAll("details")) {
        details.addEventListener("toggle", () => {
          if (!details.open || !details.closest("form")) return;
          for (const other of container.closest("form").querySelectorAll("details[open]")) if (other !== details) other.open = false;
          IssueFilterControls.position(details);
          if (details.dataset.restored) delete details.dataset.restored;
          else details.querySelector("input").focus();
        });
        const saved = openMenus.find((entry) => entry.key === details.dataset.conditionMenu);
        if (saved) {
          details.dataset.restored = "true";
          details.querySelector("input").value = saved.query;
          details.open = true;
          filterMenu(details);
        }
      }
      container.closest("form").querySelector("#issueAddCondition").disabled = rules.length >= 50;
    }
    function value() {
      return { logic, rules: rules.map(({ field, operator, values }) => ({ field, operator, values: [...values] })) };
    }
    function changed() { render(); onChange(value()); }
    container.addEventListener("input", (event) => {
      if (event.target.matches(".issue-option-search")) filterMenu(event.target.closest("details"));
    });
    container.addEventListener("click", (event) => {
      const button = event.target.closest("[data-condition-action]");
      if (!button) return;
      event.preventDefault();
      const rule = rules.find((item) => item.id === Number(button.dataset.ruleId));
      if (!rule) return;
      const action = button.dataset.conditionAction, selected = button.dataset.value;
      if (action === "remove") rules = rules.filter((item) => item !== rule);
      else if (action === "field") { rule.field = selected; rule.values = []; }
      else if (action === "operator") rule.operator = selected;
      else if (action === "remove-value") rule.values = rule.values.filter((item) => item !== selected);
      else if (action === "value") rule.values = rule.values.includes(selected) ? rule.values.filter((item) => item !== selected) : [...rule.values, selected];
      if (["field", "operator"].includes(action)) button.closest("details").open = false;
      changed();
      if (action === "value") [...container.querySelectorAll('[data-condition-action="value"]')].find((option) => option.dataset.ruleId === String(rule.id) && option.dataset.value === selected)?.focus();
    });
    container.addEventListener("keydown", (event) => {
      const details = event.target.closest("details");
      if (!details?.open) return;
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation(); details.open = false; details.querySelector("summary").focus();
      } else if (["ArrowDown", "ArrowUp"].includes(event.key)) {
        event.preventDefault();
        const buttons = [...details.querySelectorAll('[role="option"]')].filter((button) => !button.hidden);
        if (!buttons.length) return;
        const index = buttons.indexOf(document.activeElement);
        buttons[(index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length].focus();
      } else if (event.key === "Enter" && event.target.matches("input")) {
        event.preventDefault(); [...details.querySelectorAll('[role="option"]')].find((button) => !button.hidden)?.click();
      }
    });
    container.closest(".issue-module").addEventListener("click", (event) => {
      const conditionMenu = event.composedPath().find((node) => node.dataset?.conditionMenu)?.dataset.conditionMenu;
      for (const details of container.querySelectorAll("details[open]")) if (!details.contains(event.target) && details.dataset.conditionMenu !== conditionMenu) details.open = false;
    });
    return {
      value,
      set(nextKind, nextOptions, conditions) { kind = nextKind; options = nextOptions || {}; logic = conditions.logic; rules = conditions.rules.map((rule) => ({ ...rule, values: [...rule.values], id: nextId++ })); render(); },
      updateOptions(nextOptions) { if (JSON.stringify(options) !== JSON.stringify(nextOptions)) { options = nextOptions; render(); } },
      setLogic(nextLogic) { logic = nextLogic; onChange(value()); },
      add() { if (rules.length < 50) { rules.push({ id: nextId++, field: "person", operator: "includes", values: [] }); changed(); } },
    };
  },
};
