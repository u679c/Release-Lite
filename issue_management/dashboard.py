"""Testing dashboard statistics and drill-down filters for the issue overview."""

from collections import Counter
from datetime import date, timedelta


DASHBOARD_SCOPES = {
    "weekly",
    "weekly_pending",
    "submitted",
    "week_today",
    "week_soon",
    "week_overdue",
    "week_scheduled",
    "pending",
    "overdue",
    "today",
    "soon",
    "normal",
    "later",
    "bugs",
    "bugs_pending",
}


def calendar_date(value):
    try:
        return date.fromisoformat(str(value or "").strip()[:10].replace("/", "-"))
    except ValueError:
        return None


def deadline_bucket(deadline, today):
    days = (deadline - today).days
    return "overdue" if days < 0 else "soon" if days <= 3 else "normal" if days <= 7 else "later"


def week_bounds(today):
    start = today - timedelta(days=today.weekday())
    return start, start + timedelta(days=6)


def release_calendar(requirements, today):
    start, end = week_bounds(today)
    releases = {}
    for row in requirements:
        release_date = calendar_date(row.get("release_date"))
        if release_date is None or not start <= release_date <= end:
            continue
        projects = tuple(row.get("project") or [])
        versions = tuple(row.get("version") or [])
        counts = releases.setdefault(release_date, Counter())
        counts[(projects, versions)] += 1
    return [
        {
            "date": (day := start + timedelta(days=offset)).isoformat(),
            "today": day == today,
            "releases": [
                {
                    "project": "、".join(projects) or "未分配项目",
                    "version": "、".join(versions) or "未设置版本",
                    "projects": list(projects),
                    "versions": list(versions),
                    "count": count,
                }
                for (projects, versions), count in sorted(releases.get(day, {}).items())
            ],
        }
        for offset in range(7)
    ]


def is_pending_requirement(row, pre_test_statuses):
    status = str(row.get("status") or "").strip()
    return not status or status in pre_test_statuses


def weekly_status(row, today, pre_test_statuses, submitted_statuses):
    deadline = calendar_date(row.get("test_deadline"))
    start, end = week_bounds(today)
    if deadline is None or not start <= deadline <= end:
        return ""
    if row.get("status") in submitted_statuses:
        return "submitted"
    if not is_pending_requirement(row, pre_test_statuses):
        return ""
    if deadline == today:
        return "today"
    bucket = deadline_bucket(deadline, today)
    return "scheduled" if bucket in {"normal", "later"} else bucket


def is_watched_bug(row, terminal_bug_statuses):
    status = row.get("status")
    return bool(status) and (status == "已修复" or status not in terminal_bug_statuses)


def needs_bug_attention(row, terminal_statuses):
    return row.get("status") != "已修复待发布" and row.get("status") not in terminal_statuses


def matches_dashboard(
    row, scope, test_date, today, pre_test_statuses, submitted_statuses, terminal_bug_statuses
):
    if scope == "bugs":
        return row["kind"] == "bugs" and is_watched_bug(row, terminal_bug_statuses)
    if scope == "bugs_pending":
        return row["kind"] == "bugs" and needs_bug_attention(row, terminal_bug_statuses)
    if row["kind"] != "requirements":
        return not scope and not test_date
    deadline = calendar_date(row.get("test_deadline"))
    if test_date and deadline != test_date:
        return False
    if not scope:
        return True
    state = weekly_status(row, today, pre_test_statuses, submitted_statuses)
    if scope == "weekly":
        return bool(state)
    if scope == "weekly_pending":
        return bool(state) and state != "submitted"
    if scope == "submitted":
        return state == "submitted"
    if scope.startswith("week_"):
        return state == scope.removeprefix("week_")
    pending = is_pending_requirement(row, pre_test_statuses)
    if scope == "pending":
        return pending and deadline is not None
    if not pending or deadline is None:
        return False
    return deadline == today if scope == "today" else deadline_bucket(deadline, today) == scope


def summarize(
    requirements,
    bugs,
    today,
    pre_test_statuses,
    submitted_statuses,
    terminal_bug_statuses,
    *,
    release_requirements,
    release_dates_ready,
):
    start, end = week_bounds(today)
    pending = [row for row in requirements if is_pending_requirement(row, pre_test_statuses)]
    dated = [(row, calendar_date(row.get("test_deadline"))) for row in pending]
    dated = [(row, deadline) for row, deadline in dated if deadline is not None]
    weekly = [
        (row, state)
        for row in requirements
        if (state := weekly_status(row, today, pre_test_statuses, submitted_statuses))
    ]
    week_status = Counter(state for _, state in weekly)
    buckets = Counter(deadline_bucket(deadline, today) for _, deadline in dated)

    calendar = []
    for offset in range(7):
        day = start + timedelta(days=offset)
        counts = Counter(
            "normal" if state == "scheduled" else state
            for row, state in weekly
            if calendar_date(row.get("test_deadline")) == day
        )
        calendar.append(
            {
                "date": day.isoformat(),
                "count": sum(counts.values()),
                "counts": dict(counts),
                "today": day == today,
            }
        )

    bug_status = Counter(
        row["status"] for row in bugs if is_watched_bug(row, terminal_bug_statuses)
    )
    project_counts = {}
    for row, deadline in dated:
        for project in set(row.get("project") or [""]):
            project_counts.setdefault(project, Counter())[deadline_bucket(deadline, today)] += 1
    projects = [
        {"name": name, "total": sum(counts.values()), "buckets": dict(counts)}
        for name, counts in project_counts.items()
    ]
    projects.sort(
        key=lambda item: (
            -item["buckets"].get("overdue", 0),
            -item["buckets"].get("soon", 0),
            -item["total"],
            item["name"],
        )
    )
    return {
        "week_start": start.isoformat(),
        "week_end": end.isoformat(),
        "metrics": {
            "weekly": len(weekly) - week_status["submitted"],
            "weekly_total": len(weekly),
            "weekly_overdue": week_status["overdue"],
            "soon": buckets["soon"],
            "today": sum(deadline == today for _, deadline in dated),
            "overdue": buckets["overdue"],
        },
        "calendar": calendar,
        "release_calendar": release_calendar(release_requirements if release_dates_ready else [], today),
        "release_dates_ready": release_dates_ready,
        "deadline_buckets": dict(buckets),
        "dated_pending": len(dated),
        "undated_pending": len(pending) - len(dated),
        "week_status": dict(week_status),
        "week_total": len(weekly),
        "bug_status": dict(bug_status),
        "bug_total": sum(bug_status.values()),
        "projects": projects[:5],
    }
