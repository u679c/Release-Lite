"""Validate and evaluate saved conditions against the local issue snapshot."""

import json


CONDITION_FIELDS = {
    "project",
    "version",
    "person",
    "status",
    "priority",
    "environment",
    "hierarchy",
    "scope",
}


def is_high_priority(row):
    return row["kind"] == "bugs" and row.get("priority") in {"紧急", "高"}


def normalize_conditions(payload, *, kind=None):
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except ValueError as exc:
            raise ValueError("筛选条件格式无效") from exc
    if payload is None:
        return {"logic": "and", "rules": []}
    if not isinstance(payload, dict) or payload.get("logic", "and") not in ("and", "or"):
        raise ValueError("筛选条件组合方式无效")
    rules = payload.get("rules", [])
    if not isinstance(rules, list) or len(rules) > 50:
        raise ValueError("筛选条件最多支持 50 条")
    normalized = []
    for rule in rules:
        if (
            not isinstance(rule, dict)
            or not isinstance(rule.get("field"), str)
            or rule["field"] not in CONDITION_FIELDS
            or rule.get("operator") not in ("includes", "excludes")
        ):
            raise ValueError("筛选条件无效")
        values = rule.get("values", [])
        if not isinstance(values, list) or not all(isinstance(value, str) for value in values):
            raise ValueError("筛选值格式无效")
        if kind == "requirements" and rule["field"] == "scope":
            values = [value for value in values if value not in ("urgent", "urgent_overdue")]
            if not values:
                continue
        normalized.append(
            {
                "field": rule["field"],
                "operator": rule["operator"],
                "values": list(dict.fromkeys(value for value in values if value)),
            }
        )
    return {"logic": payload.get("logic", "and"), "rules": normalized}


def matches_conditions(row, conditions):
    results = []
    for rule in conditions["rules"]:
        if not rule["values"]:
            continue
        field = rule["field"]
        if field == "person":
            values = [
                person["id"]
                for person in row.get("developers" if row["kind"] == "requirements" else "owners")
                or []
            ]
        elif field == "hierarchy":
            values = (
                ["child" if row["is_child"] else "main"] if row["kind"] == "requirements" else []
            )
        elif field == "scope":
            urgent = row["pending"] and is_high_priority(row)
            values = [
                name
                for name, matched in {
                    "pending": row["pending"],
                    "urgent": urgent,
                    "overdue": row["overdue"],
                    "urgent_overdue": urgent and row["overdue"],
                }.items()
                if matched
            ]
        else:
            value = row.get(field)
            values = value if isinstance(value, list) else [value] if value else []
        matches = bool(set(values or ["__empty__"]) & set(rule["values"]))
        results.append(not matches if rule["operator"] == "excludes" else matches)
    return (all(results) if conditions["logic"] == "and" else any(results)) if results else True
