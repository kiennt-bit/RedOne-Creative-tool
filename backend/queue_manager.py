"""Sequential task queue — runs ONE generation task at a time.

Workflow:
  - Routers (content/image/long_video) call `queue.enqueue(kind, task_id, runner)`
    instead of `asyncio.create_task` directly.
  - A single background worker picks the next QUEUED item and awaits its runner.
  - When the runner finishes (success / error / cancel), the worker moves on.
  - Cancellation: removes from queue if not yet started; if currently running,
    cancels the underlying asyncio.Task.

This guarantees the user's "1 task at a time, in arrival order" requirement.
"""
from __future__ import annotations
import asyncio
import logging
import time
from dataclasses import dataclass, field, asdict
from typing import Awaitable, Callable, Optional

from .database import db
from .ws_hub import hub
from .config import TaskStatus

log = logging.getLogger("navtools.queue")

Runner = Callable[[int], Awaitable[None]]


@dataclass
class QueuedItem:
    task_id: int
    kind: str           # "content" | "image" | "long_video"
    enqueued_at: float = field(default_factory=time.time)


class TaskQueue:
    def __init__(self):
        self._items: list[QueuedItem] = []
        self._runners: dict[int, Runner] = {}      # task_id → runner coro
        self._current: Optional[QueuedItem] = None
        self._current_async_task: Optional[asyncio.Task] = None
        self._cancel_set: set[int] = set()         # tasks marked to skip / cancel
        self._signal = asyncio.Event()
        self._worker: Optional[asyncio.Task] = None

    # ── lifecycle ─────────────────────────────────────────
    def start(self):
        if self._worker is None or self._worker.done():
            self._worker = asyncio.create_task(self._loop())
            log.info("Queue worker started")

    def stop(self):
        if self._worker and not self._worker.done():
            self._worker.cancel()
            log.info("Queue worker stopped")

    # ── public api ────────────────────────────────────────
    async def enqueue(self, kind: str, task_id: int, runner: Runner) -> int:
        """Add a task to the queue. Returns the queue position (0 = next to run)."""
        self._items.append(QueuedItem(task_id=task_id, kind=kind))
        self._runners[task_id] = runner
        self._signal.set()
        log.info(f"Enqueued task={task_id} kind={kind} (queue len={len(self._items)})")
        await hub.broadcast("queue_updated", self.snapshot())
        return len(self._items) - 1

    async def cancel(self, task_id: int) -> bool:
        """Cancel a queued or running task.

        Returns True if the task was found and cancellation was triggered.
        """
        # Case 1: in queue, not yet started → just drop it
        before = len(self._items)
        self._items = [x for x in self._items if x.task_id != task_id]
        self._runners.pop(task_id, None)
        if len(self._items) < before:
            self._cancel_set.add(task_id)
            try:
                db.update_task(task_id, status=TaskStatus.CANCELLED.value)
            except Exception:
                pass
            log.info(f"Cancelled queued task={task_id} (not started yet)")
            await hub.broadcast("task_cancelled", {"task_id": task_id})
            await hub.broadcast("queue_updated", self.snapshot())
            return True

        # Case 2: currently running → cancel the asyncio.Task
        if (
            self._current and self._current.task_id == task_id
            and self._current_async_task and not self._current_async_task.done()
        ):
            self._cancel_set.add(task_id)
            self._current_async_task.cancel()
            log.info(f"Cancelling running task={task_id}")
            return True

        return False

    def position_of(self, task_id: int) -> int:
        """Return 0 if running, 1+ if queued, -1 if not found."""
        if self._current and self._current.task_id == task_id:
            return 0
        for idx, item in enumerate(self._items):
            if item.task_id == task_id:
                return idx + 1
        return -1

    def is_cancelled(self, task_id: int) -> bool:
        return task_id in self._cancel_set

    def snapshot(self) -> dict:
        return {
            "current": asdict(self._current) if self._current else None,
            "queued": [asdict(x) for x in self._items],
        }

    # ── worker loop ──────────────────────────────────────
    async def _loop(self):
        log.info("Queue loop started")
        while True:
            try:
                if not self._items:
                    self._signal.clear()
                    await self._signal.wait()
                    continue

                item = self._items.pop(0)
                runner = self._runners.pop(item.task_id, None)

                # Skip if was cancelled before reaching the front
                if item.task_id in self._cancel_set:
                    self._cancel_set.discard(item.task_id)
                    await hub.broadcast("queue_updated", self.snapshot())
                    continue

                if runner is None:
                    log.warning(f"No runner for task={item.task_id} — skipping")
                    continue

                self._current = item
                await hub.broadcast("queue_updated", self.snapshot())

                # Run the task. Wrap so we can intercept CancelledError.
                self._current_async_task = asyncio.create_task(runner(item.task_id))
                try:
                    await self._current_async_task
                except asyncio.CancelledError:
                    log.info(f"Task {item.task_id} was cancelled mid-run")
                    try:
                        db.update_task(item.task_id, status=TaskStatus.CANCELLED.value)
                    except Exception:
                        pass
                    await hub.broadcast("task_cancelled", {"task_id": item.task_id})
                except Exception as e:
                    log.exception(f"Queue runner crashed for task {item.task_id}: {e}")
                finally:
                    self._cancel_set.discard(item.task_id)
                    self._current = None
                    self._current_async_task = None
                    await hub.broadcast("queue_updated", self.snapshot())

            except asyncio.CancelledError:
                log.info("Queue loop cancelled")
                break
            except Exception as e:
                log.exception(f"Queue loop unexpected error: {e}")
                await asyncio.sleep(1)


queue = TaskQueue()
