"""Feishu Base queries and issue status updates through lark-cli as user."""

import hashlib
import fcntl
import json
import os
import re
import subprocess
import tempfile
import threading
import time
import uuid
from calendar import monthrange
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from pathlib import Path
from urllib.parse import quote, urlencode
from zoneinfo import ZoneInfo

from .conditions import is_high_priority, matches_conditions, normalize_conditions
from .dashboard import DASHBOARD_SCOPES, calendar_date, matches_dashboard, summarize, week_bounds
from .hierarchy import requirement_groups
from .home import home_summary
from .preferences import requirement_sort
from .priorities import REQUIREMENT_PRIORITIES, RequirementPriorityStore
from .storage import write_json


BASE_TOKEN = "F43vbWYH5aXpvtsUtaFcJ3Ecnle"
SOURCE_URL = "https://yuntikeji.feishu.cn/wiki/A0SmwJ6j8ixj9Fkg39YcFeJlnyg"
SHANGHAI = ZoneInfo("Asia/Shanghai")
EMPTY = "__empty__"
PAGE_SIZE = 30
VERSION_PAGE_SIZE = 10
SNAPSHOT_SCHEMA = 8
RELEASE_CALENDAR_SCHEMA = 1
PARENT_FIELDS = {
    "parent_1": "fldTtcEaOw",
    "parent_3": "fldmBm8Fca",
    "parent_4": "fld4W9jZtn",
    "parent_5": "fld5Ry2Rjb",
    "parent_6": "fldi0g18OL",
    "parent_7": "fldro9TwSP",
    "parent_8": "fldAEk4LXd",
}
TERMINAL = {
    "requirements": {"已上线", "已完成", "已取消"},
    "bugs": {"已修复", "已关闭", "无需解决", "已取消", "重复bug", "转需求"},
}
REQUIREMENT_PRE_TEST_STATUSES = {"产品设计中", "需求待评审", "待开发", "开发中", "开发完成"}
TEST_DEADLINE_EXEMPT_STATUSES = {
    "测试中",
    "用例检查",
    "测试完成",
    "预发验收",
    "待上线",
    "线上验收",
    "已上线",
    "已取消",
    "无需测试",
    "已完成",
}
BUG_TARGET_STATUSES = {"处理中", "已修复待发布", "已修复"}
BUG_STAGES = {"all", "pending", "release", "fixed"}
ATTACHMENT_MEDIA_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".avif": "image/avif",
    ".ico": "image/x-icon",
    ".heic": "image/heic",
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".ogv": "video/ogg",
    ".avi": "video/x-msvideo",
    ".mkv": "video/x-matroska",
    ".3gp": "video/3gpp",
    ".mpeg": "video/mpeg",
    ".mpg": "video/mpeg",
}
# Stable field IDs keep the adapter working when display names are changed.
TABLES = {
    "requirements": {
        "id": "tbl6f7PnU06TPBYJ",
        "view": "vewOi3oja0",
        "fields": {
            "title": "fld03YMwlU",
            "project": "fldvDGKP4K",
            "version": "fldS6s6p7t",
            "status": "fldb47enoE",
            "developers": "fldxzI3w8E",
            "products": "fld1y1zdvt",
            "designers": "fldxEALysv",
            "test_deadline": "fldq4s2d06",
            "release_date": "fld6zM5DDR",
            "testers": "fldjfXdcNL",
            "created_at": "fldrfNv4jd",
            "start_at": "fldPYlF2n8",
            "due_at": "fldQBKvq1R",
            "is_child": "fldjzBQSTT",
            "related": "fldlH7hHvl",
            "category": "fldJWm309G",
            "document": "flda2bGuqs",
            "design": "fldszn4N8I",
            "discussion": "fldriiUNK7",
            **PARENT_FIELDS,
        },
    },
    "bugs": {
        "id": "tbldaX1pCCTuMpMJ",
        "view": "vewYSMKkr9",
        "fields": {
            "title": "fld6Z8zskd",
            "project": "fldUbrPopi",
            "version": "fldkjOW13F",
            "status": "fldMu4AJfq",
            "priority": "fldgoRzCN8",
            "owners": "fldHk1PEsK",
            "creators": "fld17KNHUZ",
            "created_at": "fldLZwbwd9",
            "due_at": "fldCOuqMKf",
            "deadline": "fldTR4liDi",
            "updated_at": "fldCmGTla9",
            "environment": "fldz3nMOSb",
            "category": "fldSmqAHew",
            "attribute": "fldatlzUpt",
            "related": "fldHkBoXis",
            "notes": "fldmGDT3XA",
            "solution": "fldZO5uGjQ",
            "link": "fldjz3Hl3x",
            "attachments": "fldyTKiLyK",
            "discussion": "fldIB1BPQF",
        },
    },
    "projects": {"id": "tbl93rdIF4qCm4lk", "fields": {"name": "fldrLK1XM5"}},
    "versions": {"id": "tblnbtYV4orON34A", "fields": {"name": "fldlzpdRjj"}},
}


class SyncError(RuntimeError):
    def __init__(self, message, *, uncertain=False):
        super().__init__(message)
        self.uncertain = uncertain


class IssueBusyError(RuntimeError):
    pass


def text(value):
    if value is None:
        return ""
    if isinstance(value, list):
        return "、".join(text(item) for item in value)
    if isinstance(value, dict):
        return str(value.get("name") or value.get("id") or "")
    return str(value)


def validate_record_id(record_id, label):
    if (
        not isinstance(record_id, str)
        or not record_id.startswith("rec")
        or not record_id.isascii()
        or not record_id.isalnum()
    ):
        raise ValueError(f"{label}记录 ID 不正确")


def version_sort_key(name):
    """Compare numeric parts as numbers, so 5.10 sorts after 5.9."""
    return tuple(
        (1, int(part)) if part.isdecimal() else (0, part.casefold())
        for part in re.split(r"(\d+)", name)
    )


def parse_date_range(filters):
    today = datetime.now(SHANGHAI).date()
    year, month = divmod(today.year * 12 + today.month - 1 - 2, 12)
    month += 1
    default_start = today.replace(
        year=year, month=month, day=min(today.day, monthrange(year, month)[1])
    )
    try:
        start = date.fromisoformat(filters.get("created_from") or default_start.isoformat())
        end = date.fromisoformat(filters.get("created_to") or today.isoformat())
    except (TypeError, ValueError) as exc:
        raise ValueError("创建时间日期格式应为 YYYY-MM-DD") from exc
    if start > end:
        raise ValueError("创建开始日期不能晚于结束日期")
    if start == date.min or end == date.max:
        raise ValueError("创建时间超出支持的日期范围")
    return {"created_from": start.isoformat(), "created_to": end.isoformat()}


