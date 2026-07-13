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
        if not self.clients:
            return
            
        async def send(c: WebSocket):
            try:
                # 2-second timeout to prevent hanging on dead or slow TCP connections
                await asyncio.wait_for(c.send_text(msg), timeout=2.0)
            except Exception:
                await self.disconnect(c)
                
        # Send to all clients concurrently to avoid blocking
        await asyncio.gather(*(send(c) for c in list(self.clients)), return_exceptions=True)


hub = WSHub()
