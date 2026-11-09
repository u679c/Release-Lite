"""Durable delayed bug fixes, shared by application processes through a file lock."""

import fcntl
import json
import logging
import threading
import time
import uuid
from contextlib import contextmanager

from .storage import write_json


logger = logging.getLogger(__name__)
ACTIVE_STATES = {"pending", "running"}


class ScheduledBugFixes:
    def __init__(self, service):
        self.service = service
        self.directory = service.cache_dir
        self.path = self.directory / "scheduled-bug-fixes.json"
        self.thread = None

    def start(self):
        self.thread = threading.Thread(
            target=self._run, name="scheduled-bug-fixes", daemon=True
        )
        self.thread.start()

    @contextmanager
    def locked(self):
        from .service import IssueBusyError

        self.directory.mkdir(parents=True, exist_ok=True)
        with (self.directory / "scheduled-bug-fixes.lock").open("a+") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise IssueBusyError("状态或定时任务正在更新，请稍后重试") from exc
            try:
                yield
            finally:
                fcntl.flock(lock, fcntl.LOCK_UN)

    def _read(self):
        try:
            tasks = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {}
        if not isinstance(tasks, dict):
            raise ValueError("定时修复数据读取失败")
        return tasks

    def state(self):
        return {"tasks": self._read(), "server_time": time.time()}

    def schedule(self, record_id, minutes, expected_status):
        from .service import IssueBusyError, TERMINAL, validate_record_id

        validate_record_id(record_id, "Bug ")
        if type(minutes) is not int or not 1 <= minutes <= 10080:
            raise ValueError("请输入 1～10080 的整数分钟数")
        if not isinstance(expected_status, str) or not expected_status:
            raise ValueError("Bug 状态缺失，请刷新后重试")
        with self.locked():
            with self.service.lock:
                if self.service.syncing or self.service.submitting:
                    raise IssueBusyError("数据处理中，请稍后重试")
                row = next(
                    (row for row in (self.service.snapshot or {}).get("bugs", [])
                     if row["id"] == record_id), None
                )
                if row is None:
                    raise ValueError("Bug 不存在，请同步后重试")
                if row["status"] != expected_status:
                    raise IssueBusyError("Bug 状态已变化，请刷新后重试")
                if row["status"] in TERMINAL["bugs"]:
                    raise ValueError("这条 Bug 已结束，无需定时修复")
            tasks = self._read()
            tasks[record_id] = {
                "id": uuid.uuid4().hex,
                "record_id": record_id,
                "expected_status": expected_status,
                "minutes": minutes,
                "due_at": time.time() + minutes * 60,
                "state": "pending",
            }
            write_json(self.path, tasks)
            return {"tasks": tasks, "server_time": time.time()}

    def cancel(self, record_id):
        from .service import validate_record_id

        validate_record_id(record_id, "Bug ")
        with self.locked():
            self.cancel_records([record_id])
            return self.state()

    def cancel_records(self, record_ids):
        """Called while holding the schedule lock, including after manual updates."""
        tasks = self._read()
        changed = False
        for record_id in record_ids:
            task = tasks.get(record_id)
            if task and task["state"] != "cancelled":
                task.update(state="cancelled", finished_at=time.time())
                changed = True
        if changed:
            write_json(self.path, tasks)

    def _execute_due(self):
        from .service import IssueBusyError, SyncError

        now = time.time()
        if not any(
            task["state"] in ACTIVE_STATES
            and max(task["due_at"], task.get("retry_at", 0)) <= now
            for task in self._read().values()
        ):
            return
        with self.locked():
            tasks = self._read()
            for record_id, task in tasks.items():
                if (task["state"] not in ACTIVE_STATES
                        or max(task["due_at"], task.get("retry_at", 0)) > time.time()):
                    continue
                task["state"] = "running"
                write_json(self.path, tasks)
                try:
                    result = self.service._update_bug_statuses(
                        [{"id": record_id, "expected_status": task["expected_status"]}],
                        "已修复",
                    )
                except IssueBusyError as exc:
                    # Only local contention is retried; a changed source status is final.
                    if str(exc) == "数据处理中，请稍后重试":
                        task.update(state="pending", retry_at=time.time() + 5)
                    else:
                        task.update(state="failed", error=str(exc), finished_at=time.time())
                except (ValueError, SyncError, OSError) as exc:
                    task.update(state="failed", error=str(exc), finished_at=time.time())
                else:
                    task.update(
                        state="completed", warning=result.get("warning", ""),
                        finished_at=time.time(),
                    )
                write_json(self.path, tasks)

    def _run(self):
        from .service import IssueBusyError

        while True:
            try:
                self._execute_due()
            except IssueBusyError:
                pass  # Another process owns the task or a manual status change.
            except Exception:
                logger.exception("Unable to process scheduled bug fixes")
            time.sleep(1)
