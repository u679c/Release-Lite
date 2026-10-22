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
from calendar import monthrange
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from pathlib import Path
from urllib.parse import quote, urlencode
from zoneinfo import ZoneInfo

from .conditions import matches_conditions, normalize_conditions
from .hierarchy import requirement_groups
from .storage import write_json


BASE_TOKEN = "F43vbWYH5aXpvtsUtaFcJ3Ecnle"
SOURCE_URL = "https://yuntikeji.feishu.cn/wiki/A0SmwJ6j8ixj9Fkg39YcFeJlnyg"
SHANGHAI = ZoneInfo("Asia/Shanghai")
EMPTY = "__empty__"
PAGE_SIZE = 30
VERSION_PAGE_SIZE = 10
SNAPSHOT_SCHEMA = 8
PARENT_FIELDS = {
    "parent_1": "fldTtcEaOw", "parent_3": "fldmBm8Fca", "parent_4": "fld4W9jZtn",
    "parent_5": "fld5Ry2Rjb", "parent_6": "fldi0g18OL", "parent_7": "fldro9TwSP",
    "parent_8": "fldAEk4LXd",
}
TERMINAL = {
    "requirements": {"已上线", "已完成", "已取消"},
    "bugs": {"已修复", "已关闭", "无需解决", "已取消", "重复bug", "转需求"},
}
TEST_DEADLINE_EXEMPT_STATUSES = {
    "测试中", "用例检查", "测试完成", "预发验收", "待上线",
    "线上验收", "已上线", "已取消", "无需测试", "已完成",
}
BUG_TARGET_STATUSES = {"处理中", "已修复待发布", "已修复"}
BUG_STAGES = {"all", "pending", "release", "fixed"}
ATTACHMENT_MEDIA_TYPES = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
    ".avif": "image/avif", ".ico": "image/x-icon", ".heic": "image/heic",
    ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime",
    ".webm": "video/webm", ".ogv": "video/ogg", ".avi": "video/x-msvideo",
    ".mkv": "video/x-matroska", ".3gp": "video/3gpp", ".mpeg": "video/mpeg", ".mpg": "video/mpeg",
}
# Stable field IDs keep the adapter working when display names are changed.
TABLES = {
    "requirements": {
        "id": "tbl6f7PnU06TPBYJ", "view": "vewOi3oja0",
        "fields": {
            "title": "fld03YMwlU", "project": "fldvDGKP4K", "version": "fldS6s6p7t",
            "status": "fldb47enoE",
            "priority": "fldc98U8Kv", "developers": "fldxzI3w8E",
            "products": "fld1y1zdvt", "designers": "fldxEALysv", "test_deadline": "fldq4s2d06",
            "testers": "fldjfXdcNL", "created_at": "fldrfNv4jd", "start_at": "fldPYlF2n8",
            "due_at": "fldQBKvq1R", "is_child": "fldjzBQSTT", "related": "fldlH7hHvl",
            "category": "fldJWm309G", "document": "flda2bGuqs", "design": "fldszn4N8I",
            **PARENT_FIELDS,
        },
    },
    "bugs": {
        "id": "tbldaX1pCCTuMpMJ", "view": "vewYSMKkr9",
        "fields": {
            "title": "fld6Z8zskd", "project": "fldUbrPopi",
            "version": "fldkjOW13F", "status": "fldMu4AJfq", "priority": "fldgoRzCN8",
            "owners": "fldHk1PEsK", "creators": "fld17KNHUZ", "created_at": "fldLZwbwd9", "due_at": "fldCOuqMKf",
            "deadline": "fldTR4liDi", "updated_at": "fldCmGTla9", "environment": "fldz3nMOSb",
            "category": "fldSmqAHew", "attribute": "fldatlzUpt", "related": "fldHkBoXis",
            "notes": "fldmGDT3XA", "solution": "fldZO5uGjQ", "link": "fldjz3Hl3x",
            "attachments": "fldyTKiLyK", "discussion": "fldIB1BPQF",
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
    if not isinstance(record_id, str) or not record_id.startswith("rec") or not record_id.isascii() or not record_id.isalnum():
        raise ValueError(f"{label}记录 ID 不正确")


def version_sort_key(name):
    """Compare numeric parts as numbers, so 5.10 sorts after 5.9."""
    return tuple((1, int(part)) if part.isdecimal() else (0, part.casefold()) for part in re.split(r"(\d+)", name))


def parse_date_range(filters):
    today = datetime.now(SHANGHAI).date()
    year, month = divmod(today.year * 12 + today.month - 1 - 2, 12)
    month += 1
    default_start = today.replace(year=year, month=month, day=min(today.day, monthrange(year, month)[1]))
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
                cached = {**cached, "schema": SNAPSHOT_SCHEMA, "table_sync": {
                    kind: {key: cached.get(key) for key in ("date_range", "timestamp", "updated_at", "context_complete")}
                    for kind in ("requirements", "bugs")
                }}
            if cached.get("schema") == SNAPSHOT_SCHEMA and isinstance(cached.get("table_sync"), dict) and all(isinstance(cached.get(k), list) for k in ("requirements", "bugs", "requirement_context")):
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
            "ready": ready, "syncing": self.syncing, "submitting": self.submitting,
            "error": attempt.get("error", "") if attempt.get("date_range") == date_range else "", "progress": self.progress,
            "updated_at": min(stamps) if ready and all(stamps) else None,
            "date_range": date_range,
        }

    def start_sync(self, date_range, force=False, include_requirement_context=False, kind="overview"):
        with self.lock:
            if self.syncing or self.submitting:
                return
            metadata = (self.snapshot or {}).get("table_sync", {})
            targets = self._sync_targets(kind)
            matches = all(metadata.get(target, {}).get("date_range") == date_range for target in targets)
            requirement_meta = metadata.get("requirements", {})
            has_context = requirement_meta.get("date_range") == date_range and requirement_meta.get("context_complete")
            include_requirement_context = "requirements" in targets and (include_requirement_context or bool(has_context))
            needs_context = include_requirement_context and not has_context
            updated = min(metadata[target].get("timestamp", 0) for target in targets) if matches else 0
            attempt = self.sync_attempts.get(kind, {})
            recent_attempt = attempt.get("date_range") == date_range and attempt.get("context") == include_requirement_context and time.time() - attempt.get("at", 0) < 60
            if not force and (recent_attempt or (not needs_context and time.time() - updated < 300)):
                return
            self.syncing = True
            self.sync_attempts[kind] = {"at": time.time(), "date_range": dict(date_range), "context": include_requirement_context, "error": ""}
            self.progress = f"正在读取创建时间 {date_range['created_from']} 至 {date_range['created_to']} 的记录…"
        threading.Thread(target=self._sync, args=(dict(date_range), include_requirement_context, kind), daemon=True, name="issue-sync").start()

    def _invalidate_snapshot(self, kind):
        # Called while holding self.lock after an uncertain remote update.
        if self.snapshot is not None:
            metadata = self.snapshot.get("table_sync", {})
            self.snapshot = {**self.snapshot, "table_sync": {
                target: {**value, "timestamp": 0} if target == kind else value
                for target, value in metadata.items()
            }}
        for scope in (kind, "overview"):
            self.sync_attempts.pop(scope, None)

    def _run(self, arguments, cwd, domain="base"):
        operation = "建群" if arguments[0] == "+chat-create" else "更新" if arguments[0] == "+record-batch-update" else "下载附件" if arguments[0] == "+record-download-attachment" else "读取"
        executable = os.environ.get("RELEASE_LITE_LARK_CLI", "lark-cli")
        env = {**os.environ, "LARKSUITE_CLI_NO_UPDATE_NOTIFIER": "1", "LARKSUITE_CLI_NO_SKILLS_NOTIFIER": "1"}
        try:
            result = subprocess.run(
                [executable, domain, *arguments, "--as", "user"], cwd=cwd,
                capture_output=True, text=True, timeout=90, env=env,
            )
        except FileNotFoundError as exc:
            raise SyncError("未找到 lark-cli，请在服务器安装，或配置 RELEASE_LITE_LARK_CLI 指向可执行文件。") from exc
        except subprocess.TimeoutExpired as exc:
            raise SyncError(f"飞书{operation}超时，请稍后重试。", uncertain=True) from exc
        try:
            payload = json.loads(result.stdout if result.returncode == 0 else result.stderr)
        except ValueError as exc:
            raise SyncError("lark-cli 未返回有效 JSON，请检查服务器 CLI 配置与登录状态。", uncertain=True) from exc
        if result.returncode != 0 or payload.get("ok") is False:
            error = payload.get("error") or {}
            if error.get("type") == "authorization" or error.get("missing_scopes"):
                if domain == "im":
                    raise SyncError("飞书建群权限不足或登录已失效，请为当前登录用户授权 im:chat:create_by_user 后重试。")
                raise SyncError("飞书登录已失效或操作权限不足，请在运行面板的服务器用户下执行 lark-cli auth status --json --verify 检查并完成授权。")
            if error.get("type") == "network":
                raise SyncError("服务器无法连接飞书，请检查网络后重试同步。", uncertain=True)
            raise SyncError(f"飞书{operation}失败，请检查 CLI 登录状态及数据表访问权限。")
        return payload

    @staticmethod
    def _attachment_type(attachment):
        return ATTACHMENT_MEDIA_TYPES.get(Path(attachment.get("name") or "").suffix.lower(), "")

    def attachment(self, record_id, file_token):
        # Only serve files belonging to a bug in the current snapshot.
        with self.lock:
            row = next((row for row in (self.snapshot or {}).get("bugs", []) if row["id"] == record_id), None)
            attachment = next((item for item in (row or {}).get("attachments") or [] if item.get("file_token") == file_token), None)
            if not attachment or not self._attachment_type(attachment):
                raise FileNotFoundError("未找到图片或视频附件，请同步数据后重试。")
            download_lock = self.attachment_locks.setdefault((record_id, file_token), threading.Lock())
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
            return size > 0 and (size == expected_size if isinstance(expected_size, int) and expected_size > 0 else True)

        try:
            with download_lock:
                if not complete(cached):
                    directory.mkdir(parents=True, exist_ok=True)
                    with tempfile.TemporaryDirectory(prefix="download-", dir=directory) as temporary:
                        filename = f"media{extension}"
                        self._run([
                            "+record-download-attachment", "--base-token", BASE_TOKEN,
                            "--table-id", TABLES["bugs"]["id"], "--record-id", record_id,
                            "--file-token", file_token, "--output", filename,
                        ], temporary)
                        downloaded = Path(temporary) / filename
                        if not complete(downloaded):
                            raise SyncError("附件下载不完整，请同步数据后重试。")
                        downloaded.replace(cached)
            return cached, mime_type
        except OSError as exc:
            raise SyncError("服务器无法读取或缓存附件，请稍后重试。") from exc

    def _read_table(self, kind, directory, date_range, *, record_filter=None, record_ids=None, artifact_prefix=""):
        config = TABLES[kind]
        if date_range is not None and kind in ("requirements", "bugs"):
            # Date comparisons are strict in Base; include both selected calendar days.
            before_start = date.fromisoformat(date_range["created_from"]) - timedelta(days=1)
            after_end = date.fromisoformat(date_range["created_to"]) + timedelta(days=1)
            record_filter = {
                "logic": "and", "conditions": [
                    [config["fields"]["created_at"], ">", f"ExactDate({before_start.isoformat()} 23:59:59.999)"],
                    [config["fields"]["created_at"], "<", f"ExactDate({after_end.isoformat()} 00:00:00)"],
                ],
            }
        records, offset, revision = [], 0, None
        while True:
            with self.lock:
                self.progress = f"正在读取{ {'requirements': '需求', 'bugs': 'bug', 'projects': '项目', 'versions': '版本'}[kind] }，已读取 {len(records)} 条…"
            filename = f"{artifact_prefix}{kind}-{offset}.ndjson"
            arguments = ["+record-get" if record_ids else "+record-list", "--base-token", BASE_TOKEN, "--table-id", config["id"]]
            for record_id in record_ids or []:
                arguments.extend(["--record-id", record_id])
            for field_id in config["fields"].values():
                arguments.extend(["--field-id", field_id])
            # Query parameters only: never modify the Feishu records or saved view filters.
            if record_filter is not None:
                arguments.extend(["--filter-json", json.dumps(record_filter, ensure_ascii=False)])
            if not record_ids:
                arguments.extend(["--offset", str(offset), "--limit", "2000"])
            arguments.extend(["--format", "ndjson", "--output", filename])
            manifest = self._run(arguments, directory)
            if revision is not None and revision != manifest.get("rev"):
                raise SyncError("读取期间飞书表数据发生变化，本次未覆盖缓存，请重新同步。")
            revision = manifest.get("rev")
            columns = {column.get("field_id"): name for name, column in manifest.get("columns", {}).items()}
            missing = set(config["fields"].values()) - set(columns)
            if missing and manifest.get("records_count") != 0:
                raise SyncError("飞书表字段配置发生变化，请检查 issue_management/service.py 中的字段映射。")
            page = []
            with (Path(directory) / filename).open(encoding="utf-8") as stream:
                for line in stream:
                    if line.strip():
                        raw = json.loads(line)
                        page.append({"id": raw["record_id"], **{key: raw.get(columns[field]) for key, field in config["fields"].items()}})
            if len(page) != manifest.get("records_count"):
                raise SyncError("飞书返回的记录数量不完整，本次未覆盖缓存，请重试。")
            records.extend(page)
            if not manifest.get("has_more"):
                break
            next_offset = manifest.get("next_offset")
            if not isinstance(next_offset, int) or next_offset <= offset:
                raise SyncError("飞书分页信息异常，本次未覆盖缓存。")
            offset = next_offset
        if len({row["id"] for row in records}) != len(records):
            raise SyncError("飞书分页出现重复记录，本次未覆盖缓存，请重试。")
        return records

    @staticmethod
    def _parent_ids(row):
        return list(dict.fromkeys(value["id"] for key in PARENT_FIELDS for value in row.get(key) or []))

    def _read_requirement_batches(self, batches, directory, executor=None):
        if executor is None:
            return [self._read_table("requirements", directory, None, **batch) for batch in batches]
        futures = [executor.submit(self._read_table, "requirements", directory, None, **batch) for batch in batches]
        return [future.result() for future in futures]

    def _read_requirement_context(self, records, directory, executor=None):
        index = {row["id"]: row for row in records}
        pending, attempted_parents, batch_number = set(index), set(), 0
        while pending:
            current, pending = sorted(pending), set()
            missing = sorted({parent_id for row in index.values() for parent_id in self._parent_ids(row)} - index.keys() - attempted_parents)
            batches = []
            for offset in range(0, len(missing), 50):
                batch = missing[offset:offset + 50]
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
                links = [{"id": record_id} for record_id in current[offset:offset + 50]]
                record_filter = {"logic": "or", "conditions": [[field_id, "intersects", links] for field_id in PARENT_FIELDS.values()]}
                batches.append({"record_filter": record_filter, "artifact_prefix": f"family-{batch_number}-"})
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
            missing = sorted({parent_id for row in index.values() for parent_id in self._parent_ids(row)} - index.keys() - attempted)
            if not missing:
                break
            batches = []
            for offset in range(0, len(missing), 50):
                batch = missing[offset:offset + 50]
                attempted.update(batch)
                batches.append({"record_ids": batch, "artifact_prefix": f"parents-{batch_number}-"})
                batch_number += 1
            for parents in self._read_requirement_batches(batches, directory, executor):
                index.update({row["id"]: row for row in parents})
        original_ids = {row["id"] for row in records}
        return [row for record_id, row in index.items() if record_id not in original_ids]

    def _write_snapshot(self, snapshot):
        write_json(self.cache_dir / "snapshot.json", snapshot)

    def submit_requirement(self, record_id):
        validate_record_id(record_id, "需求")
        with self.lock:
            if self.syncing or self.submitting:
                raise IssueBusyError("正在同步数据或提测，请稍后重试。")
            self.submitting = True
        write_attempted = False
        try:
            with tempfile.TemporaryDirectory(prefix="release-lite-submit-") as directory:
                parents = self._read_table("requirements", directory, None, record_ids=[record_id], artifact_prefix="submit-parent-")
                if len(parents) != 1 or parents[0]["id"] != record_id:
                    raise ValueError("父需求不存在或无权访问")
                if self._parent_ids(parents[0]) or text(parents[0].get("is_child")) == "是":
                    raise ValueError("只能通过父需求执行提测")
                # Resolve all descendants from the source, independent of dates and UI filters.
                records, pending, batch_number = {record_id: parents[0]}, [record_id], 0
                while pending:
                    current, pending = pending, []
                    for offset in range(0, len(current), 50):
                        links = [{"id": item} for item in current[offset:offset + 50]]
                        record_filter = {"logic": "or", "conditions": [[field_id, "intersects", links] for field_id in PARENT_FIELDS.values()]}
                        children = self._read_table("requirements", directory, None, record_filter=record_filter, artifact_prefix=f"submit-children-{batch_number}-")
                        batch_number += 1
                        for row in children:
                            if row["id"] not in records:
                                records[row["id"]] = row
                                pending.append(row["id"])
                record_ids = sorted(records)
                config = TABLES["requirements"]
                for offset in range(0, len(record_ids), 200):
                    payload = {"update_records": {item: {config["fields"]["status"]: ["测试中"]} for item in record_ids[offset:offset + 200]}}
                    write_attempted = True
                    self._run(["+record-batch-update", "--base-token", BASE_TOKEN, "--table-id", config["id"], "--json", json.dumps(payload, ensure_ascii=False)], directory)
                # The write response does not report per-record results; confirm actual statuses.
                for attempt in range(3):
                    verified = {}
                    for offset in range(0, len(record_ids), 50):
                        rows = self._read_table("requirements", directory, None, record_ids=record_ids[offset:offset + 50], artifact_prefix=f"submit-verify-{attempt}-{offset}-")
                        verified.update({row["id"]: text(row.get("status")) for row in rows})
                    if all(verified.get(item) == "测试中" for item in record_ids):
                        break
                    if attempt < 2:
                        time.sleep(0.5)
                else:
                    raise SyncError("部分记录的状态尚未确认为“测试中”")
            warning = ""
            with self.lock:
                if self.snapshot is not None:
                    snapshot = {**self.snapshot}
                    for key in ("requirements", "requirement_context"):
                        snapshot[key] = [{**row, "status": "测试中"} if row["id"] in records else row for row in snapshot[key]]
                    self.snapshot = snapshot
                    try:
                        self._write_snapshot(snapshot)
                    except OSError:
                        warning = "飞书已更新，本地缓存保存失败，请重新同步数据。"
            return {"status": "测试中", "updated_count": len(record_ids), "warning": warning}
        except (SyncError, OSError) as exc:
            if write_attempted:
                with self.lock:
                    self._invalidate_snapshot("requirements")
                raise SyncError(f"提测未能确认全部完成：{exc}。部分记录可能已更新，请同步数据后重试。") from exc
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
            raise SyncError("讨论群数据不正确，请同步数据后重试。")
        return {
            "id": chat_id, "name": chat.get("name") or "讨论群",
            "url": "https://applink.feishu.cn/client/chat/open?" + urlencode({"openChatId": chat_id}),
        }

    def _discussion_state_path(self, record_id):
        digest = hashlib.sha256(record_id.encode()).hexdigest()
        return self.cache_dir / "discussions" / f"chat-{digest}.json"

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
            raise SyncError("无法读取建群恢复记录，请先在飞书确认讨论群，避免重复建群。") from exc

    @staticmethod
    def _write_discussion_state(path, state):
        write_json(path, state)

    def _cache_bug_discussion(self, record_id, chat):
        warning = ""
        with self.lock:
            if self.snapshot is not None:
                snapshot = {**self.snapshot, "bugs": [
                    {**row, "discussion": [{"id": chat["id"], "name": chat["name"]}]} if row["id"] == record_id else row
                    for row in self.snapshot["bugs"]
                ]}
                self.snapshot = snapshot
                try:
                    self._write_snapshot(snapshot)
                except OSError:
                    warning = "讨论群已关联，缓存保存失败，请重新同步数据。"
        return warning

    def create_bug_discussion(self, record_id):
        validate_record_id(record_id, "bug ")
        with self.lock:
            if self.syncing or self.submitting:
                raise IssueBusyError("正在同步数据或更新记录，请稍后重试。")
            self.submitting = True
        try:
            state_path = self._discussion_state_path(record_id)
            state_path.parent.mkdir(parents=True, exist_ok=True)
            # Serialize the same bug across server workers as well as browser tabs.
            with state_path.with_suffix(".lock").open("a+") as guard:
                try:
                    fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError as exc:
                    raise IssueBusyError("当前 bug 正在建群，请稍后刷新。") from exc
                with tempfile.TemporaryDirectory(prefix="release-lite-discussion-") as directory:
                    rows = self._read_table("bugs", directory, None, record_ids=[record_id], artifact_prefix="discussion-before-")
                    if len(rows) != 1 or rows[0]["id"] != record_id:
                        raise ValueError("bug 不存在或无权访问")
                    row = rows[0]
                    chat = self._discussion_chat(row)
                    created = False
                    if not chat:
                        state = self._read_discussion_state(state_path)
                        chat = state.get("chat")
                        if state.get("pending") and not chat:
                            raise SyncError("上次建群结果尚未确认，请先在飞书检查并关联讨论群，然后同步数据。")
                        if not chat:
                            people = [*(row.get("creators") or []), *(row.get("owners") or [])]
                            members = list(dict.fromkeys(person["id"] for person in people))
                            if any(not isinstance(member, str) or not re.fullmatch(r"ou_[A-Za-z0-9]+", member) for member in members):
                                raise ValueError("创建人或处理人的飞书用户 ID 不正确，请同步后重试。")
                            title = re.sub(r"^\[([\s\S]*)\]\(https?://[^\s]+\)$", r"\1", text(row.get("title"))).strip() or record_id
                            name = title[:60]
                            arguments = ["+chat-create", "--name", name, "--description", f"Bug 讨论 · {record_id}", "--type", "private"]
                            if members:
                                arguments.extend(["--users", ",".join(members)])
                            # Persist before calling the API; an ambiguous timeout must not create another group.
                            self._write_discussion_state(state_path, {"pending": True, "name": name})
                            try:
                                result = self._run(arguments, directory, domain="im")
                            except SyncError as exc:
                                if not exc.uncertain:
                                    state_path.unlink(missing_ok=True)
                                raise
                            result = result.get("data", result)
                            chat_id = result.get("chat_id")
                            if not isinstance(chat_id, str) or not chat_id.startswith("oc_"):
                                raise SyncError("建群请求已返回，但未取得群 ID，请先在飞书确认结果。")
                            chat = self._discussion_chat({"discussion": [{"id": chat_id, "name": result.get("name") or name}]})
                            self._write_discussion_state(state_path, {"chat": chat})
                            created = True
                        # Recheck the field after group creation before writing it.
                        latest = self._read_table("bugs", directory, None, record_ids=[record_id], artifact_prefix="discussion-check-")
                        if len(latest) != 1 or latest[0]["id"] != record_id:
                            raise SyncError("群已创建，bug 记录暂时无法访问，请稍后重试关联。")
                        existing = self._discussion_chat(latest[0])
                        if existing:
                            warning = self._cache_bug_discussion(record_id, existing)
                            return {"discussion": existing, "created": False, "warning": warning or (f"该 bug 已关联其他讨论群，保留原关联；新建群“{chat['name']}”未覆盖它。" if existing["id"] != chat["id"] else "")}
                        config = TABLES["bugs"]
                        payload = {"update_records": {record_id: {config["fields"]["discussion"]: [{"id": chat["id"]}]}}}
                        try:
                            self._run(["+record-batch-update", "--base-token", BASE_TOKEN, "--table-id", config["id"], "--json", json.dumps(payload, ensure_ascii=False)], directory)
                            for attempt in range(3):
                                verified = self._read_table("bugs", directory, None, record_ids=[record_id], artifact_prefix=f"discussion-verify-{attempt}-")
                                linked = self._discussion_chat(verified[0]) if len(verified) == 1 and verified[0]["id"] == record_id else None
                                if linked and linked["id"] == chat["id"]:
                                    chat = {**chat, "name": linked["name"] if linked["name"] != "讨论群" else chat["name"]}
                                    break
                                if attempt < 2:
                                    time.sleep(0.5)
                            else:
                                raise SyncError("尚未读回讨论群关联")
                        except SyncError as exc:
                            raise SyncError(f"讨论群已创建，但关联未能确认：{exc} 再次点击“重试关联”将复用此群。") from exc
                    warning = self._cache_bug_discussion(record_id, chat)
                    try:
                        state_path.unlink(missing_ok=True)
                    except OSError:
                        pass  # A leftover recovery entry is ignored while the source field is populated.
                    return {"discussion": chat, "created": created, "warning": warning}
        except OSError as exc:
            raise SyncError("无法保存建群恢复记录，请先同步并确认飞书讨论群后重试。") from exc
        finally:
            with self.lock:
                self.submitting = False

    def update_bug_status(self, record_id, status, expected_status):
        result = self.update_bug_statuses([{"id": record_id, "expected_status": expected_status}], status)
        return {"id": record_id, "status": result["status"], "warning": result["warning"]}

    def update_bug_statuses(self, records, status):
        if not isinstance(records, list) or not 1 <= len(records) <= PAGE_SIZE:
            raise ValueError(f"请选择 1 至 {PAGE_SIZE} 条 bug")
        if not isinstance(status, str) or status not in BUG_TARGET_STATUSES:
            raise ValueError("只支持修改为“处理中”、“已修复待发布”或“已修复”")
        expected = {}
        for record in records:
            if not isinstance(record, dict):
                raise ValueError("bug 状态更新参数格式不正确")
            record_id = record.get("id")
            validate_record_id(record_id, "bug ")
            if record_id in expected:
                raise ValueError("不能重复选择同一条 bug")
            if not isinstance(record.get("expected_status"), str):
                raise ValueError("缺少当前 bug 状态，请刷新后重试")
            expected[record_id] = record["expected_status"]
        record_ids = list(expected)
        with self.lock:
            if self.syncing or self.submitting:
                raise IssueBusyError("正在同步数据或更新记录，请稍后重试。")
            self.submitting = True
        write_attempted = False
        try:
            with tempfile.TemporaryDirectory(prefix="release-lite-bug-status-") as directory:
                rows = self._read_table("bugs", directory, None, record_ids=record_ids, artifact_prefix="before-")
                current = {row["id"]: text(row.get("status")) for row in rows}
                if len(rows) != len(expected) or current.keys() != expected.keys():
                    raise ValueError("bug 不存在或无权访问")
                if any(current[record_id] not in (status, expected_status) for record_id, expected_status in expected.items()):
                    with self.lock:
                        self._invalidate_snapshot("bugs")
                    raise IssueBusyError("bug 状态已被其他操作修改，请同步后重新确认。")
                updates = [record_id for record_id in record_ids if current[record_id] != status]
                if updates:
                    config = TABLES["bugs"]
                    payload = {"update_records": {record_id: {config["fields"]["status"]: [status]} for record_id in updates}}
                    write_attempted = True
                    self._run(["+record-batch-update", "--base-token", BASE_TOKEN, "--table-id", config["id"], "--json", json.dumps(payload, ensure_ascii=False)], directory)
                    for attempt in range(3):
                        verified = self._read_table("bugs", directory, None, record_ids=record_ids, artifact_prefix=f"verify-{attempt}-")
                        confirmed = {row["id"]: text(row.get("status")) for row in verified}
                        if len(verified) == len(expected) and confirmed.keys() == expected.keys() and all(value == status for value in confirmed.values()):
                            break
                        if attempt < 2:
                            time.sleep(0.5)
                    else:
                        raise SyncError("尚未读回目标状态")
            warning = ""
            with self.lock:
                if self.snapshot is not None:
                    snapshot = {**self.snapshot, "bugs": [{**row, "status": status} if row["id"] in expected else row for row in self.snapshot["bugs"]]}
                    self.snapshot = snapshot
                    try:
                        self._write_snapshot(snapshot)
                    except OSError:
                        warning = "飞书状态已更新，本地缓存保存失败，请重新同步数据。"
            return {"updated_count": len(expected), "status": status, "warning": warning}
        except (SyncError, OSError) as exc:
            if write_attempted:
                with self.lock:
                    self._invalidate_snapshot("bugs")
                raise SyncError(f"状态更新结果未能确认：{exc}。记录可能已更新，请同步后确认。") from exc
            raise SyncError(str(exc)) from exc
        finally:
            with self.lock:
                self.submitting = False

    def _sync(self, date_range, include_requirement_context=False, kind="overview"):
        try:
            targets = self._sync_targets(kind)
            table_names = (*targets, "projects", "versions") if "bugs" in targets else targets
            with tempfile.TemporaryDirectory(prefix="release-lite-issues-") as directory:
                # Independent reads share one bounded pool; each table still paginates in order.
                with ThreadPoolExecutor(max_workers=4, thread_name_prefix="issue-read") as executor:
                    futures = {name: executor.submit(self._read_table, name, directory, date_range) for name in table_names}
                    context = []
                    if "requirements" in targets:
                        requirements = futures["requirements"].result()
                        read_context = self._read_requirement_context if include_requirement_context else self._read_requirement_parents
                        context = read_context(requirements, directory, executor)
                    tables = {name: future.result() for name, future in futures.items()}
            projects = {row["id"]: text(row["name"]) for row in tables.get("projects", [])}
            versions = {row["id"]: text(row["name"]) for row in tables.get("versions", [])}
            refreshed = {target: [self._normalize(target, row, projects, versions) for row in tables[target]] for target in targets}
            metadata = {"date_range": dict(date_range), "timestamp": time.time(), "updated_at": datetime.now(SHANGHAI).isoformat(timespec="seconds"), "context_complete": include_requirement_context}
            with self.lock:
                previous = self.snapshot or {"requirements": [], "bugs": [], "requirement_context": [], "table_sync": {}}
                snapshot = {**previous, **refreshed, "schema": SNAPSHOT_SCHEMA, "table_sync": {
                    **previous["table_sync"], **{target: dict(metadata) for target in targets},
                }}
                if "requirements" in targets:
                    snapshot["requirement_context"] = [self._normalize("requirements", row, projects, versions) for row in context]
                self._write_snapshot(snapshot)
                self.snapshot = snapshot
                for scope, attempt in self.sync_attempts.items():
                    if attempt.get("date_range") == date_range and set(self._sync_targets(scope)).issubset(targets):
                        attempt["error"] = ""
                self.progress = "同步完成"
        except (OSError, ValueError, KeyError, TypeError, SyncError) as exc:
            with self.lock:
                self.sync_attempts.setdefault(kind, {})["error"] = str(exc) if isinstance(exc, SyncError) else "同步数据失败，上次成功的数据已保留，请重试。"
                self.progress = "同步失败"
        finally:
            with self.lock:
                self.syncing = False

    @staticmethod
    def _normalize(kind, row, projects, versions):
        item = {**row, "kind": kind}
        for key in ("title", "status", "priority", "category", "environment", "attribute", "document", "design", "notes", "solution", "link"):
            item[key] = text(row.get(key))
        for key, names in (("project", projects), ("version", versions)):
            if kind == "bugs":
                item[key] = [names.get(value["id"]) or f"未解析关联（{value['id']}）" for value in row.get(key) or []]
            else:
                item[key] = row.get(key) or []
        item["parent_ids"] = IssueService._parent_ids(row) if kind == "requirements" else []
        for key in PARENT_FIELDS:
            item.pop(key, None)
        item["is_child"] = bool(item["parent_ids"]) or text(row.get("is_child")) == "是"
        item["related"] = [value["id"] for value in row.get("related") or []]
        item["source_url"] = SOURCE_URL + "?" + urlencode({"table": TABLES[kind]["id"], "view": TABLES[kind]["view"], "record": row["id"]})
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
            deadline = date.fromisoformat(text(row.get("test_deadline")).strip()[:10].replace("/", "-"))
        except ValueError:
            return ""
        days_left = (deadline - date.fromisoformat(today)).days
        if days_left < 0:
            return "overdue"
        if days_left == 0:
            return "today"
        return "soon" if days_left < 3 else ""

    def query(self, kind, filters, page):
        date_range = parse_date_range(filters)
        condition_filter = normalize_conditions(filters.get("condition_filter"))
        bug_stage = filters.get("bug_stage", "all")
        if kind == "bugs" and bug_stage not in BUG_STAGES:
            raise ValueError("bug 处理阶段不正确")
        include_family = kind == "requirements" and filters.get("include_family") == "1"
        self.start_sync(date_range, include_requirement_context=include_family, kind=kind)
        with self.lock:
            snapshot, status = self.snapshot, self._status(date_range, include_family, kind)
            if not status["ready"] and snapshot is not None and filters.get("allow_stale") == "1":
                metadata = snapshot.get("table_sync", {})
                targets = self._sync_targets(kind)
                if all(metadata.get(target, {}).get("date_range") for target in targets):
                    stamps = [metadata[target].get("updated_at") for target in targets]
                    status = {
                        **status, "ready": True, "stale": True,
                        "updated_at": min(stamps) if all(stamps) else None,
                        "cached_date_ranges": {target: metadata[target]["date_range"] for target in targets},
                    }
        if not status["ready"]:
            return {"sync": status}
        today = datetime.now(SHANGHAI).date().isoformat()
        all_rows = snapshot["requirements"] + snapshot["bugs"]
        selected = all_rows if kind == "overview" else snapshot[kind]
        if status.get("stale"):
            selected = [row for row in selected if date_range["created_from"] <= (row.get("created_at") or "")[:10] <= date_range["created_to"]]
        selected = [dict(row, pending=self._pending(row), overdue=self._overdue(row, today)) for row in selected]
        projects = filters.getlist("project") if hasattr(filters, "getlist") else filters.get("project", [])
        if isinstance(projects, str):
            projects = [projects]
        projects = {value for value in projects if value}
        if projects:
            selected = [row for row in selected if any(
                (not row["project"]) if value == EMPTY else value in row["project"]
                for value in projects
            )]
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
            selected = [row for row in selected if (not self._assignees(row) if person == EMPTY else any(p["id"] == person for p in self._assignees(row)))]
        hierarchy = filters.get("hierarchy", "")
        if hierarchy:
            selected = [row for row in selected if row["kind"] != "requirements" or row["is_child"] == (hierarchy == "child")]
        query = filters.get("q", "").strip().casefold()
        if query:
            selected = [row for row in selected if query in (row["title"] + " " + row["id"]).casefold()]
        scope = filters.get("scope", "")
        if scope:
            selected = [row for row in selected if {
                "pending": row["pending"], "overdue": row["overdue"],
                "urgent": row["pending"] and row["priority"] in ("紧急", "高"),
                "urgent_overdue": row["overdue"] and row["priority"] in ("紧急", "高"),
            }.get(scope, True)]
        selected = [row for row in selected if matches_conditions(row, condition_filter)]
        bug_stages = {}
        if kind == "bugs":
            stages = {
                "all": lambda row: True,
                "pending": lambda row: row["status"] != "已修复待发布" and (row["pending"] or not row["status"]),
                "release": lambda row: row["status"] == "已修复待发布",
                "fixed": lambda row: row["status"] == "已修复",
            }
            bug_stages = {key: sum(matches(row) for row in selected) for key, matches in stages.items()}
            selected = [row for row in selected if stages[bug_stage](row)]
        requirements = [row for row in selected if row["kind"] == "requirements"]
        bugs = [row for row in selected if row["kind"] == "bugs"]
        counts = {
            "requirements": len(requirements), "bugs": len(bugs),
            "main": sum(not row["is_child"] for row in requirements), "children": sum(row["is_child"] for row in requirements),
            "pending_requirements": sum(row["pending"] for row in requirements), "pending_bugs": sum(row["pending"] for row in bugs),
            "urgent": sum(row["pending"] and row["priority"] in ("紧急", "高") for row in selected),
            "overdue": sum(row["overdue"] for row in selected),
            "missing_status": sum(not row["status"] for row in selected),
        }
        def groups(records, key):
            counter = Counter()
            for row in records:
                value = row.get(key)
                counter.update((value or ["未填写"]) if isinstance(value, list) else [value or "未填写"])
            return [{"name": name, "count": count} for name, count in counter.most_common()]
        option_rows = all_rows if kind == "overview" else snapshot[kind]
        options = {key: sorted({value for row in option_rows for value in (row.get(key) if isinstance(row.get(key), list) else [row.get(key)]) or [] if value}) for key in ("project", "version", "status", "priority", "environment")}
        people = {person["id"]: person.get("name") or person["id"] for row in option_rows for person in self._assignees(row)}
        options["person"] = [{"id": key, "name": value} for key, value in sorted(people.items(), key=lambda pair: pair[1])]
        selected.sort(key=lambda row: (row.get("created_at") or "", row["id"]), reverse=True)
        matched_total = len(selected)
        total_groups = None
        version_groups = []
        total_versions = 0
        page_size = PAGE_SIZE
        context = snapshot.get("requirement_context", [])
        if kind == "requirements":
            records = [dict(row, pending=self._pending(row), overdue=self._overdue(row, today)) for row in snapshot["requirements"] + context]
            requirement_tree = requirement_groups(records, {row["id"] for row in selected}, include_family)
            total_groups = len(requirement_tree)
            total = sum(len(group) for group in requirement_tree)
            record_index = {row["id"]: row for row in records}
            versions = {}
            for group in requirement_tree:
                parent, visited = group[0], set()
                # Hidden or out-of-range parents still determine the group's version.
                while parent["id"] not in visited:
                    visited.add(parent["id"])
                    ancestors = [record_index[item] for item in parent.get("parent_ids", []) if item in record_index and item not in visited]
                    if not ancestors:
                        break
                    parent = ancestors[0]
                values = parent.get("version") or []
                version_key = json.dumps(values, ensure_ascii=False)
                bucket = versions.setdefault(version_key, {"key": version_key, "name": "、".join(values) or "其他版本", "groups": []})
                bucket["groups"].append(group)
            ordered_versions = list(versions.values())
            if filters.get("version_desc") == "1":
                ordered_versions.sort(key=lambda bucket: (bucket["key"] == "[]", version_sort_key(bucket["name"])), reverse=True)
            total_versions = len(versions)
            page_size = VERSION_PAGE_SIZE
            page_count = max(1, (total_versions + page_size - 1) // page_size)
            page = min(page, page_count)
            page_rows = []
            for bucket in ordered_versions[(page - 1) * page_size:page * page_size]:
                rows = [dict(row, version_group=bucket["key"]) for group in bucket["groups"] for row in group]
                page_rows.extend(rows)
                version_groups.append({"key": bucket["key"], "name": bucket["name"], "total": len(rows), "total_groups": len(bucket["groups"]), "matched_total": sum(row["filter_match"] for row in rows)})
        else:
            total = len(selected)
            page_count = max(1, (total + PAGE_SIZE - 1) // PAGE_SIZE)
            page = min(page, page_count)
            page_rows = selected[(page - 1) * PAGE_SIZE:page * PAGE_SIZE]
        # Related links are resolved against the complete cache, not the current page.
        index = {row["id"]: row for row in all_rows + context}
        items = []
        for row in page_rows:
            related = [{"id": related_id, "title": index.get(related_id, {}).get("title") or related_id, "kind": index.get(related_id, {}).get("kind", "bugs" if row["kind"] == "requirements" else "requirements")} for related_id in row["related"]]
            item = {**row, "related": related, "test_deadline_tone": self._test_deadline_tone(row, today)}
            if row["kind"] == "bugs":
                item["discussion"] = self._discussion_chat(row)
                item["discussion_needs_link"] = False
                item["discussion_creation_pending"] = False
                if not item["discussion"]:
                    try:
                        state = self._read_discussion_state(self._discussion_state_path(row["id"]))
                    except SyncError:
                        state = {"pending": True}
                    if state.get("chat"):
                        item["discussion"] = self._discussion_chat({"discussion": [state["chat"]]})
                        item["discussion_needs_link"] = True
                    else:
                        item["discussion_creation_pending"] = bool(state.get("pending"))
                item["attachments"] = []
                for attachment in row.get("attachments") or []:
                    mime_type = self._attachment_type(attachment)
                    token = attachment.get("file_token")
                    if mime_type and token:
                        item["attachments"].append({
                            **attachment, "media_kind": mime_type.split("/", 1)[0],
                            "preview_url": f"/api/issues/bugs/{quote(row['id'], safe='')}/attachments/{quote(token, safe='')}",
                        })
            items.append(item)
        return {
            "sync": status, "options": options, "counts": counts, "items": items, "bug_stages": bug_stages,
            "total": total, "matched_total": matched_total, "total_groups": total_groups,
            "version_groups": version_groups, "total_versions": total_versions,
            "page": page, "page_size": page_size, "page_count": page_count,
            "charts": {"requirements": groups(requirements, "status"), "bugs": groups(bugs, "status"), "projects": groups([row for row in selected if row["pending"]], "project")},
            "sources": {key: SOURCE_URL + "?" + urlencode({"table": TABLES[key]["id"], "view": TABLES[key]["view"]}) for key in ("requirements", "bugs")},
        }
