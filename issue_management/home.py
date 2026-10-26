"""Compact homepage attention queue from the last synced issue records."""

from datetime import date

from .dashboard import calendar_date, is_pending_requirement, needs_bug_attention
from .hierarchy import requirement_groups


def parent_requirements(requirements, records, include_family):
    """Keep real parents and retain a matching record for filtered list navigation."""
    matched_ids = {row["id"] for row in requirements}
    parents = []
    for group in requirement_groups(records, matched_ids, include_family):
        parent = group[0]
        if parent.get("is_child") or parent.get("parent_ids"):
            continue
        match_id = next((row["id"] for row in group if row["filter_match"]), None)
        if match_id is not None:
            parents.append(dict(parent, match_id=match_id))
    return parents


def home_summary(
    snapshot,
    today,
    pre_test_statuses,
    terminal_bug_statuses,
    *,
    requirement_records=None,
    include_family=False,
):
    requirements = [
        row
        for row in snapshot.get("requirements", [])
        if is_pending_requirement(row, pre_test_statuses)
    ]
    bugs = [
        row for row in snapshot.get("bugs", []) if needs_bug_attention(row, terminal_bug_statuses)
    ]
    deadlines = [calendar_date(row.get("test_deadline")) for row in requirements]
    requirement_ranks = {
        name: index
        for index, name in enumerate(snapshot.get("requirement_priorities", ("P0", "P1", "P2", "P3")))
    }
    bug_ranks = {name: index for index, name in enumerate(("紧急", "高", "中", "低"))}
    parents = parent_requirements(
        requirements,
        requirement_records
        if requirement_records is not None
        else snapshot.get("requirements", []) + snapshot.get("requirement_context", []),
        include_family,
    )

    def queue(records, ranks, deadline_field):
        ordered = sorted(
            records,
            key=lambda row: (
                ranks.get(row.get("priority"), 99),
                calendar_date(row.get(deadline_field) or row.get("deadline")) or date.max,
                row["id"],
            ),
        )
        return [
            {
                "id": row["id"],
                "match_id": row.get("match_id", row["id"]),
                "title": row.get("title") or "无标题",
                "priority": row.get("priority") or "",
                "priority_color": row.get("priority_color"),
                "status": row.get("status") or "",
                "project": row.get("project") or [],
                "deadline": (
                    deadline.isoformat()
                    if (deadline := calendar_date(row.get(deadline_field) or row.get("deadline")))
                    else ""
                ),
            }
            for row in ordered[:3]
        ]

    metadata = snapshot.get("table_sync", {})
    return {
        "metrics": {
            "today": sum(deadline == today for deadline in deadlines),
            "overdue": sum(deadline is not None and deadline < today for deadline in deadlines),
            "soon": sum(
                deadline is not None and 0 <= (deadline - today).days <= 3 for deadline in deadlines
            ),
            "bugs": len(bugs),
        },
        "requirements": queue(parents, requirement_ranks, "test_deadline"),
        "bugs": queue(bugs, bug_ranks, "due_at"),
        "ranges": {
            kind: metadata.get(kind, {}).get("date_range") for kind in ("requirements", "bugs")
        },
        "updated_at": {
            kind: metadata.get(kind, {}).get("updated_at") for kind in ("requirements", "bugs")
        },
    }
