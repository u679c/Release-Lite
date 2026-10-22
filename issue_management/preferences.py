"""Shared, per-page filters and auto-sync settings; date ranges are excluded."""

import fcntl
import json
import os
import tempfile
from pathlib import Path

from .conditions import normalize_conditions


FILTER_KEYS = ("q", "project", "version", "person", "status", "priority", "environment", "hierarchy", "scope", "include_family")
AUTO_SYNC_CHILDREN = ("requirements", "bugs")


def normalize_preferences(payload):
    if not isinstance(payload, dict) or not isinstance(payload.get("filters", {}), dict):
        raise ValueError("筛选配置格式不正确")
    auto_sync = payload.get("auto_sync", False)
    if not isinstance(auto_sync, bool):
        raise ValueError("自动同步配置必须为布尔值")
    filters = {}
    for key in FILTER_KEYS:
        value = payload.get("filters", {}).get(key, "")
        if key == "include_family" and value not in ("", "0", "1"):
            raise ValueError("父记录和兄弟元素开关格式不正确")
        if key == "project" and isinstance(value, list) and all(isinstance(item, str) for item in value):
            filters[key] = list(dict.fromkeys(item for item in value if item))
        elif isinstance(value, str):
            filters[key] = value
        else:
            raise ValueError("筛选值格式不正确")
    projects = payload.get("requirement_projects", [])
    if not isinstance(projects, list) or not all(isinstance(item, str) for item in projects):
        raise ValueError("项目多选配置格式不正确")
    projects = list(dict.fromkeys(item for item in projects if item))
    active = payload.get("active_project", "")
    if not isinstance(active, str):
        raise ValueError("项目 tab 配置格式不正确")
    condition_filter = payload.get("condition_filter")
    if condition_filter is None:
        # Migrate previously saved single-value filters without losing user choices.
        rules = []
        for key in FILTER_KEYS:
            value = filters.get(key)
            if key in ("q", "include_family") or (key == "project" and projects) or not value:
                continue
            rules.append({"field": key, "operator": "includes", "values": value if isinstance(value, list) else [value]})
        condition_filter = {"logic": "and", "rules": rules}
    return {"filters": filters, "condition_filter": normalize_conditions(condition_filter), "requirement_projects": projects, "active_project": active if active in projects else "", "auto_sync": auto_sync}


def auto_sync_settings(saved):
    children = {kind: normalize_preferences(saved.get(kind, {}))["auto_sync"] for kind in AUTO_SYNC_CHILDREN}
    return {**children, "overview": all(children.values())}


def preference_response(saved, kind):
    settings = auto_sync_settings(saved)
    return {
        **normalize_preferences(saved.get(kind, {})), "auto_sync": settings[kind],
        "auto_sync_states": settings,
        "auto_sync_indeterminate": kind == "overview" and settings["requirements"] != settings["bugs"],
    }


class PreferenceStore:
    def __init__(self, directory):
        self.directory = Path(directory)

    def access(self, kind, payload=None, *, patch=False):
        if patch and (not isinstance(payload, dict) or set(payload) != {"auto_sync"} or not isinstance(payload["auto_sync"], bool)):
            raise ValueError("自动同步配置格式不正确")
        normalized = normalize_preferences(payload) if payload is not None and not patch else None
        self.directory.mkdir(parents=True, exist_ok=True)
        path = self.directory / "preferences.json"
        with (self.directory / "preferences.lock").open("a+") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            try:
                try:
                    saved = json.loads(path.read_text(encoding="utf-8"))
                except FileNotFoundError:
                    saved = {}
                if not isinstance(saved, dict):
                    raise ValueError("服务器筛选配置格式不正确")
                current = normalize_preferences(saved.get(kind, {}))
                current["auto_sync"] = auto_sync_settings(saved)[kind]
                if payload is None:
                    return preference_response(saved, kind)
                if patch:
                    normalized = {**current, "auto_sync": payload["auto_sync"]}
                elif "auto_sync" not in payload:
                    # Filter changes from another tab must not reset the server's Auto setting.
                    normalized["auto_sync"] = current["auto_sync"]
                saved[kind] = normalized
                if kind == "overview" and "auto_sync" in payload:
                    for child in AUTO_SYNC_CHILDREN:
                        saved[child] = {**normalize_preferences(saved.get(child, {})), "auto_sync": payload["auto_sync"]}
                # The parent is always derived from both children; commit the linkage atomically.
                saved["overview"] = {**normalize_preferences(saved.get("overview", {})), "auto_sync": auto_sync_settings(saved)["overview"]}
                temporary_path = None
                try:
                    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=self.directory, suffix=".tmp", delete=False) as stream:
                        temporary_path = Path(stream.name)
                        json.dump(saved, stream, ensure_ascii=False, indent=2)
                    os.replace(temporary_path, path)
                finally:
                    if temporary_path is not None:
                        temporary_path.unlink(missing_ok=True)
                return preference_response(saved, kind)
            finally:
                fcntl.flock(lock, fcntl.LOCK_UN)
