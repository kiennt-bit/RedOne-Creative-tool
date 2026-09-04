"""A wedged item must be cancelled AND flipped to ERROR, not left GENERATING.

Second half of the 2026-08-03 hang guard. `run_item_bounded` bounds each item
so one stuck coroutine can't freeze the whole batch. Cancelling is only half
the job: asyncio cancels via BaseException, so the generator's own
`except Exception` never runs — without an explicit write the item would sit
at GENERATING forever with a spinner, invisible to "Gen lại lỗi".

Run:  python tests/test_item_timeout.py
"""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.config import ItemStatus
from backend.routers import content as content_mod


async def main() -> None:
    writes, events = [], []
    content_mod.db.update_item = lambda item_id, **kw: writes.append((item_id, kw))

    async def fake_broadcast(event, payload):
        events.append((event, payload))

    content_mod.hub.broadcast = fake_broadcast
    item = {"id": 999, "task_id": 1}

    # 1. Healthy item passes its value straight through, no DB write.
    async def ok():
        return True

    assert await content_mod.run_item_bounded(item, ok(), timeout=5) is True
    assert writes == [], writes

    # 2. Wedged item: returns False instead of hanging the batch forever.
    async def wedged():
        await asyncio.Event().wait()

    result = await asyncio.wait_for(
        content_mod.run_item_bounded(item, wedged(), timeout=0.2), timeout=5
    )
    assert result is False, result

    # 3. ...and is marked ERROR so "Gen lại lỗi" can pick it up.
    assert len(writes) == 1, writes
    item_id, kw = writes[0]
    assert item_id == 999, item_id
    assert kw["status"] == ItemStatus.ERROR.value, kw
    assert kw["error_message"], kw
    assert events and events[0][0] == "item_error", events
    assert events[0][1]["task_id"] == 1, events

    # 4. Real failures still propagate — only timeouts are swallowed.
    async def boom():
        raise ValueError("gen failed")

    try:
        await content_mod.run_item_bounded(item, boom(), timeout=5)
        raise AssertionError("ValueError bi nuot mat")
    except ValueError:
        pass

    print("OK: item treo bi huy va danh dau ERROR")


if __name__ == "__main__":
    asyncio.run(main())
