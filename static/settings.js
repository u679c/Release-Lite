/* Local requirement priority configuration. Changes are committed on Save. */
(() => {
  const dialog = document.querySelector("#requirementPrioritiesDialog");
  const list = dialog.querySelector("#requirementPriorityList");
  const message = dialog.querySelector("#requirementPriorityMessage");
  const add = dialog.querySelector("#addRequirementPriority");
  const save = dialog.querySelector("#saveRequirementPriorities");
  const escape = ReleaseLite.escapeHtml;
  let levels = [], revision = 0, busy = false, loaded = false, dragging = null;

  Coloris({
    el: "[data-priority-color]",
    wrap: false,
    parent: dialog,
    theme: "polaroid",
    format: "hex",
    alpha: false,
    closeButton: true,
    closeLabel: "完成",
    swatches: [
      "#f14666", "#ec8b80", "#ffd1aa", "#9cbb98",
      "#e98aa2", "#b9cc8e", "#fad59a", "#f9e8c8",
      "#f3533a", "#ffa142", "#95d074", "#54cfc9"
    ],
    a11y: {
      open: "调整颜色",
      close: "完成",
      clear: "清除颜色",
      marker: "饱和度：{s}，亮度：{v}",
      hueSlider: "色相",
      alphaSlider: "透明度",
      input: "颜色值",
      format: "颜色格式",
      swatch: "预设颜色",
      instruction: "用方向键调整饱和度和亮度"
    }
  });

  function status(text = "", failed = false) {
    message.textContent = text;
    message.title = text;
    message.classList.toggle("text-danger", failed);
  }
  function setBusy(value) {
    busy = value;
    if (value) Coloris.close();
    list.inert = value;
    add.disabled = value || !loaded || levels.length >= 50;
    save.disabled = value || !loaded;
    dialog.querySelectorAll("#closeRequirementPriorities, #cancelRequirementPriorities").forEach(button => {
      button.disabled = value;
    });
    dialog.setAttribute("aria-busy", String(value));
  }
  function render() {
    Coloris.close();
    list.innerHTML = levels.map((level, index) => `<div class="priority-settings-row" data-level-id="${escape(level.id)}">
      <button class="priority-settings-drag" type="button" draggable="true" aria-label="调整第 ${index + 1} 项顺序：拖动或按上下方向键" title="拖动或按上下方向键排序"><i class="bi bi-grip-vertical" aria-hidden="true"></i><span>${index + 1}</span></button>
      <input class="form-control form-control-sm" data-priority-name type="text" value="${escape(level.name)}" maxlength="30" required aria-label="第 ${index + 1} 个优先级名称" placeholder="优先级名称" />
      <div class="priority-settings-color">
        <button class="priority-settings-preview" type="button" data-priority-preview style="${ReleaseLite.priorityStyle(level.color)}" aria-label="调整第 ${index + 1} 个优先级颜色">${escape(level.name || "预览")}</button>
        <input class="priority-settings-color-input" data-priority-color type="text" value="${escape(level.color || ReleaseLite.defaultPriorityColor)}" readonly tabindex="-1" aria-hidden="true" />
      </div>
      <div class="priority-settings-actions"><span class="muted">${level.usage_count ? `${level.usage_count} 条需求` : "未使用"}</span>
      <span class="priority-settings-delete" title="${level.usage_count ? "使用中的优先级不可删除，请先调整对应需求。" : "删除优先级"}"><button class="btn btn-outline-danger btn-sm" type="button" data-delete-level ${level.usage_count ? "disabled" : ""} aria-label="删除第 ${index + 1} 个优先级${level.usage_count ? "，使用中，请先调整对应需求" : ""}"><i class="bi bi-trash" aria-hidden="true"></i></button></span></div>
    </div>`).join("") || '<p class="priority-settings-empty muted">暂无优先级</p>';
    add.disabled = busy || !loaded || levels.length >= 50;
  }
  document.querySelector("#openRequirementPriorities").addEventListener("click", async () => {
    if (dialog.open) return;
    levels = [];
    loaded = false;
    list.replaceChildren();
    status("加载中…");
    dialog.showModal();
    setBusy(true);
    try {
      const result = await ReleaseLite.request("/api/issues/requirement-priorities");
      levels = result.levels;
      revision = result.revision;
      loaded = true;
      render();
      status();
    } catch (error) {
      status(`加载失败：${error.message}。请重新打开弹窗。`, true);
    } finally {
      setBusy(false);
    }
  });
  for (const id of ["closeRequirementPriorities", "cancelRequirementPriorities"]) {
    dialog.querySelector(`#${id}`).addEventListener("click", () => {
      if (!busy) dialog.close();
    });
  }
  dialog.addEventListener("cancel", event => {
    if (busy || dialog.querySelector(".clr-open")) {
      event.preventDefault();
      Coloris.close();
    }
  });
  dialog.addEventListener("keydown", event => {
    if (event.key === "Escape" && dialog.querySelector(".clr-open")) {
      event.preventDefault();
      event.stopPropagation();
      Coloris.close(true);
    }
  });
  dialog.addEventListener("close", () => Coloris.close());
  dialog.querySelector(".priority-settings-body").addEventListener("scroll", () => Coloris.close());
  add.addEventListener("click", () => {
    if (busy || !loaded || levels.length >= 50) return;
    const id = `priority_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    levels.push({id, name: "", color: ReleaseLite.defaultPriorityColor, usage_count: 0});
    render();
    status();
    list.lastElementChild.querySelector("[data-priority-name]").focus();
  });
  list.addEventListener("input", event => {
    if (!event.target.matches("[data-priority-name], [data-priority-color]") || busy) return;
    const row = event.target.closest("[data-level-id]");
    const level = levels.find(item => item.id === row.dataset.levelId);
    const preview = row.querySelector("[data-priority-preview]");
    if (event.target.matches("[data-priority-color]")) {
      const value = event.target.value;
      const color = /^#[0-9a-f]{3}$/i.test(value) ? `#${[...value.slice(1)].map(char => char + char).join("")}` : value;
      if (!/^#[0-9a-f]{6}$/i.test(color)) return;
      level.color = color.toLowerCase();
      preview.style.cssText = ReleaseLite.priorityStyle(level.color);
    } else {
      level.name = event.target.value;
      preview.textContent = level.name || "预览";
      event.target.setCustomValidity("");
    }
    status();
  });
  list.addEventListener("click", event => {
    const preview = event.target.closest("[data-priority-preview]");
    if (preview && !busy) {
      preview.parentElement.querySelector("[data-priority-color]").click();
      return;
    }
    const button = event.target.closest("[data-delete-level]");
    if (!button || button.disabled || busy) return;
    const row = button.closest("[data-level-id]");
    const index = levels.findIndex(level => level.id === row.dataset.levelId);
    levels.splice(index, 1);
    render();
    status();
    (list.children[Math.min(index, levels.length - 1)]?.querySelector("[data-priority-name]") || add).focus();
  });
  list.addEventListener("keydown", event => {
    if (!event.target.matches(".priority-settings-drag") || busy || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const index = levels.findIndex(level => level.id === event.target.closest("[data-level-id]").dataset.levelId);
    const target = index + (event.key === "ArrowUp" ? -1 : 1);
    if (target < 0 || target >= levels.length) return;
    [levels[index], levels[target]] = [levels[target], levels[index]];
    render();
    list.children[target].querySelector(".priority-settings-drag").focus();
    status(`已移至第 ${target + 1} 位，保存后生效`);
  });
  list.addEventListener("dragstart", event => {
    const handle = event.target.closest(".priority-settings-drag");
    if (!handle || busy) return event.preventDefault();
    dragging = handle.closest("[data-level-id]");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", dragging.dataset.levelId);
    dragging.classList.add("dragging");
  });
  list.addEventListener("dragover", event => {
    if (!dragging || busy) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const target = event.target.closest("[data-level-id]");
    if (!target || target === dragging) return;
    const bounds = target.getBoundingClientRect();
    list.insertBefore(dragging, event.clientY < bounds.top + bounds.height / 2 ? target : target.nextSibling);
  });
  list.addEventListener("drop", event => {
    if (dragging) event.preventDefault();
  });
  list.addEventListener("dragend", () => {
    if (!dragging) return;
    const movedId = dragging.dataset.levelId;
    const byId = new Map(levels.map(level => [level.id, level]));
    levels = [...list.querySelectorAll("[data-level-id]")].map(row => byId.get(row.dataset.levelId));
    dragging = null;
    render();
    [...list.children].find(row => row.dataset.levelId === movedId)?.querySelector(".priority-settings-drag").focus();
    status("顺序已调整，保存后生效");
  });
  save.addEventListener("click", async () => {
    if (busy || !loaded) return;
    const names = new Set();
    for (const input of list.querySelectorAll("[data-priority-name]")) {
      const name = input.value.trim();
      input.setCustomValidity(!name ? "请输入优先级名称" : names.has(name.toLowerCase()) ? "优先级名称不能重复" : "");
      if (!input.reportValidity()) return;
      names.add(name.toLowerCase());
    }
    setBusy(true);
    status();
    save.textContent = "保存中…";
    try {
      await ReleaseLite.request("/api/issues/requirement-priorities", {
        method: "PUT",
        body: JSON.stringify({revision, levels: levels.map(({id, name, color}) => ({id, name: name.trim(), color}))})
      });
      dialog.close();
      toast("需求优先级已保存", "success");
    } catch (error) {
      status(`保存失败：${error.message}`, true);
    } finally {
      save.textContent = "保存";
      setBusy(false);
    }
  });
})();
