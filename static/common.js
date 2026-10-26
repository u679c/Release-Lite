/* Shared browser helpers. Load before page modules. */
window.ReleaseLite = {
  defaultPriorityColor: "#667085",
  priorityStyle(color) {
    const background = /^#[0-9a-f]{6}$/i.test(color || "") ? color : this.defaultPriorityColor;
    const channels = background.slice(1).match(/../g).map(value => {
      const channel = parseInt(value, 16) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    const foreground = luminance > 0.55 ? "#101828" : "#ffffff";
    return `--issue-priority-ink:${foreground};--issue-priority-bg:${background}`;
  },
  escapeHtml(value = "") {
    return String(value ?? "").replace(/[&<>"']/g, char => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[char]);
  },
  async request(url, options = {}) {
    const {
      headers,
      ...rest
    } = options;
    const response = await fetch(url, {
      ...rest,
      headers: {
        "Content-Type": "application/json",
        ...headers
      }
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "请求失败");
    return result;
  }
};
