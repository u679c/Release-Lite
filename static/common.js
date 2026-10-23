/* Shared browser helpers. Load before page modules. */
window.ReleaseLite = {
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
