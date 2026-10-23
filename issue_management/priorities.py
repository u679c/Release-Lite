"""Local requirement priorities shared by every member of a requirement family."""

import fcntl
import json
from pathlib import Path

from .storage import write_json


REQUIREMENT_PRIORITIES = ("P0", "P1", "P2", "P3")


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
        self.levels = tuple(levels)

    def _read(self):
        try:
            payload = json.loads((self.directory / "requirement-priorities.json").read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {"revision": 0, "assignments": {}}
        if not isinstance(payload, dict) or not isinstance(payload.get("revision"), int) or not isinstance(payload.get("assignments"), dict):
            raise ValueError("本地需求优先级数据格式不正确")
        for value in payload["assignments"].values():
            if not isinstance(value, dict) or value.get("priority") not in ("", *self.levels) or not isinstance(value.get("revision"), int):
                raise ValueError("本地需求优先级数据格式不正确")
        return payload

    def priorities(self, records):
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
        return {record_id: families.get(family, {}).get("priority", "") for record_id, family in roots.items()}

    def set_priority(self, records, record_id, priority):
        if not isinstance(priority, str) or priority not in ("", *self.levels):
            raise ValueError("需求优先级不正确")
        if not any(row["id"] == record_id for row in records):
            raise ValueError("未找到该需求，请同步数据后重试")
        roots = family_roots(records)
        members = [member for member, family in roots.items() if family == roots[record_id]]
        self.directory.mkdir(parents=True, exist_ok=True)
        with (self.directory / "requirement-priorities.lock").open("a+") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            payload = self._read()
            payload["revision"] += 1
            for member in members:
                payload["assignments"][member] = {"priority": priority, "revision": payload["revision"]}
            write_json(self.directory / "requirement-priorities.json", payload, indent=2)
        return {"priority": priority, "record_ids": members}
