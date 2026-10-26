"""Local requirement priorities shared by every member of a requirement family."""

import fcntl
import json
import re
from collections import Counter
from pathlib import Path

from .storage import write_json


REQUIREMENT_PRIORITIES = ("P0", "P1", "P2", "P3")
DEFAULT_PRIORITY_COLOR = "#667085"


def family_roots(records):
    parents = {}

    def root(record_id):
        parents.setdefault(record_id, record_id)
        while parents[record_id] != record_id:
            parents[record_id] = parents[parents[record_id]]
            record_id = parents[record_id]
        return record_id

    for row in records:
        root(row["id"])
        for parent_id in row.get("parent_ids", []):
            parents[root(row["id"])] = root(parent_id)
    return {record_id: root(record_id) for record_id in list(parents)}


class RequirementPriorityStore:
    def __init__(self, directory, levels):
        self.directory = Path(directory)
        self.default_levels = [
            {"id": level, "name": level, "color": DEFAULT_PRIORITY_COLOR} for level in levels
        ]

    @staticmethod
    def _validate_levels(levels):
        if not isinstance(levels, list) or len(levels) > 50:
            raise ValueError("优先级最多支持 50 个")
        ids, names = set(), set()
        normalized = []
        for level in levels:
            if not isinstance(level, dict):
                raise ValueError("优先级数据无效")
            identifier, name = level.get("id"), level.get("name")
            if not isinstance(identifier, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", identifier):
                raise ValueError("优先级 ID 无效")
            if not isinstance(name, str) or not name.strip() or len(name.strip()) > 30:
                raise ValueError("优先级名称须为 1～30 个字符")
            name = name.strip()
            color = level.get("color", DEFAULT_PRIORITY_COLOR)
            if not isinstance(color, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", color):
                raise ValueError("请选择有效的优先级颜色")
            if identifier in ids or name.casefold() in names:
                raise ValueError("优先级名称不能重复")
            ids.add(identifier)
            names.add(name.casefold())
            normalized.append({"id": identifier, "name": name, "color": color.lower()})
        return normalized

    def _read(self):
        try:
            payload = json.loads(
                (self.directory / "requirement-priorities.json").read_text(encoding="utf-8")
            )
        except FileNotFoundError:
            return {"revision": 0, "config_revision": 0, "levels": self.default_levels, "assignments": {}}
        if (
            not isinstance(payload, dict)
            or not isinstance(payload.get("revision"), int)
            or not isinstance(payload.get("assignments"), dict)
        ):
            raise ValueError("需求优先级数据无效")
        payload["levels"] = self._validate_levels(payload.get("levels", self.default_levels))
        payload.setdefault("config_revision", 0)
        if type(payload["config_revision"]) is not int or payload["config_revision"] < 0:
            raise ValueError("需求优先级配置版本无效")
        names = [level["name"] for level in payload["levels"]]
        for value in payload["assignments"].values():
            if (
                not isinstance(value, dict)
                or value.get("priority") not in ("", *names)
                or not isinstance(value.get("revision"), int)
            ):
                raise ValueError("需求优先级数据无效")
        return payload

    def configuration(self):
        return self.state([])["configuration"]

    @staticmethod
    def _configuration(payload):
        usage = Counter(value["priority"] for value in payload["assignments"].values())
        return {
            "levels": [dict(level, usage_count=usage[level["name"]]) for level in payload["levels"]],
            "revision": payload["config_revision"],
        }

    def configure(self, levels, expected_revision):
        levels = self._validate_levels(levels)
        if type(expected_revision) is not int or expected_revision < 0:
            raise ValueError("优先级配置版本无效，请重新打开弹窗")
        self.directory.mkdir(parents=True, exist_ok=True)
        with (self.directory / "requirement-priorities.lock").open("a+") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            payload = self._read()
            if payload["config_revision"] != expected_revision:
                raise ValueError("优先级配置已被更新，请重新打开弹窗后修改")
            previous = {level["name"]: level["id"] for level in payload["levels"]}
            updated = {level["id"]: level["name"] for level in levels}
            for assignment in payload["assignments"].values():
                name = assignment["priority"]
                if name and previous[name] not in updated:
                    raise ValueError(f"「{name}」已被需求使用，请先调整这些需求的优先级")
            # Stable IDs preserve assignments through renames, including swapped names.
            for assignment in payload["assignments"].values():
                name = assignment["priority"]
                if name:
                    assignment["priority"] = updated[previous[name]]
            payload["levels"] = levels
            payload["config_revision"] += 1
            write_json(self.directory / "requirement-priorities.json", payload, indent=2)
        return self._configuration(payload)

    def state(self, records):
        self.directory.mkdir(parents=True, exist_ok=True)
        with (self.directory / "requirement-priorities.lock").open("a+") as lock:
            fcntl.flock(lock, fcntl.LOCK_SH)
            payload = self._read()
        roots = family_roots(records)
        families = {}
        for record_id, family in roots.items():
            assignment = payload["assignments"].get(record_id)
            if assignment and assignment["revision"] > families.get(family, {}).get("revision", -1):
                families[family] = assignment
        priorities = {
            record_id: families.get(family, {}).get("priority", "")
            for record_id, family in roots.items()
        }
        return {
            "configuration": self._configuration(payload),
            "priorities": priorities,
        }

    def priorities(self, records):
        return self.state(records)["priorities"]

    def set_priority(self, records, record_id, priority):
        if not any(row["id"] == record_id for row in records):
            raise ValueError("未找到该需求，请同步数据后重试")
        roots = family_roots(records)
        members = [member for member, family in roots.items() if family == roots[record_id]]
        self.directory.mkdir(parents=True, exist_ok=True)
        with (self.directory / "requirement-priorities.lock").open("a+") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            payload = self._read()
            if not isinstance(priority, str) or priority not in ("", *(level["name"] for level in payload["levels"])):
                raise ValueError("需求优先级不正确，请刷新后重试")
            payload["revision"] += 1
            for member in members:
                payload["assignments"][member] = {
                    "priority": priority,
                    "revision": payload["revision"],
                }
            write_json(self.directory / "requirement-priorities.json", payload, indent=2)
        return {"priority": priority, "record_ids": members}
