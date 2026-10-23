/* Owns the memory graph history; the host supplies fresh samples. */
window.MemoryMonitor = (() => {
  let memoryHistory = [];
  const $ = selector => document.querySelector(selector);
  const api = ReleaseLite.request;
  function memoryNumber(n) {
    return n == null ? "-" : (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
  }
  function memoryChart() {
    const values = memoryHistory.length ? memoryHistory : [{
      value: 0,
      state: "normal"
    }];
    const width = 360,
      height = 58;
    // 活动监视器将正常至临界前的压力范围放大呈现，70 以上视为图表顶部。
    const point = (item, index) => `${index / Math.max(1, values.length - 1) * width},${height - Math.max(2, Math.min(height - 3, item.value / 70 * height))}`;
    const groups = [{
      state: values[0].state || "normal",
      points: [{
        index: 0,
        item: values[0]
      }]
    }];
    values.slice(1).forEach((item, offset) => {
      const index = offset + 1;
      const state = item.state || "normal";
      // 切色时与前一个区段共用一个采样点，避免两个填充区域间出现白缝。
      if (groups.at(-1).state !== state) groups.push({
        state,
        points: [{
          index: index - 1,
          item: values[index - 1]
        }]
      });
      groups.at(-1).points.push({
        index,
        item
      });
    });
    const parts = groups.map(group => {
      const first = group.points[0],
        last = group.points.at(-1);
      const line = group.points.map(({
        item,
        index
      }) => point(item, index)).join(" ");
      const startX = first.index / Math.max(1, values.length - 1) * width;
      const endX = last.index / Math.max(1, values.length - 1) * width;
      return `<polygon class="${group.state}" points="${startX},${height} ${line} ${endX},${height}"/><polyline class="${group.state}" points="${line}"/>`;
    }).join("");
    const time = timestamp => new Date(timestamp).toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    });
    return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">${parts}</svg><div class="memory-chart-times"><span>${time(values[0].timestamp || Date.now())}</span><span>现在 ${time(values.at(-1).timestamp || Date.now())}</span></div>`;
  }
  function renderMemoryMonitor(memory) {
    if (!memory || !$("#memoryMonitor")) return;
    memoryHistory.push({
      value: memory.pressure || 0,
      state: memory.pressure_state || "normal",
      timestamp: Date.now()
    });
    memoryHistory = memoryHistory.slice(-120);
    $("#memoryMonitor").innerHTML = `<div class="memory-pressure">` +
      `<div class="memory-pressure-title">内存压力` +
      `</div>` +
      `<div class="memory-chart">${memoryChart()}</div>` +
      `</div>` +
      `<div class="memory-summary">` +
      `<div>` +
      `<b>物理内存：</b>` +
      `<span>${memoryNumber(memory.total)}</span>` +
      `</div>` +
      `<div>` +
      `<b>已用内存：</b>` +
      `<span>${memoryNumber(memory.used)}</span>` +
      `</div>` +
      `<div>` +
      `<b>文件缓存：</b>` +
      `<span>${memoryNumber(memory.cached)}</span>` +
      `</div>` +
      `<div>` +
      `<b>交换空间：</b>` +
      `<span>${memoryNumber(memory.swap_used)}</span>` +
      `</div>` +
      `</div>` +
      `<div class="memory-breakdown">` +
      `<div>` +
      `<b>应用内存：</b>` +
      `<span>${memoryNumber(memory.app_memory)}</span>` +
      `</div>` +
      `<div>` +
      `<b>联动内存：</b>` +
      `<span>${memoryNumber(memory.wired_memory)}</span>` +
      `</div>` +
      `<div>` +
      `<b>压缩内存：</b>` +
      `<span>${memoryNumber(memory.compressed)}</span>` +
      `</div>` +
      `</div>`;
  }
  async function refreshMemory() {
    try {
      renderMemoryMonitor(await api("/api/system/memory"));
    } catch (e) {
      console.error(e);
    }
  }
  return {
    render: renderMemoryMonitor,
    refresh: refreshMemory
  };
})();
