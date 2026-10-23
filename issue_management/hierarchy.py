"""Group requirement records by their actual parent links before pagination."""


def requirement_groups(records, matched_ids, include_family=False):
    index = {row["id"]: row for row in records}
    neighbors = {record_id: set() for record_id in index}
    for row in records:
        for parent_id in row.get("parent_ids", []):
            if parent_id in index and parent_id != row["id"]:
                neighbors[row["id"]].add(parent_id)
                neighbors[parent_id].add(row["id"])

    visible = set(matched_ids)
    if include_family:
        pending = list(visible)
        while pending:
            for record_id in neighbors[pending.pop()]:
                if record_id not in visible:
                    visible.add(record_id)
                    pending.append(record_id)

    # A record has one display position even if several parent fields contain links.
    # Break malformed cycles so every visible record remains reachable.
    parents = {}
    for record_id in sorted(visible):
        for parent_id in index[record_id].get("parent_ids", []):
            if parent_id not in visible or parent_id == record_id:
                continue
            ancestor = parent_id
            while ancestor in parents and ancestor != record_id:
                ancestor = parents[ancestor]
            if ancestor != record_id:
                parents[record_id] = parent_id
                break

    children = {record_id: [] for record_id in visible}
    for record_id, parent_id in parents.items():
        children[parent_id].append(record_id)
    sort_key = lambda record_id: (index[record_id].get("created_at") or "", record_id)
    roots = sorted(visible - parents.keys(), key=sort_key, reverse=True)
    groups = []
    for root_id in roots:
        group, pending = [], [(root_id, [])]
        while pending:
            record_id, ancestors = pending.pop()
            group.append(
                {
                    **index[record_id],
                    "tree_depth": len(ancestors),
                    "tree_ancestors": ancestors,
                    "tree_child_count": len(children[record_id]),
                    "filter_match": record_id in matched_ids,
                }
            )
            pending.extend(
                (child_id, [*ancestors, record_id])
                for child_id in sorted(children[record_id], key=sort_key)
            )
        groups.append(group)
    return groups
