"""Host network, disk and memory measurements used by the overview APIs."""

import os
import re
import socket
import subprocess
from pathlib import Path

import psutil


def server_ip():
    # 优先取默认路由对应的网卡地址，而不是 hostname 解析出的回环地址。
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(("8.8.8.8", 80))
            address = probe.getsockname()[0]
            if address and not address.startswith("127."):
                return address
    except OSError:
        pass
    states = psutil.net_if_stats()
    for interface, addresses in psutil.net_if_addrs().items():
        if not states.get(interface) or not states[interface].isup:
            continue
        for address in addresses:
            if address.family == socket.AF_INET and not address.address.startswith(
                ("127.", "169.254.")
            ):
                return address.address
    return "127.0.0.1"


def system_disk_usage():
    # macOS 的 / 是只读系统卷；真实用户文件和应用占用在 APFS Data 卷中。
    # Linux/Windows 环境则继续使用系统根卷。
    data_volume = Path("/System/Volumes/Data")
    if os.uname().sysname == "Darwin" and data_volume.is_dir():
        return psutil.disk_usage(str(data_volume))
    return psutil.disk_usage("/")


def mac_vm_stat():
    """Return Activity Monitor-style memory buckets when running on macOS."""
    try:
        output = subprocess.check_output(["vm_stat"], text=True, stderr=subprocess.DEVNULL)
        page_size_match = re.search(r"page size of (\d+) bytes", output)
        page_size = int(page_size_match.group(1)) if page_size_match else 4096
        pages = {}
        for name, value in re.findall(r"^([^:\n]+):\s+(\d+)\.", output, re.MULTILINE):
            pages[name.strip().lower()] = int(value)

        def size(name):
            return pages.get(name, 0) * page_size

        wired = size("pages wired down")
        compressed = size("pages occupied by compressor")
        cached = size("pages purgeable") + size("file-backed pages")
        # 匿名页最接近活动监视器中的 App 内存；系统较旧时回退为已用内存差值。
        app_memory = size("anonymous pages") or max(
            0, psutil.virtual_memory().used - wired - compressed
        )
        return {
            "app_memory": app_memory,
            "wired_memory": wired,
            "compressed": compressed,
            "cached": cached,
        }
    except (OSError, subprocess.SubprocessError, ValueError):
        return None


def mac_memory_pressure():
    """Activity Monitor's pressure signal is based on reclaimable/free pages."""
    try:
        output = subprocess.check_output(
            ["memory_pressure", "-Q"], text=True, stderr=subprocess.DEVNULL
        )
        match = re.search(r"memory free percentage:\s*(\d+)%", output, re.IGNORECASE)
        return 100 - int(match.group(1)) if match else None
    except (OSError, subprocess.SubprocessError, ValueError):
        return None


def mac_pressure_state():
    """Activity Monitor uses this private kernel pressure state for graph colour."""
    try:
        output = subprocess.check_output(
            ["sysctl", "-n", "kern.memorystatus_vm_pressure_level"],
            text=True,
            stderr=subprocess.DEVNULL,
        )
        return {1: "normal", 2: "warning", 4: "critical"}.get(int(output.strip()))
    except (OSError, subprocess.SubprocessError, ValueError):
        # This kernel key is protected on many macOS releases for non-entitled apps.
        return None


def system_memory_details():
    vm = psutil.virtual_memory()
    details = mac_vm_stat() if os.uname().sysname == "Darwin" else None
    if details is None:
        cached = getattr(vm, "cached", 0)
        buffers = getattr(vm, "buffers", 0)
        details = {
            "app_memory": max(0, vm.used - cached - buffers),
            "wired_memory": 0,
            "compressed": 0,
            "cached": cached,
        }
    try:
        swap_used = psutil.swap_memory().used
    except (psutil.Error, OSError):
        # 某些受限运行环境不允许读取 swap 计数，其他内存数据仍可正常展示。
        swap_used = 0
    # 活动监视器的“已使用内存”以可回收的缓存文件为界，而 psutil.used 是跨平台估算值。
    is_macos = os.uname().sysname == "Darwin"
    used = max(0, vm.total - details["cached"]) if is_macos and details else vm.used
    pressure = mac_memory_pressure() if is_macos else None
    native_state = mac_pressure_state() if is_macos else None
    # 截图中黄色/绿色转换与可回收缓存约 15% 的物理内存高度吻合；红色保留给极低余量。
    cached_ratio = details["cached"] / vm.total if vm.total else 0
    pressure_state = native_state or (
        "critical" if cached_ratio < 0.10 else "warning" if cached_ratio < 0.16 else "normal"
    )
    return {
        "total": vm.total,
        "used": used,
        "cached": details["cached"],
        "app_memory": details["app_memory"],
        "wired_memory": details["wired_memory"],
        "compressed": details["compressed"],
        "swap_used": swap_used,
        "pressure": vm.percent if pressure is None else pressure,
        "pressure_state": pressure_state,
        "pressure_source": "macos" if native_state else "estimated",
    }
