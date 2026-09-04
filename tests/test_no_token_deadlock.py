"""BridgeFlowClient.renew_token must not deadlock on its own token lock.

Regression guard for the 2026-08-03 freeze: renew_token held `_token_lock`
and then called `ensure_token()`, which takes the SAME lock. asyncio.Lock is
not reentrant, so the first 403 of a run parked that worker forever — the
batch's gather() never returned, the task hung with no error in the log, and
only a manual pause got it back.

Run:  python tests/test_no_token_deadlock.py
"""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.services.flow_client_bridge import BridgeFlowClient


async def main() -> None:
    client = BridgeFlowClient(page=None, account_email="test@example.com")
    calls = []

    async def fake_get_token():
        calls.append(1)
        client._token = "ya29.fresh"

    client._do_get_token = fake_get_token

    # 1. A plain renewal completes. This is the call that used to hang.
    client._token = "ya29.stale"
    await asyncio.wait_for(client.renew_token("ya29.stale"), timeout=5)
    assert client._token == "ya29.fresh", client._token
    assert len(calls) == 1, calls

    # 2. Another task already renewed it → no second fetch.
    await asyncio.wait_for(client.renew_token("ya29.stale"), timeout=5)
    assert len(calls) == 1, calls

    # 3. The lock really is released, so renewing again still works.
    await asyncio.wait_for(client.renew_token("ya29.fresh"), timeout=5)
    assert len(calls) == 2, calls
    assert not client._get_token_lock().locked()

    print("OK: renew_token khong deadlock")


if __name__ == "__main__":
    asyncio.run(main())
