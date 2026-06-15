"""WebSocket broadcast hub."""
from __future__ import annotations
import asyncio
import json
from typing import Any
from fastapi import WebSocket


class WSHub:
    def __init__(self):
        self.clients: set[WebSocket] = set()
        self._lock = asyncio.Lock()

    async def connect(self, ws: WebSocket):
        await ws.accept()
        async with self._lock:
            self.clients.add(ws)

    async def disconnect(self, ws: WebSocket):
        async with self._lock:
            self.clients.discard(ws)

    async def broadcast(self, event: str, payload: Any = None):
        msg = json.dumps({"event": event, "data": payload}, default=str)
        dead = []
        for c in list(self.clients):
            try:
                await c.send_text(msg)
            except Exception:
                dead.append(c)
        for c in dead:
            await self.disconnect(c)


hub = WSHub()
