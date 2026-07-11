import asyncio
from typing import Dict, Any, Callable
from fastapi import WebSocket, WebSocketDisconnect
import time
import logging

logger = logging.getLogger(__name__)

class ConnectionManager:
    def __init__(self):
        # Store active connections
        self.active_connections: list[WebSocket] = []
        # State for debouncing: track last update time per road_id
        self._last_update_times: Dict[str, float] = {}
        # Track pending task for debounce
        self._pending_updates: Dict[str, asyncio.Task] = {}

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)
        logger.info("Client connected. Active connections: %d", len(self.active_connections))

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
            logger.info("Client disconnected. Active connections: %d", len(self.active_connections))

    async def broadcast_json(self, message: dict):
        # We need to broadcast safely in case a connection dropped in between
        disconnected = []
        for connection in self.active_connections:
            try:
                await connection.send_json(message)
            except Exception as e:
                logger.warning(f"Failed to send to client, removing connection: {e}")
                disconnected.append(connection)
        
        for conn in disconnected:
            self.disconnect(conn)

    def debounce_flood_update(self, road_id: str, payload: dict, debounce_ms: int, callback: Callable):
        """
        Debounce rapid flood updates. Will wait `debounce_ms` before calling `callback`.
        If a new update comes in for the same road_id before the timer fires, the timer is reset.
        """
        if road_id in self._pending_updates:
            # Cancel the pending task
            self._pending_updates[road_id].cancel()

        async def _wait_and_call():
            try:
                await asyncio.sleep(debounce_ms / 1000.0)
                await callback(payload)
            except asyncio.CancelledError:
                pass
            finally:
                if road_id in self._pending_updates:
                    del self._pending_updates[road_id]

        # Schedule new task
        self._pending_updates[road_id] = asyncio.create_task(_wait_and_call())

def safe_route_response(fallback_vehicle_id: str) -> dict:
    """
    Returns a safe 'stranded' response when 'no_route' or an exception occurs.
    Prevents server crashes.
    """
    return {
        "event": "route_update",
        "vehicle_id": fallback_vehicle_id,
        "path": [],
        "eta_seconds": 0.0,
        "status": "stranded"
    }
