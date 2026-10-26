/* New bug alerts share a baseline across pages, but only automatic syncs can notify. */
window.BugNotifications = (() => {
  const storageKey = "release-lite-bug-notifications-enabled";
  const browserSupported = () => window.isSecureContext && "Notification" in window;

  function showInApp(message) {
    const notice = document.createElement("section");
    notice.className = "issue-bug-notification";
    notice.setAttribute("role", "status");
    const heading = document.createElement("strong");
    heading.textContent = message.title;
    const body = document.createElement("p");
    body.textContent = message.body;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "issue-bug-notification-close";
    close.setAttribute("aria-label", "关闭通知");
    close.textContent = "×";
    close.addEventListener("click", () => notice.remove());
    notice.append(heading, close, body);
    if (message.onOpen) {
      const view = document.createElement("button");
      view.type = "button";
      view.className = "btn btn-outline-primary btn-sm";
      view.textContent = "查看";
      view.addEventListener("click", message.onOpen);
      notice.appendChild(view);
    }
    document.querySelector("#bugNotificationContainer").appendChild(notice);
    return notice;
  }

  function showBrowser(message) {
    if (!browserSupported()) throw new Error("浏览器通知不可用，请使用 HTTPS 或本机地址");
    if (Notification.permission !== "granted") throw new Error("浏览器通知未授权，请在网站设置中允许通知");
    const notification = new Notification(message.title, {
      body: message.body,
      icon: "/static/favicon.png",
      tag: message.tag,
    });
    notification.addEventListener("click", () => {
      window.focus();
      message.onOpen?.();
      notification.close();
    });
    notification.addEventListener("error", () => {
      if (message.onError) message.onError();
      else showInApp(message);
    }, { once: true });
    return notification;
  }

  function show(message, mode = "auto") {
    if (mode === "in-app" || (mode === "auto" && document.visibilityState === "visible" && document.hasFocus())) {
      return showInApp(message);
    }
    try {
      return showBrowser(message);
    } catch (error) {
      if (mode === "browser") throw error;
      return showInApp(message);
    }
  }

  function create(button, onChange) {
    let enabled = false;
    let scope = null;
    let seenIds = null;
    let automaticSyncId = null;
    try {
      enabled = localStorage.getItem(storageKey) === "1";
    } catch {
      /* Notifications remain available for this page when storage is restricted. */
    }

    function reset() {
      scope = null;
      seenIds = null;
      automaticSyncId = null;
    }

    function render() {
      button.setAttribute("aria-pressed", String(enabled));
      button.classList.toggle("btn-outline-primary", enabled);
      button.classList.toggle("btn-outline-secondary", !enabled);
      button.querySelector("i").className = `bi bi-bell${enabled ? "-fill" : ""}`;
      button.title = enabled ? "新 Bug 提醒已开启，点击关闭" : "自动同步发现新 Bug 时提醒";
    }

    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        if (!enabled && browserSupported() && Notification.permission === "default") {
          await Notification.requestPermission();
        }
        enabled = !enabled;
        reset();
        try {
          localStorage.setItem(storageKey, enabled ? "1" : "0");
        } catch {
          /* Keep the in-memory preference. */
        }
        render();
        onChange();
        if (enabled && (!browserSupported() || Notification.permission !== "granted")) {
          toast("站内提醒已开启，浏览器通知未授权", "info");
        }
      } catch {
        toast("通知授权失败，请重试", "error");
      } finally {
        button.disabled = false;
      }
    });

    window.addEventListener("storage", (event) => {
      if (event.key !== storageKey && event.key !== null) return;
      enabled = event.key === storageKey && event.newValue === "1";
      reset();
      render();
      onChange();
    });

    function summary(records) {
      return records.slice(0, 3).map((row) => String(row.title || "无标题")
        .replace(/^\[([\s\S]*)\]\(https?:\/\/[^\s]+\)$/, "$1").slice(0, 100)).join("\n");
    }

    function notify(records, onOpen) {
      show({
        title: `新增 ${records.length} 个 Bug`,
        body: summary(records),
        tag: `release-lite-bugs-${records.map((row) => row.id).sort().join(",")}`,
        onOpen: () => onOpen(records.length === 1 ? records[0].id : null),
      });
    }

    function beginSync(syncId, automatic) {
      automaticSyncId = automatic ? syncId : null;
    }

    function observe(payload, nextScope, sync, allowNotify, onOpen) {
      if (!payload || !sync.ready || sync.stale || sync.syncing || sync.error) return;
      if (scope !== nextScope || seenIds === null) {
        scope = nextScope;
        seenIds = new Set(payload.all_ids);
        automaticSyncId = null;
        return;
      }
      const records = payload.items.filter((row) => !seenIds.has(row.id));
      for (const id of payload.all_ids) seenIds.add(id);
      const shouldNotify = enabled && allowNotify && automaticSyncId && automaticSyncId === payload.sync_id;
      automaticSyncId = null;
      if (shouldNotify && records.length) notify(records, onOpen);
    }

    render();
    return { beginSync, observe, reset };
  }

  return { create, show };
})();