class IssueService:
    def __init__(self, cache_dir):
        self.cache_dir = Path(cache_dir)
        self.requirement_priorities = RequirementPriorityStore(
            self.cache_dir, REQUIREMENT_PRIORITIES
        )
        self.lock = threading.Lock()
        self.attachment_locks = {}
        self.snapshot = None
        self.syncing = False
        self.submitting = False
        self.progress = ""
        self.sync_attempts = {}
        try:
            cached = json.loads((self.cache_dir / "snapshot.json").read_text(encoding="utf-8"))
            if not isinstance(cached, dict):
                return
            if cached.get("schema") == 7 and isinstance(cached.get("date_range"), dict):
                cached = {
                    **cached,
                    "schema": SNAPSHOT_SCHEMA,
                    "table_sync": {
                        kind: {
                            key: cached.get(key)
                            for key in ("date_range", "timestamp", "updated_at", "context_complete")
                        }
                        for kind in ("requirements", "bugs")
                    },
                }
            if (
                cached.get("schema") == SNAPSHOT_SCHEMA
                and isinstance(cached.get("table_sync"), dict)
                and all(
                    isinstance(cached.get(k), list)
                    for k in ("requirements", "bugs", "requirement_context")
                )
            ):
                if any(
                    "discussion" not in row
                    for row in cached["requirements"] + cached["requirement_context"]
                ):
                    metadata = cached["table_sync"].get("requirements")
                    if metadata:
                        metadata["timestamp"] = 0
                self.snapshot = cached
        except (OSError, ValueError, TypeError):
            pass

    @staticmethod
    def _sync_targets(kind):
        return ("requirements", "bugs") if kind == "overview" else (kind,)

    def status(self, date_range, include_requirement_context=False, kind="overview"):
        with self.lock:
            return self._status(date_range, include_requirement_context, kind)

    def _status(self, date_range, include_requirement_context=False, kind="overview"):
        metadata = (self.snapshot or {}).get("table_sync", {})
        targets = self._sync_targets(kind)
        ready = all(metadata.get(target, {}).get("date_range") == date_range for target in targets)
        if include_requirement_context:
            ready = ready and bool(metadata.get("requirements", {}).get("context_complete"))
        attempt = self.sync_attempts.get(kind, {})
        stamps = [metadata.get(target, {}).get("updated_at") for target in targets]
        return {
            "ready": ready,
            "syncing": self.syncing,
            "submitting": self.submitting,
            "error": attempt.get("error", "") if attempt.get("date_range") == date_range else "",
            "progress": self.progress,
            "updated_at": min(stamps) if ready and all(stamps) else None,
            "date_range": date_range,
        }

    def start_sync(
        self, date_range, include_requirement_context=False, kind="overview"
    ):
        with self.lock:
            if self.syncing or self.submitting:
                return
            metadata = (self.snapshot or {}).get("table_sync", {})
            targets = self._sync_targets(kind)
            requirement_meta = metadata.get("requirements", {})
            has_context = requirement_meta.get("date_range") == date_range and requirement_meta.get(
                "context_complete"
            )
            include_requirement_context = "requirements" in targets and (
                include_requirement_context or bool(has_context)
            )
            self.syncing = True
            self.sync_attempts[kind] = {
                "at": time.time(),
                "date_range": dict(date_range),
                "context": include_requirement_context,
                "error": "",
            }
            self.progress = "同步中…"
            sync_id = uuid.uuid4().hex
        threading.Thread(
            target=self._sync,
            args=(dict(date_range), include_requirement_context, kind, sync_id),
            daemon=True,
            name="issue-sync",
        ).start()
        return sync_id

    def _invalidate_snapshot(self, kind):
        # Called while holding self.lock after an uncertain remote update.
        if self.snapshot is not None:
            metadata = self.snapshot.get("table_sync", {})
            self.snapshot = {
                **self.snapshot,
                "table_sync": {
                    target: {**value, "timestamp": 0} if target == kind else value
                    for target, value in metadata.items()
                },
            }
        for scope in (kind, "overview"):
            self.sync_attempts.pop(scope, None)

    def _run(self, arguments, cwd, domain="base"):
        operation = (
            "建群"
            if arguments[0] == "+chat-create"
            else "邀请群成员"
            if arguments[0] == "chat.members"
            else "更新"
            if arguments[0] == "+record-batch-update"
            else "下载附件"
            if arguments[0] == "+record-download-attachment"
            else "读取"
        )
        executable = os.environ.get("RELEASE_LITE_LARK_CLI", "lark-cli")
        env = {
            **os.environ,
            "LARKSUITE_CLI_NO_UPDATE_NOTIFIER": "1",
            "LARKSUITE_CLI_NO_SKILLS_NOTIFIER": "1",
        }
        try:
            result = subprocess.run(
                [executable, domain, *arguments, "--as", "user"],
                cwd=cwd,
                capture_output=True,
                text=True,
                timeout=90,
                env=env,
            )
        except FileNotFoundError as exc:
            raise SyncError(
                "飞书连接未配置，请联系管理员"
            ) from exc
        except subprocess.TimeoutExpired as exc:
            raise SyncError(f"飞书{operation}超时，请稍后重试。", uncertain=True) from exc
        try:
            payload = json.loads(result.stdout if result.returncode == 0 else result.stderr)
        except ValueError as exc:
            raise SyncError(
                "飞书响应异常，请检查连接与登录状态", uncertain=True
            ) from exc
        if result.returncode != 0 or payload.get("ok") is False:
            error = payload.get("error") or {}
            if error.get("type") == "authorization" or error.get("missing_scopes"):
                if domain == "im":
                    if arguments[0] == "chat.members":
                        raise SyncError(
                            "无法邀请群成员，请检查飞书登录状态与邀请权限"
                        )
                    raise SyncError(
                        "无法创建群聊，请检查飞书登录状态与建群权限"
                    )
                raise SyncError(
                    "飞书登录失效或权限不足，请重新授权"
                )
            if error.get("type") == "network":
                raise SyncError("无法连接飞书，请检查网络后重试", uncertain=True)
            raise SyncError(f"飞书{operation}失败，请检查登录状态与访问权限")
        return payload

    @staticmethod
    def _attachment_type(attachment):
        return ATTACHMENT_MEDIA_TYPES.get(Path(attachment.get("name") or "").suffix.lower(), "")

    def attachment(self, record_id, file_token):
        # Only serve files belonging to a bug in the current snapshot.
        with self.lock:
            row = next(
                (row for row in (self.snapshot or {}).get("bugs", []) if row["id"] == record_id),
                None,
            )
            attachment = next(
                (
                    item
                    for item in (row or {}).get("attachments") or []
                    if item.get("file_token") == file_token
                ),
                None,
            )
            if not attachment or not self._attachment_type(attachment):
                raise FileNotFoundError("未找到图片或视频附件，请同步数据后重试。")
            download_lock = self.attachment_locks.setdefault(
                (record_id, file_token), threading.Lock()
            )
        mime_type = self._attachment_type(attachment)
        extension = Path(attachment["name"]).suffix.lower()
        digest = hashlib.sha256(f"{record_id}:{file_token}".encode()).hexdigest()
        directory = (self.cache_dir / "attachments").resolve()
        cached = directory / f"media-{digest}{extension}"
        expected_size = attachment.get("size")

        def complete(path):
            if not path.is_file():
                return False
            size = path.stat().st_size
            return size > 0 and (
                size == expected_size
                if isinstance(expected_size, int) and expected_size > 0
                else True
            )

        try:
            with download_lock:
                if not complete(cached):
                    directory.mkdir(parents=True, exist_ok=True)
                    with tempfile.TemporaryDirectory(
                        prefix="download-", dir=directory
                    ) as temporary:
                        filename = f"media{extension}"
                        self._run(
                            [
                                "+record-download-attachment",
                                "--base-token",
                                BASE_TOKEN,
                                "--table-id",
                                TABLES["bugs"]["id"],
                                "--record-id",
                                record_id,
                                "--file-token",
                                file_token,
                                "--output",
                                filename,
                            ],
                            temporary,
                        )
                        downloaded = Path(temporary) / filename
                        if not complete(downloaded):
                            raise SyncError("附件下载不完整，请同步数据后重试。")
                        downloaded.replace(cached)
            return cached, mime_type
        except OSError as exc:
            raise SyncError("附件加载失败，请稍后重试") from exc

    def _read_table(
        self,
        kind,
        directory,
        date_range,
        *,
        record_filter=None,
        record_ids=None,
        artifact_prefix="",
        field_names=None,
    ):
        config = TABLES[kind]
        fields = (
            config["fields"]
            if field_names is None
            else {name: config["fields"][name] for name in field_names}
        )
        if date_range is not None and kind in ("requirements", "bugs"):
            # Date comparisons are strict in Base; include both selected calendar days.
            before_start = date.fromisoformat(date_range["created_from"]) - timedelta(days=1)
            after_end = date.fromisoformat(date_range["created_to"]) + timedelta(days=1)
            record_filter = {
                "logic": "and",
                "conditions": [
                    [
                        config["fields"]["created_at"],
                        ">",
                        f"ExactDate({before_start.isoformat()} 23:59:59.999)",
                    ],
                    [
                        config["fields"]["created_at"],
                        "<",
                        f"ExactDate({after_end.isoformat()} 00:00:00)",
                    ],
                ],
            }
        records, offset, revision = [], 0, None
        while True:
            with self.lock:
                self.progress = f"正在读取{ {'requirements': '需求', 'bugs': 'bug', 'projects': '项目', 'versions': '版本'}[kind] }，已读取 {len(records)} 条…"
            filename = f"{artifact_prefix}{kind}-{offset}.ndjson"
            arguments = [
                "+record-get" if record_ids else "+record-list",
                "--base-token",
                BASE_TOKEN,
                "--table-id",
                config["id"],
            ]
            for record_id in record_ids or []:
                arguments.extend(["--record-id", record_id])
            for field_id in fields.values():
                arguments.extend(["--field-id", field_id])
            # Query parameters only: never modify the Feishu records or saved view filters.
            if record_filter is not None:
                arguments.extend(["--filter-json", json.dumps(record_filter, ensure_ascii=False)])
            if not record_ids:
                arguments.extend(["--offset", str(offset), "--limit", "2000"])
            arguments.extend(["--format", "ndjson", "--output", filename])
            manifest = self._run(arguments, directory)
            if revision is not None and revision != manifest.get("rev"):
                raise SyncError("飞书数据有变化，请重新同步")
            revision = manifest.get("rev")
            columns = {
                column.get("field_id"): name for name, column in manifest.get("columns", {}).items()
            }
            missing = set(fields.values()) - set(columns)
            if missing and manifest.get("records_count") != 0:
                raise SyncError(
                    "飞书表配置有变化，请联系管理员检查"
                )
            page = []
            with (Path(directory) / filename).open(encoding="utf-8") as stream:
                for line in stream:
                    if line.strip():
                        raw = json.loads(line)
                        page.append(
                            {
                                "id": raw["record_id"],
                                **{
                                    key: raw.get(columns[field])
                                    for key, field in fields.items()
                                },
                            }
                        )
            if len(page) != manifest.get("records_count"):
                raise SyncError("飞书数据不完整，请重新同步")
            records.extend(page)
            if not manifest.get("has_more"):
                break
            next_offset = manifest.get("next_offset")
            if not isinstance(next_offset, int) or next_offset <= offset:
                raise SyncError("飞书数据读取异常，请重新同步")
            offset = next_offset
        if len({row["id"] for row in records}) != len(records):
            raise SyncError("飞书数据读取异常，请重新同步")
        return records

    def _read_release_requirements(self, directory, start, end):
        # The release date is a lookup field. ExactDate comparisons on it can
        # return no records, so read the projected table and compare dates locally.
        rows = self._read_table(
            "requirements",
            directory,
            None,
            artifact_prefix="release-",
            field_names=("project", "version", "release_date"),
        )
        return [
            row
            for row in rows
            if (release_date := calendar_date(row.get("release_date"))) is not None
            and start <= release_date <= end
        ]

    @staticmethod
    def _parent_ids(row):
        return list(
            dict.fromkeys(value["id"] for key in PARENT_FIELDS for value in row.get(key) or [])
        )

    def _read_requirement_batches(self, batches, directory, executor=None):
        if executor is None:
            return [self._read_table("requirements", directory, None, **batch) for batch in batches]
        futures = [
            executor.submit(self._read_table, "requirements", directory, None, **batch)
            for batch in batches
        ]
        return [future.result() for future in futures]

    def _read_requirement_context(self, records, directory, executor=None):
        index = {row["id"]: row for row in records}
        pending, attempted_parents, batch_number = set(index), set(), 0
        while pending:
            current, pending = sorted(pending), set()
            missing = sorted(
                {parent_id for row in index.values() for parent_id in self._parent_ids(row)}
                - index.keys()
                - attempted_parents
            )
            batches = []
            for offset in range(0, len(missing), 50):
                batch = missing[offset : offset + 50]
                attempted_parents.update(batch)
                batches.append({"record_ids": batch, "artifact_prefix": f"family-{batch_number}-"})
                batch_number += 1
            for parents in self._read_requirement_batches(batches, directory, executor):
                for row in parents:
                    if row["id"] not in index:
                        index[row["id"]] = row
                        pending.add(row["id"])
            batches = []
            for offset in range(0, len(current), 50):
                links = [{"id": record_id} for record_id in current[offset : offset + 50]]
                record_filter = {
                    "logic": "or",
                    "conditions": [
                        [field_id, "intersects", links] for field_id in PARENT_FIELDS.values()
                    ],
                }
                batches.append(
                    {"record_filter": record_filter, "artifact_prefix": f"family-{batch_number}-"}
                )
                batch_number += 1
            for children in self._read_requirement_batches(batches, directory, executor):
                for row in children:
                    if row["id"] not in index:
                        index[row["id"]] = row
                        pending.add(row["id"])
        original_ids = {row["id"] for row in records}
        return [row for record_id, row in index.items() if record_id not in original_ids]

    def _read_requirement_parents(self, records, directory, executor=None):
        index = {row["id"]: row for row in records}
        attempted, batch_number = set(), 0
        while True:
            missing = sorted(
                {parent_id for row in index.values() for parent_id in self._parent_ids(row)}
                - index.keys()
                - attempted
            )
            if not missing:
                break
            batches = []
            for offset in range(0, len(missing), 50):
                batch = missing[offset : offset + 50]
                attempted.update(batch)
                batches.append({"record_ids": batch, "artifact_prefix": f"parents-{batch_number}-"})
                batch_number += 1
            for parents in self._read_requirement_batches(batches, directory, executor):
                index.update({row["id"]: row for row in parents})
        original_ids = {row["id"] for row in records}
        return [row for record_id, row in index.items() if record_id not in original_ids]

    def _write_snapshot(self, snapshot):
        write_json(self.cache_dir / "snapshot.json", snapshot)

    def submit_requirements(self, records):
        if not isinstance(records, list) or not records:
            raise ValueError("请选择要提测的需求")
        expected = {}
        for record in records:
            if not isinstance(record, dict):
                raise ValueError("需求提测参数格式不正确")
            record_id = record.get("id")
            validate_record_id(record_id, "需求")
            if record_id in expected:
                raise ValueError("不能重复选择同一条需求")
            if not isinstance(record.get("expected_status"), str):
                raise ValueError("缺少当前需求状态，请刷新后重试")
            if record["expected_status"] not in REQUIREMENT_PRE_TEST_STATUSES:
                raise ValueError(
                    "部分需求当前无法提测，请取消勾选后重试"
                )
            expected[record_id] = record["expected_status"]
        record_ids = list(expected)
        with self.lock:
            if self.syncing or self.submitting:
                raise IssueBusyError("正在同步数据或提测，请稍后重试。")
            self.submitting = True
        write_attempted = False
        try:
            with tempfile.TemporaryDirectory(prefix="release-lite-submit-") as directory:
                # Update only explicitly selected records, including independently selected children.
                current = {}
                for offset in range(0, len(record_ids), 50):
                    rows = self._read_table(
                        "requirements",
                        directory,
                        None,
                        record_ids=record_ids[offset : offset + 50],
                        artifact_prefix=f"submit-before-{offset}-",
                    )
                    current.update({row["id"]: text(row.get("status")) for row in rows})
                if current.keys() != expected.keys():
                    raise ValueError("需求不存在或无权访问")
                if any(
                    current[record_id] != expected_status
                    or current[record_id] not in REQUIREMENT_PRE_TEST_STATUSES
                    for record_id, expected_status in expected.items()
                ):
                    with self.lock:
                        self._invalidate_snapshot("requirements")
                    raise IssueBusyError("需求状态已变化，请同步后重试")
                config = TABLES["requirements"]
                for offset in range(0, len(record_ids), 200):
                    payload = {
                        "update_records": {
                            item: {config["fields"]["status"]: ["测试中"]}
                            for item in record_ids[offset : offset + 200]
                        }
                    }
                    write_attempted = True
                    self._run(
                        [
                            "+record-batch-update",
                            "--base-token",
                            BASE_TOKEN,
                            "--table-id",
                            config["id"],
                            "--json",
                            json.dumps(payload, ensure_ascii=False),
                        ],
                        directory,
                    )
                # The write response does not report per-record results; confirm actual statuses.
                for attempt in range(3):
                    verified = {}
                    for offset in range(0, len(record_ids), 50):
                        rows = self._read_table(
                            "requirements",
                            directory,
                            None,
                            record_ids=record_ids[offset : offset + 50],
                            artifact_prefix=f"submit-verify-{attempt}-{offset}-",
                        )
                        verified.update({row["id"]: text(row.get("status")) for row in rows})
                    if all(verified.get(item) == "测试中" for item in record_ids):
                        break
                    if attempt < 2:
                        time.sleep(0.5)
                else:
                    raise SyncError("部分需求提测结果待确认")
            warning = ""
            with self.lock:
                if self.snapshot is not None:
                    snapshot = {**self.snapshot}
                    for key in ("requirements", "requirement_context"):
                        snapshot[key] = [
                            {**row, "status": "测试中"} if row["id"] in expected else row
                            for row in snapshot[key]
                        ]
                    self.snapshot = snapshot
                    try:
                        self._write_snapshot(snapshot)
                    except OSError:
                        warning = "飞书已更新，请重新同步页面数据"
            return {"status": "测试中", "updated_count": len(record_ids), "warning": warning}
        except (SyncError, OSError) as exc:
            if write_attempted:
                with self.lock:
                    self._invalidate_snapshot("requirements")
                raise SyncError(
                    f"提测结果待确认，请同步后检查。{exc}"
                ) from exc
            raise SyncError(str(exc)) from exc
        finally:
            with self.lock:
                self.submitting = False

    @staticmethod
    def _discussion_chat(row):
        chats = row.get("discussion") or []
        if not chats:
            return None
        chat = chats[0]
        chat_id = chat.get("id")
        if not isinstance(chat_id, str) or not chat_id.startswith("oc_"):
            raise SyncError("群聊信息无效，请同步后重试")
        return {
            "id": chat_id,
            "name": chat.get("name") or "讨论群",
            "url": "https://applink.feishu.cn/client/chat/open?"
            + urlencode({"openChatId": chat_id}),
        }

    def _discussion_state_path(self, record_id, kind="bugs"):
        digest = hashlib.sha256(record_id.encode()).hexdigest()
        prefix = "requirement-chat" if kind == "requirements" else "chat"
        return self.cache_dir / "discussions" / f"{prefix}-{digest}.json"

    @staticmethod
    def _read_discussion_state(path):
        try:
            state = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(state, dict):
                raise ValueError("Invalid discussion state")
            return state
        except FileNotFoundError:
            return {}
        except (OSError, ValueError) as exc:
            raise SyncError("无法确认上次建群结果，请先在飞书检查，避免重复建群") from exc

    @staticmethod
    def _write_discussion_state(path, state):
        write_json(path, state)

    def _cache_discussion(self, kind, record_id, chat):
        warning = ""
        with self.lock:
            if self.snapshot is not None:
                snapshot = {**self.snapshot}
                keys = (
                    ("requirements", "requirement_context") if kind == "requirements" else ("bugs",)
                )
                for key in keys:
                    snapshot[key] = [
                        {**row, "discussion": [{"id": chat["id"], "name": chat["name"]}]}
                        if row["id"] == record_id
                        else row
                        for row in self.snapshot[key]
                    ]
                self.snapshot = snapshot
                try:
                    self._write_snapshot(snapshot)
                except OSError:
                    warning = "群聊已关联，请重新同步页面数据"
        return warning

    def create_bug_discussion(self, record_id):
        return self._create_discussion("bugs", record_id, ("creators", "owners"))

    def create_requirement_discussion(self, record_id):
        return self._create_discussion(
            "requirements", record_id, ("products", "developers", "testers", "designers")
        )

    def _requirement_discussion_records(self, parent, directory):
        records, pending, batch_number = {parent["id"]: parent}, [parent["id"]], 0
        while pending:
            current, pending = pending, []
            for offset in range(0, len(current), 50):
                links = [{"id": record_id} for record_id in current[offset : offset + 50]]
                record_filter = {
                    "logic": "or",
                    "conditions": [
                        [field_id, "intersects", links] for field_id in PARENT_FIELDS.values()
                    ],
                }
                children = self._read_table(
                    "requirements",
                    directory,
                    None,
                    record_filter=record_filter,
                    artifact_prefix=f"discussion-children-{batch_number}-",
                )
                batch_number += 1
                for child in children:
                    if child["id"] not in records:
                        records[child["id"]] = child
                        pending.append(child["id"])
        return list(records.values())

    def _invite_discussion_members(self, state_path, state, directory):
        while state.get("remaining_members"):
            remaining = state["remaining_members"]
            batch = remaining[:50]
            params = {
                "chat_id": state["chat"]["id"],
                "member_id_type": "open_id",
                "succeed_type": 1,
            }
            try:
                result = self._run(
                    [
                        "chat.members",
                        "create",
                        "--params",
                        json.dumps(params),
                        "--data",
                        json.dumps({"id_list": batch}),
                    ],
                    directory,
                    domain="im",
                )
            except SyncError as exc:
                raise SyncError(
                    f"群聊已创建，部分成员入群待确认，请点击“重试关联”。{exc}"
                ) from exc
            result = result.get("data", result)
            failed = (
                set(result.get("invalid_id_list") or [])
                | set(result.get("not_existed_id_list") or [])
                | set(result.get("pending_approval_id_list") or [])
            )
            state = {
                **state,
                "remaining_members": [member for member in batch if member in failed]
                + remaining[50:],
            }
            self._write_discussion_state(state_path, state)
            if failed:
                raise SyncError(
                    "群聊已创建，部分成员未入群，请在飞书处理邀请或审批后点击“重试关联”"
                )

    def _create_discussion(self, kind, record_id, member_fields):
        label = "父需求" if kind == "requirements" else "bug"
        validate_record_id(record_id, label)
        with self.lock:
            if self.syncing or self.submitting:
                raise IssueBusyError("数据处理中，请稍后重试")
            self.submitting = True
        try:
            state_path = self._discussion_state_path(record_id, kind)
            state_path.parent.mkdir(parents=True, exist_ok=True)
            # Serialize the same record across server workers as well as browser tabs.
            with state_path.with_suffix(".lock").open("a+") as guard:
                try:
                    fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError as exc:
                    raise IssueBusyError(f"{label}正在建群，请稍后刷新") from exc
                with tempfile.TemporaryDirectory(prefix="release-lite-discussion-") as directory:
                    rows = self._read_table(
                        kind,
                        directory,
                        None,
                        record_ids=[record_id],
                        artifact_prefix="discussion-before-",
                    )
                    if len(rows) != 1 or rows[0]["id"] != record_id:
                        raise ValueError(f"{label}不存在或无权访问")
                    row = rows[0]
                    if kind == "requirements" and (
                        self._parent_ids(row) or text(row.get("is_child")) == "是"
                    ):
                        raise ValueError("请从主需求创建或关联群聊")
                    chat = self._discussion_chat(row)
                    created = False
                    if not chat:
                        state = self._read_discussion_state(state_path)
                        chat = state.get("chat")
                        if state.get("pending") and not chat:
                            raise SyncError(
                                "建群结果待确认，请在飞书检查并关联群聊后同步"
                            )
                        if not chat:
                            records = (
                                self._requirement_discussion_records(row, directory)
                                if kind == "requirements"
                                else [row]
                            )
                            people = [
                                person
                                for record in records
                                for field in member_fields
                                for person in record.get(field) or []
                            ]
                            members = list(dict.fromkeys(person["id"] for person in people))
                            if any(
                                not isinstance(member, str)
                                or not re.fullmatch(r"ou_[A-Za-z0-9]+", member)
                                for member in members
                            ):
                                raise ValueError("群成员信息无效，请同步后重试")
                            title = (
                                re.sub(
                                    r"^\[([\s\S]*)\]\(https?://[^\s]+\)$",
                                    r"\1",
                                    text(row.get("title")),
                                ).strip()
                                or record_id
                            )
                            name = title[:60]
                            arguments = [
                                "+chat-create",
                                "--name",
                                name,
                                "--description",
                                f"{'需求' if kind == 'requirements' else 'Bug'}讨论 · {record_id}",
                                "--type",
                                "private",
                            ]
                            if members:
                                arguments.extend(["--users", ",".join(members[:50])])
                            # Persist before calling the API; an ambiguous timeout must not create another group.
                            self._write_discussion_state(
                                state_path, {"pending": True, "name": name}
                            )
                            try:
                                result = self._run(arguments, directory, domain="im")
                            except SyncError as exc:
                                if not exc.uncertain:
                                    state_path.unlink(missing_ok=True)
                                raise
                            result = result.get("data", result)
                            chat_id = result.get("chat_id")
                            if not isinstance(chat_id, str) or not chat_id.startswith("oc_"):
                                raise SyncError(
                                    "建群结果待确认，请先在飞书检查"
                                )
                            chat = self._discussion_chat(
                                {
                                    "discussion": [
                                        {"id": chat_id, "name": result.get("name") or name}
                                    ]
                                }
                            )
                            state = {"chat": chat, "remaining_members": members[50:]}
                            self._write_discussion_state(state_path, state)
                            created = True
                        self._invite_discussion_members(state_path, state, directory)
                        # Recheck the field after group creation before writing it.
                        latest = self._read_table(
                            kind,
                            directory,
                            None,
                            record_ids=[record_id],
                            artifact_prefix="discussion-check-",
                        )
                        if len(latest) != 1 or latest[0]["id"] != record_id:
                            raise SyncError(f"群聊已创建，{label}暂时无法访问，请稍后重试关联")
                        existing = self._discussion_chat(latest[0])
                        if existing:
                            warning = self._cache_discussion(kind, record_id, existing)
                            return {
                                "discussion": existing,
                                "created": False,
                                "warning": warning
                                or (
                                    f"{label}已有讨论群，仍使用原群聊；新群“{chat['name']}”未关联"
                                    if existing["id"] != chat["id"]
                                    else ""
                                ),
                            }
                        config = TABLES[kind]
                        payload = {
                            "update_records": {
                                record_id: {config["fields"]["discussion"]: [{"id": chat["id"]}]}
                            }
                        }
                        try:
                            self._run(
                                [
                                    "+record-batch-update",
                                    "--base-token",
                                    BASE_TOKEN,
                                    "--table-id",
                                    config["id"],
                                    "--json",
                                    json.dumps(payload, ensure_ascii=False),
                                ],
                                directory,
                            )
                            for attempt in range(3):
                                verified = self._read_table(
                                    kind,
                                    directory,
                                    None,
                                    record_ids=[record_id],
                                    artifact_prefix=f"discussion-verify-{attempt}-",
                                )
                                linked = (
                                    self._discussion_chat(verified[0])
                                    if len(verified) == 1 and verified[0]["id"] == record_id
                                    else None
                                )
                                if linked and linked["id"] == chat["id"]:
                                    chat = {
                                        **chat,
                                        "name": linked["name"]
                                        if linked["name"] != "讨论群"
                                        else chat["name"],
                                    }
                                    break
                                if attempt < 2:
                                    time.sleep(0.5)
                            else:
                                raise SyncError("群聊关联结果待确认")
                        except SyncError as exc:
                            raise SyncError(
                                f"群聊已创建，关联结果待确认，请点击“重试关联”，无需重新建群。{exc}"
                            ) from exc
                    warning = self._cache_discussion(kind, record_id, chat)
                    try:
                        state_path.unlink(missing_ok=True)
                    except OSError:
                        pass  # A leftover recovery entry is ignored while the source field is populated.
                    return {"discussion": chat, "created": created, "warning": warning}
        except OSError as exc:
            raise SyncError("建群进度保存失败，请先在飞书确认群聊并同步后重试") from exc
        finally:
            with self.lock:
                self.submitting = False

    def update_bug_status(self, record_id, status, expected_status):
        result = self.update_bug_statuses(
            [{"id": record_id, "expected_status": expected_status}], status
        )
        return {"id": record_id, "status": result["status"], "warning": result["warning"]}

    def update_bug_statuses(self, records, status):
        if not isinstance(records, list) or not 1 <= len(records) <= PAGE_SIZE:
            raise ValueError(f"请选择 1 至 {PAGE_SIZE} 条 Bug")
        if not isinstance(status, str) or status not in BUG_TARGET_STATUSES:
            raise ValueError("只支持修改为“处理中”、“已修复待发布”或“已修复”")
        expected = {}
        for record in records:
            if not isinstance(record, dict):
                raise ValueError("Bug 状态更新请求无效")
            record_id = record.get("id")
            validate_record_id(record_id, "bug ")
            if record_id in expected:
                raise ValueError("不能重复选择同一条 Bug")
            if not isinstance(record.get("expected_status"), str):
                raise ValueError("Bug 状态缺失，请刷新后重试")
            expected[record_id] = record["expected_status"]
        record_ids = list(expected)
        with self.lock:
            if self.syncing or self.submitting:
                raise IssueBusyError("数据处理中，请稍后重试")
            self.submitting = True
        write_attempted = False
        try:
            with tempfile.TemporaryDirectory(prefix="release-lite-bug-status-") as directory:
                rows = self._read_table(
                    "bugs", directory, None, record_ids=record_ids, artifact_prefix="before-"
                )
                current = {row["id"]: text(row.get("status")) for row in rows}
                if len(rows) != len(expected) or current.keys() != expected.keys():
                    raise ValueError("Bug 不存在或无权访问")
                if any(
                    current[record_id] not in (status, expected_status)
                    for record_id, expected_status in expected.items()
                ):
                    with self.lock:
                        self._invalidate_snapshot("bugs")
                    raise IssueBusyError("Bug 状态已变化，请同步后重试")
                updates = [record_id for record_id in record_ids if current[record_id] != status]
                if updates:
                    config = TABLES["bugs"]
                    payload = {
                        "update_records": {
                            record_id: {config["fields"]["status"]: [status]}
                            for record_id in updates
                        }
                    }
                    write_attempted = True
                    self._run(
                        [
                            "+record-batch-update",
                            "--base-token",
                            BASE_TOKEN,
                            "--table-id",
                            config["id"],
                            "--json",
                            json.dumps(payload, ensure_ascii=False),
                        ],
                        directory,
                    )
                    for attempt in range(3):
                        verified = self._read_table(
                            "bugs",
                            directory,
                            None,
                            record_ids=record_ids,
                            artifact_prefix=f"verify-{attempt}-",
                        )
                        confirmed = {row["id"]: text(row.get("status")) for row in verified}
                        if (
                            len(verified) == len(expected)
                            and confirmed.keys() == expected.keys()
                            and all(value == status for value in confirmed.values())
                        ):
                            break
                        if attempt < 2:
                            time.sleep(0.5)
                    else:
                        raise SyncError("状态更新结果待确认")
            warning = ""
            with self.lock:
                if self.snapshot is not None:
                    snapshot = {
                        **self.snapshot,
                        "bugs": [
                            {**row, "status": status} if row["id"] in expected else row
                            for row in self.snapshot["bugs"]
                        ],
                    }
                    self.snapshot = snapshot
                    try:
                        self._write_snapshot(snapshot)
                    except OSError:
                        warning = "飞书状态已更新，请重新同步页面数据"
            return {"updated_count": len(expected), "status": status, "warning": warning}
        except (SyncError, OSError) as exc:
            if write_attempted:
                with self.lock:
                    self._invalidate_snapshot("bugs")
                raise SyncError(
                    f"状态更新结果待确认，请同步后检查。{exc}"
                ) from exc
            raise SyncError(str(exc)) from exc
        finally:
            with self.lock:
                self.submitting = False

    def _sync(self, date_range, include_requirement_context=False, kind="overview", sync_id=""):
        try:
            targets = self._sync_targets(kind)
            table_names = (*targets, "projects", "versions") if "bugs" in targets else targets
            release_start, release_end = week_bounds(datetime.now(SHANGHAI).date())
            with tempfile.TemporaryDirectory(prefix="release-lite-issues-") as directory:
                # Independent reads share one bounded pool; each table still paginates in order.
                with ThreadPoolExecutor(max_workers=4, thread_name_prefix="issue-read") as executor:
                    futures = {
                        name: executor.submit(self._read_table, name, directory, date_range)
                        for name in table_names
                    }
                    context = []
                    if "requirements" in targets:
                        # Read releases independently of the page's creation range and filters.
                        futures["release_requirements"] = executor.submit(
                            self._read_release_requirements,
                            directory,
                            release_start,
                            release_end,
                        )
                        requirements = futures["requirements"].result()
                        read_context = (
                            self._read_requirement_context
                            if include_requirement_context
                            else self._read_requirement_parents
                        )
                        context = read_context(requirements, directory, executor)
                    tables = {name: future.result() for name, future in futures.items()}
            projects = {row["id"]: text(row["name"]) for row in tables.get("projects", [])}
            versions = {row["id"]: text(row["name"]) for row in tables.get("versions", [])}
            refreshed = {
                target: [self._normalize(target, row, projects, versions) for row in tables[target]]
                for target in targets
            }
            metadata = {
                "date_range": dict(date_range),
                "timestamp": time.time(),
                "updated_at": datetime.now(SHANGHAI).isoformat(timespec="seconds"),
                "context_complete": include_requirement_context,
                "sync_id": sync_id,
            }
            with self.lock:
                previous = self.snapshot or {
                    "requirements": [],
                    "bugs": [],
                    "requirement_context": [],
                    "table_sync": {},
                }
                snapshot = {
                    **previous,
                    **refreshed,
                    "schema": SNAPSHOT_SCHEMA,
                    "table_sync": {
                        **previous["table_sync"],
                        **{target: dict(metadata) for target in targets},
                    },
                }
                if "requirements" in targets:
                    snapshot["release_requirements"] = tables["release_requirements"]
                    snapshot["release_week_start"] = release_start.isoformat()
                    snapshot["release_calendar_schema"] = RELEASE_CALENDAR_SCHEMA
                    snapshot["requirement_context"] = [
                        self._normalize("requirements", row, projects, versions) for row in context
                    ]
                self._write_snapshot(snapshot)
                self.snapshot = snapshot
                for scope, attempt in self.sync_attempts.items():
                    if attempt.get("date_range") == date_range and set(
                        self._sync_targets(scope)
                    ).issubset(targets):
                        attempt["error"] = ""
                self.progress = "同步完成"
        except (OSError, ValueError, KeyError, TypeError, SyncError) as exc:
            with self.lock:
                self.sync_attempts.setdefault(kind, {})["error"] = (
                    str(exc)
                    if isinstance(exc, SyncError)
                    else "同步失败，请重试"
                )
                self.progress = "同步失败"
        finally:
            with self.lock:
                self.syncing = False

    @staticmethod
    def _normalize(kind, row, projects, versions):
        item = {**row, "kind": kind}
        for key in (
            "title",
            "status",
            "priority",
            "category",
            "environment",
            "attribute",
            "document",
            "design",
            "notes",
            "solution",
            "link",
        ):
            item[key] = text(row.get(key))
        if kind == "requirements":
            item["priority"] = ""
        for key, names in (("project", projects), ("version", versions)):
            if kind == "bugs":
                item[key] = [
                    names.get(value["id"]) or f"未解析关联（{value['id']}）"
                    for value in row.get(key) or []
                ]
            else:
                item[key] = row.get(key) or []
        item["parent_ids"] = IssueService._parent_ids(row) if kind == "requirements" else []
        for key in PARENT_FIELDS:
            item.pop(key, None)
        item["is_child"] = bool(item["parent_ids"]) or text(row.get("is_child")) == "是"
        item["related"] = [value["id"] for value in row.get("related") or []]
        item["source_url"] = (
            SOURCE_URL
            + "?"
            + urlencode(
                {"table": TABLES[kind]["id"], "view": TABLES[kind]["view"], "record": row["id"]}
            )
        )
        return item

    @staticmethod
    def _assignees(row):
        return row.get("developers" if row["kind"] == "requirements" else "owners") or []

    @staticmethod
    def _pending(row):
        return bool(row["status"]) and row["status"] not in TERMINAL[row["kind"]]

    @classmethod
    def _overdue(cls, row, today):
        due = row.get("due_at") or row.get("deadline")
        return cls._pending(row) and bool(due) and due[:10] < today

    @staticmethod
    def _test_deadline_tone(row, today):
        if row["kind"] != "requirements" or row.get("status") in TEST_DEADLINE_EXEMPT_STATUSES:
            return ""
        try:
            deadline = date.fromisoformat(
                text(row.get("test_deadline")).strip()[:10].replace("/", "-")
            )
        except ValueError:
            return ""
        days_left = (deadline - date.fromisoformat(today)).days
        if days_left < 0:
            return "overdue"
        if days_left == 0:
            return "today"
        return "soon" if days_left < 3 else ""

    def set_requirement_priority(self, record_id, priority):
        validate_record_id(record_id, "需求")
        with self.lock:
            snapshot = self.snapshot or {}
            records = snapshot.get("requirements", []) + snapshot.get("requirement_context", [])
        try:
            return self.requirement_priorities.set_priority(records, record_id, priority)
        except OSError as exc:
            raise SyncError("优先级保存失败，请稍后重试") from exc

    def _filter_query_records(
        self, selected, filters, today, condition_filter, dashboard_scope, test_date
    ):
        projects = (
            filters.getlist("project")
            if hasattr(filters, "getlist")
            else filters.get("project", [])
        )
        if isinstance(projects, str):
            projects = [projects]
        projects = {value for value in projects if value}
        if projects:
            selected = [
                row
                for row in selected
                if any(
                    (not row["project"]) if value == EMPTY else value in row["project"]
                    for value in projects
                )
            ]
        for key in ("version", "status", "priority", "environment"):
            value = filters.get(key, "")
            if value:

                def matches(row):
                    cell = row.get(key)
                    if value == EMPTY:
                        return not cell
                    return value in cell if isinstance(cell, list) else cell == value

                selected = [row for row in selected if matches(row)]
        person = filters.get("person", "")
        if person:
            selected = [
                row
                for row in selected
                if (
                    not self._assignees(row)
                    if person == EMPTY
                    else any(p["id"] == person for p in self._assignees(row))
                )
            ]
        hierarchy = filters.get("hierarchy", "")
        if hierarchy:
            selected = [
                row
                for row in selected
                if row["kind"] != "requirements" or row["is_child"] == (hierarchy == "child")
            ]
        query = filters.get("q", "").strip().casefold()
        if query:
            selected = [
                row for row in selected if query in (row["title"] + " " + row["id"]).casefold()
            ]
        scope = filters.get("scope", "")
        if scope:
            selected = [
                row
                for row in selected
                if {
                    "pending": row["pending"],
                    "overdue": row["overdue"],
                    "urgent": row["pending"] and is_high_priority(row),
                    "urgent_overdue": row["overdue"] and is_high_priority(row),
                }.get(scope, True)
            ]
        selected = [row for row in selected if matches_conditions(row, condition_filter)]
        if dashboard_scope or test_date:
            selected = [
                row
                for row in selected
                if matches_dashboard(
                    row,
                    dashboard_scope,
                    test_date,
                    date.fromisoformat(today),
                    REQUIREMENT_PRE_TEST_STATUSES,
                    TEST_DEADLINE_EXEMPT_STATUSES - {"已取消", "无需测试"},
                    TERMINAL["bugs"],
                )
            ]
        return selected

    def _query_options(self, option_rows, kind):
        options = {
            key: sorted(
                {
                    value
                    for row in option_rows
                    for value in (
                        row.get(key) if isinstance(row.get(key), list) else [row.get(key)]
                    )
                    or []
                    if value
                }
            )
            for key in ("project", "version", "status", "priority", "environment")
        }
        if kind == "requirements":
            options["priority"] = list(REQUIREMENT_PRIORITIES)
        elif kind == "overview":
            options["priority"] = list(REQUIREMENT_PRIORITIES) + [
                value for value in options["priority"] if value not in REQUIREMENT_PRIORITIES
            ]
        people = {
            person["id"]: person.get("name") or person["id"]
            for row in option_rows
            for person in self._assignees(row)
        }
        options["person"] = [
            {"id": key, "name": value}
            for key, value in sorted(people.items(), key=lambda pair: pair[1])
        ]
        return options

    @staticmethod
    def _group_requirement_records(records, requirement_tree, sort_by, sort_order):
        record_index = {row["id"]: row for row in records}
        versions = {}
        for group in requirement_tree:
            parent, visited = group[0], set()
            # Hidden or out-of-range parents still determine the group's version.
            while parent["id"] not in visited:
                visited.add(parent["id"])
                ancestors = [
                    record_index[item]
                    for item in parent.get("parent_ids", [])
                    if item in record_index and item not in visited
                ]
                if not ancestors:
                    break
                parent = ancestors[0]
            if sort_by == "priority":
                priority = parent.get("priority") or ""
                version_key = "priority:" + priority
                group_name = priority or "未设置优先级"
            else:
                values = parent.get("version") or []
                version_key = json.dumps(values, ensure_ascii=False)
                group_name = "、".join(values) or "其他版本"
            bucket = versions.setdefault(
                version_key, {"key": version_key, "name": group_name, "groups": []}
            )
            bucket["groups"].append(group)
        ordered_versions = list(versions.values())
        if sort_by == "priority":
            assigned = [bucket for bucket in ordered_versions if bucket["key"] != "priority:"]
            assigned.sort(
                key=lambda bucket: REQUIREMENT_PRIORITIES.index(bucket["name"]),
                reverse=sort_order == "desc",
            )
            ordered_versions = assigned + [
                bucket for bucket in ordered_versions if bucket["key"] == "priority:"
            ]
        else:
            assigned = [bucket for bucket in ordered_versions if bucket["key"] != "[]"]
            assigned.sort(
                key=lambda bucket: version_sort_key(bucket["name"]), reverse=sort_order == "desc"
            )
            ordered_versions = [
                bucket for bucket in ordered_versions if bucket["key"] == "[]"
            ] + assigned
        return ordered_versions

    def _query_items(self, page_rows, index, today):
        items = []
        for row in page_rows:
            related = [
                {
                    "id": related_id,
                    "title": index.get(related_id, {}).get("title") or related_id,
                    "kind": index.get(related_id, {}).get(
                        "kind", "bugs" if row["kind"] == "requirements" else "requirements"
                    ),
                }
                for related_id in row["related"]
            ]
            item = {
                **row,
                "related": related,
                "test_deadline_tone": self._test_deadline_tone(row, today),
            }
            if row["kind"] == "requirements":
                item["can_submit_testing"] = row["status"] in REQUIREMENT_PRE_TEST_STATUSES
            if row["kind"] == "bugs" or not row["is_child"]:
                item["discussion"] = self._discussion_chat(row)
                item["discussion_needs_link"] = False
                item["discussion_creation_pending"] = False
                if not item["discussion"]:
                    try:
                        state = self._read_discussion_state(
                            self._discussion_state_path(row["id"], row["kind"])
                        )
                    except SyncError:
                        state = {"pending": True}
                    if state.get("chat"):
                        item["discussion"] = self._discussion_chat({"discussion": [state["chat"]]})
                        item["discussion_needs_link"] = True
                    else:
                        item["discussion_creation_pending"] = bool(state.get("pending"))
            if row["kind"] == "bugs":
                item["attachments"] = []
                for attachment in row.get("attachments") or []:
                    mime_type = self._attachment_type(attachment)
                    token = attachment.get("file_token")
                    if mime_type and token:
                        item["attachments"].append(
                            {
                                **attachment,
                                "media_kind": mime_type.split("/", 1)[0],
                                "preview_url": f"/api/issues/bugs/{quote(row['id'], safe='')}/attachments/{quote(token, safe='')}",
                            }
                        )
            items.append(item)
        return items

    def _with_local_priorities(self, snapshot):
        try:
            local_priorities = self.requirement_priorities.priorities(
                snapshot["requirements"] + snapshot.get("requirement_context", [])
            )
        except OSError as exc:
            raise SyncError("优先级加载失败，请稍后重试") from exc
        # Keep remote snapshots untouched: requirement priorities exist only locally.
        snapshot = {
            **snapshot,
            **{
                target: [
                    dict(row, priority=local_priorities.get(row["id"], ""))
                    for row in snapshot.get(target, [])
                ]
                for target in ("requirements", "requirement_context")
            },
        }
        return snapshot

    def home_summary(self, filters=None, *, include_family=False):
        filters = filters or {}
        date_range = parse_date_range(filters)
        conditions = normalize_conditions(filters.get("condition_filter"))
        scope = filters.get("dashboard_scope", "")
        if scope and scope not in DASHBOARD_SCOPES:
            raise ValueError("提测筛选范围无效")
        test_date = calendar_date(filters.get("test_date"))
        if filters.get("test_date") and test_date is None:
            raise ValueError("提测日期格式应为 YYYY-MM-DD")
        with self.lock:
            snapshot = self.snapshot or {"requirements": [], "bugs": [], "requirement_context": []}
            ready = self._status(date_range, kind="overview")["ready"]
        snapshot = self._with_local_priorities(snapshot)
        today = datetime.now(SHANGHAI).date()
        rows = snapshot["requirements"] + snapshot["bugs"]
        if not ready:
            rows = [
                row
                for row in rows
                if date_range["created_from"]
                <= (row.get("created_at") or "")[:10]
                <= date_range["created_to"]
            ]
        rows = [
            dict(row, pending=self._pending(row), overdue=self._overdue(row, today.isoformat()))
            for row in rows
        ]
        rows = self._filter_query_records(
            rows, filters, today.isoformat(), conditions, scope, test_date
        )
        result = home_summary(
            {
                **snapshot,
                **{
                    kind: [row for row in rows if row["kind"] == kind]
                    for kind in ("requirements", "bugs")
                },
            },
            today,
            REQUIREMENT_PRE_TEST_STATUSES,
            TERMINAL["bugs"],
            requirement_records=snapshot["requirements"] + snapshot.get("requirement_context", []),
            include_family=include_family,
        )
        filter_keys = (
            "q",
            "project",
            "version",
            "person",
            "status",
            "priority",
            "environment",
            "hierarchy",
            "scope",
            "dashboard_scope",
            "test_date",
        )
        result["filters"] = {
            **{key: filters[key] for key in filter_keys if key in filters},
            **date_range,
        }
        result["condition_filter"] = conditions
        result["cache_complete"] = all(
            cached
            and cached["created_from"] <= date_range["created_from"]
            and cached["created_to"] >= date_range["created_to"]
            for cached in result["ranges"].values()
        )
        return result

    def query(self, kind, filters, page):
        date_range = parse_date_range(filters)
        sort_by, sort_order = requirement_sort(filters)
        condition_filter = normalize_conditions(filters.get("condition_filter"))
        dashboard_scope = filters.get("dashboard_scope", "")
        if dashboard_scope and dashboard_scope not in DASHBOARD_SCOPES:
            raise ValueError("提测筛选范围无效")
        test_date = calendar_date(filters.get("test_date"))
        if filters.get("test_date") and test_date is None:
            raise ValueError("提测日期格式应为 YYYY-MM-DD")
        bug_stage = filters.get("bug_stage", "all")
        if kind == "bugs" and bug_stage not in BUG_STAGES:
            raise ValueError("Bug 处理阶段无效")
        include_family = kind == "requirements" and filters.get("include_family") == "1"
        # Page reads never start a remote sync; only the explicit sync endpoint does.
        with self.lock:
            snapshot, status = self.snapshot, self._status(date_range, include_family, kind)
            if not status["ready"] and snapshot is not None and filters.get("allow_stale") == "1":
                metadata = snapshot.get("table_sync", {})
                targets = self._sync_targets(kind)
                if all(metadata.get(target, {}).get("date_range") for target in targets):
                    stamps = [metadata[target].get("updated_at") for target in targets]
                    status = {
                        **status,
                        "ready": True,
                        "stale": True,
                        "updated_at": min(stamps) if all(stamps) else None,
                        "cached_date_ranges": {
                            target: metadata[target]["date_range"] for target in targets
                        },
                    }
        if not status["ready"]:
            return {"sync": status}
        snapshot = self._with_local_priorities(snapshot)
        today = datetime.now(SHANGHAI).date().isoformat()
        all_rows = snapshot["requirements"] + snapshot["bugs"]
        selected = all_rows if kind == "overview" else snapshot[kind]
        if status.get("stale"):
            selected = [
                row
                for row in selected
                if date_range["created_from"]
                <= (row.get("created_at") or "")[:10]
                <= date_range["created_to"]
            ]
        selected = [
            dict(row, pending=self._pending(row), overdue=self._overdue(row, today))
            for row in selected
        ]
        selected = self._filter_query_records(
            selected, filters, today, condition_filter, dashboard_scope, test_date
        )
        bug_stages = {}
        if kind == "bugs":
            stages = {
                "all": lambda row: True,
                "pending": lambda row: row["status"] != "已修复待发布"
                and (row["pending"] or not row["status"]),
                "release": lambda row: row["status"] == "已修复待发布",
                "fixed": lambda row: row["status"] == "已修复",
            }
            bug_stages = {
                key: sum(matches(row) for row in selected) for key, matches in stages.items()
            }
            selected = [row for row in selected if stages[bug_stage](row)]
        requirements = [row for row in selected if row["kind"] == "requirements"]
        bugs = [row for row in selected if row["kind"] == "bugs"]
        counts = {
            "requirements": len(requirements),
            "bugs": len(bugs),
            "main": sum(not row["is_child"] for row in requirements),
            "children": sum(row["is_child"] for row in requirements),
            "pending_requirements": sum(row["pending"] for row in requirements),
            "pending_bugs": sum(row["pending"] for row in bugs),
            "urgent": sum(row["pending"] and is_high_priority(row) for row in selected),
            "overdue": sum(row["overdue"] for row in selected),
            "missing_status": sum(not row["status"] for row in selected),
        }

        def groups(records, key):
            counter = Counter()
            for row in records:
                value = row.get(key)
                counter.update(
                    (value or ["未填写"]) if isinstance(value, list) else [value or "未填写"]
                )
            return [{"name": name, "count": count} for name, count in counter.most_common()]

        option_rows = all_rows if kind == "overview" else snapshot[kind]
        options = self._query_options(option_rows, kind)
        selected.sort(key=lambda row: (row.get("created_at") or "", row["id"]), reverse=True)
        matched_total = len(selected)
        total_groups = None
        version_groups = []
        total_versions = 0
        page_size = PAGE_SIZE
        context = snapshot.get("requirement_context", [])
        if kind == "requirements":
            records = [
                dict(row, pending=self._pending(row), overdue=self._overdue(row, today))
                for row in snapshot["requirements"] + context
            ]
            requirement_tree = requirement_groups(
                records, {row["id"] for row in selected}, include_family
            )
            total_groups = len(requirement_tree)
            total = sum(len(group) for group in requirement_tree)
            ordered_versions = self._group_requirement_records(
                records, requirement_tree, sort_by, sort_order
            )
            total_versions = len(ordered_versions)
            page_size = VERSION_PAGE_SIZE
            page_count = max(1, (total_versions + page_size - 1) // page_size)
            page = min(page, page_count)
            page_rows = []
            for bucket in ordered_versions[(page - 1) * page_size : page * page_size]:
                rows = [
                    dict(row, version_group=bucket["key"])
                    for group in bucket["groups"]
                    for row in group
                ]
                page_rows.extend(rows)
                version_groups.append(
                    {
                        "key": bucket["key"],
                        "name": bucket["name"],
                        "total": len(rows),
                        "total_groups": len(bucket["groups"]),
                        "matched_total": sum(row["filter_match"] for row in rows),
                    }
                )
        else:
            total = len(selected)
            page_count = max(1, (total + PAGE_SIZE - 1) // PAGE_SIZE)
            page = min(page, page_count)
            page_rows = selected[(page - 1) * PAGE_SIZE : page * PAGE_SIZE]
        # Related links are resolved against the complete cache, not the current page.
        index = {row["id"]: row for row in all_rows + context}
        items = self._query_items(page_rows, index, today)
        return {
            "sync": status,
            "options": options,
            "counts": counts,
            "items": items,
            "bug_stages": bug_stages,
            "bug_notifications": {
                "sync_id": snapshot.get("table_sync", {}).get("bugs", {}).get("sync_id", ""),
                "all_ids": [row["id"] for row in snapshot["bugs"]],
                "items": [{"id": row["id"], "title": row["title"]} for row in bugs],
            }
            if kind in ("overview", "bugs")
            else None,
            "dashboard": summarize(
                requirements,
                bugs,
                date.fromisoformat(today),
                REQUIREMENT_PRE_TEST_STATUSES,
                TEST_DEADLINE_EXEMPT_STATUSES - {"已取消", "无需测试"},
                TERMINAL["bugs"],
                release_requirements=snapshot.get("release_requirements", []),
                release_dates_ready=(
                    snapshot.get("release_calendar_schema") == RELEASE_CALENDAR_SCHEMA
                    and isinstance(snapshot.get("release_requirements"), list)
                    and snapshot.get("release_week_start")
                    == week_bounds(date.fromisoformat(today))[0].isoformat()
                ),
            )
            if kind == "overview"
            else None,
            "total": total,
            "matched_total": matched_total,
            "total_groups": total_groups,
            "version_groups": version_groups,
            "total_versions": total_versions,
            "sort_by": sort_by,
            "sort_order": sort_order,
            "requirement_priorities": list(REQUIREMENT_PRIORITIES),
            "page": page,
            "page_size": page_size,
            "page_count": page_count,
            "charts": {
                "requirements": groups(requirements, "status"),
                "bugs": groups(bugs, "status"),
                "projects": groups([row for row in selected if row["pending"]], "project"),
            },
            "sources": {
                key: SOURCE_URL
                + "?"
                + urlencode({"table": TABLES[key]["id"], "view": TABLES[key]["view"]})
                for key in ("requirements", "bugs")
            },
        }
