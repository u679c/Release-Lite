/* This page sends local test messages only; scheduled tasks are not persisted. */
(() => {
  const form = document.querySelector("#notificationTestForm");
  const status = document.querySelector("#notificationTestStatus");
  const permission = document.querySelector("#notificationPermission");
  const authorize = document.querySelector("#authorizeNotifications");
  const taskList = document.querySelector("#notificationTasks");
  const empty = document.querySelector("#notificationTasksEmpty");
  const cancelAll = document.querySelector("#cancelAllNotifications");
  const tasks = new Map();
  const modeLabels = { auto: "自动选择", "in-app": "站内通知", browser: "浏览器通知" };
  let nextId = 0;
  let countdown = null;

  function setStatus(message, failed = false) {
    status.textContent = message;
    status.classList.toggle("text-danger", failed);
    status.classList.toggle("text-success", !failed);
  }

  function renderPermission() {
    const supported = window.isSecureContext && "Notification" in window;
    const granted = supported && Notification.permission === "granted";
    permission.textContent = supported
      ? { default: "通知未授权", granted: "通知已授权", denied: "通知已阻止" }[Notification.permission]
      : "浏览器通知不可用";
    permission.classList.toggle("text-bg-success", granted);
    permission.classList.toggle("text-bg-secondary", !granted);
    authorize.disabled = !supported || granted;
  }

  async function requestPermission() {
    if (!window.isSecureContext || !("Notification" in window)) return false;
    if (Notification.permission === "default") await Notification.requestPermission();
    renderPermission();
    return Notification.permission === "granted";
  }

  authorize.addEventListener("click", async () => {
    authorize.disabled = true;
    try {
      const granted = await requestPermission();
      setStatus(granted ? "浏览器通知已授权" : "请在浏览器的网站设置中允许通知", !granted);
    } catch {
      setStatus("通知授权失败，请重试", true);
    } finally {
      renderPermission();
    }
  });

  function updateCountdowns() {
    for (const task of tasks.values()) {
      const seconds = Math.max(0, Math.ceil((task.dueAt - Date.now()) / 1000));
      task.count.textContent = `${modeLabels[task.mode]} · ${seconds} 秒后发送`;
    }
  }

  function updateTasks() {
    empty.hidden = tasks.size > 0;
    cancelAll.hidden = tasks.size === 0;
    if (tasks.size && countdown === null) countdown = setInterval(updateCountdowns, 1000);
    if (!tasks.size && countdown !== null) {
      clearInterval(countdown);
      countdown = null;
    }
    updateCountdowns();
  }

  function cancelTask(id) {
    const task = tasks.get(id);
    if (!task) return;
    clearTimeout(task.timer);
    task.element.remove();
    tasks.delete(id);
    updateTasks();
  }

  function send(message, mode) {
    try {
      BugNotifications.show({
        ...message,
        onError: () => setStatus("浏览器通知发送失败，请检查浏览器和系统通知设置", true),
      }, mode);
      setStatus("测试通知已发送");
    } catch (error) {
      setStatus(error.message, true);
    }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const message = { title: form.elements.title.value.trim(), body: form.elements.body.value.trim() };
    const mode = form.elements.mode.value;
    const delay = Number(form.elements.delay.value);
    if (!message.title || !message.body) return setStatus("请填写标题和内容", true);
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      if (mode !== "in-app") {
        const granted = await requestPermission();
        if (mode === "browser" && !granted) {
          setStatus("浏览器通知未授权，请先允许通知", true);
          return;
        }
      }
      if (delay === 0) {
        send(message, mode);
        return;
      }
      const id = ++nextId;
      const element = document.createElement("li");
      const description = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = message.title;
      const count = document.createElement("small");
      description.append(title, count);
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "btn btn-outline-secondary btn-sm";
      cancel.textContent = "取消";
      cancel.addEventListener("click", () => {
        cancelTask(id);
        setStatus("已取消发送");
      });
      element.append(description, cancel);
      taskList.appendChild(element);
      const timer = setTimeout(() => {
        tasks.delete(id);
        element.remove();
        updateTasks();
        send(message, mode);
      }, delay * 1000);
      tasks.set(id, { element, count, timer, mode, dueAt: Date.now() + delay * 1000 });
      updateTasks();
      setStatus(`将在 ${delay} 秒后发送`);
    } catch {
      setStatus("通知授权失败，请重试", true);
    } finally {
      submit.disabled = false;
      renderPermission();
    }
  });

  cancelAll.addEventListener("click", () => {
    for (const id of tasks.keys()) cancelTask(id);
    setStatus("已取消全部发送");
  });
  window.addEventListener("focus", renderPermission);
  renderPermission();
})();
