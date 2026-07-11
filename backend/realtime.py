"""
realtime.py — WebSocket endpoint + hazard pipeline

Receives flood_update and landslide_update from the frontend,
applies zone mutations to the graph, triggers recheck_route(),
and broadcasts route_update back to all connected clients.

This is the critical pipe that was previously broken:
  OLD: looked for road_id (never sent by new frontend)
  NEW: reads zone: {center, radius_m} + severity, calls zone-based
       flood.py functions that do actual geometric edge matching.
"""

import asyncio
import logging
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from backend.resilience import ConnectionManager
from backend.graph import get_graph

# Hazard application functions (new zone-based API)
from backend.flood import apply_flood_zone, apply_landslide_zone

# Vehicle state / reroute trigger
from backend.vehicle_sim import recheck_route, get_state, advance_vehicle, start_trip, stop_trip

logger = logging.getLogger(__name__)

router  = APIRouter()
manager = ConnectionManager()

# ── Periodic vehicle advance task ─────────────────────────────────────────────
_advance_task: asyncio.Task | None = None

async def _vehicle_advance_loop():
    """Advance the vehicle every 0.5s and broadcast state if moving."""
    while True:
        await asyncio.sleep(0.5)
        state = advance_vehicle(0.5)
        if state["status"] in ("moving", "arrived"):
            payload = {
                "event":          "route_update",
                "path":           state["path"],
                "eta_seconds":    state["eta_seconds"],
                "distance_m":     state["distance_m"],
                "status":         state["status"],
                "reroute_reason": None,
                "hazard_type":    None,
            }
            await manager.broadcast_json(payload)


# ── Hazard processing helpers ─────────────────────────────────────────────────

async def _process_flood_update(data: dict):
    """Apply a flood zone and trigger reroute if needed."""
    zone      = data.get("zone", {})
    center    = zone.get("center")      # [lat, lon]
    radius_m  = zone.get("radius_m", 200)
    severity  = data.get("severity", "blocked")
    timestamp = data.get("timestamp", "")

    if not center or len(center) != 2:
        logger.warning("flood_update: missing or invalid zone.center — skipped")
        return

    logger.info("flood_update: center=%s r=%.0fm severity=%s ts=%s",
                center, radius_m, severity, timestamp)

    try:
        G = get_graph()
        matched = apply_flood_zone(G, center, radius_m, severity)
        logger.info("flood_update: %d edges mutated", matched)
    except Exception as exc:
        logger.error("apply_flood_zone failed: %s", exc, exc_info=True)
        return

    await _trigger_reroute("flood")


async def _process_landslide_update(data: dict):
    """Apply a landslide zone and trigger reroute if needed."""
    zone     = data.get("zone", {})
    center   = zone.get("center")
    radius_m = zone.get("radius_m", 150)

    if not center or len(center) != 2:
        logger.warning("landslide_update: missing zone.center — skipped")
        return

    logger.info("landslide_update: center=%s r=%.0fm", center, radius_m)

    try:
        G = get_graph()
        matched = apply_landslide_zone(G, center, radius_m)
        logger.info("landslide_update: %d edges mutated", matched)
    except Exception as exc:
        logger.error("apply_landslide_zone failed: %s", exc, exc_info=True)
        return

    await _trigger_reroute("landslide")


async def _trigger_reroute(hazard_type: str):
    """
    After a hazard is applied, check if the current vehicle path is affected.
    If so, compute a new route and broadcast it.
    """
    try:
        G = get_graph()
        update = recheck_route(G)
    except Exception as exc:
        logger.error("recheck_route failed: %s", exc, exc_info=True)
        return

    if update is None:
        logger.info("recheck_route: current path unaffected by hazard")
        return

    # Enrich with hazard_type
    update["hazard_type"] = hazard_type

    logger.info("Broadcasting reroute: status=%s reason=%s",
                update.get("status"), update.get("reroute_reason"))
    await manager.broadcast_json(update)


# ── client→server: start/stop trip commands ──────────────────────────────────

async def _process_start_trip(data: dict):
    """
    Expects: { event: "start_trip", path: [...], eta_seconds, distance_m,
               destination: [lat,lon] }
    """
    global _advance_task
    path        = data.get("path", [])
    eta_seconds = data.get("eta_seconds", 0.0)
    distance_m  = data.get("distance_m", 0.0)
    destination = data.get("destination")

    if not path or not destination:
        logger.warning("start_trip: missing path or destination")
        return

    G = get_graph()
    start_trip(G, path, eta_seconds, distance_m, destination)

    # Start advance loop if not already running
    if _advance_task is None or _advance_task.done():
        _advance_task = asyncio.create_task(_vehicle_advance_loop())

    logger.info("Trip started via WebSocket — %d waypoints", len(path))


async def _process_stop_trip(_data: dict):
    """Halt vehicle and optionally cancel advance loop."""
    stop_trip()
    logger.info("Trip stopped via WebSocket.")
    # Broadcast idle state
    state = get_state()
    await manager.broadcast_json({
        "event":          "route_update",
        "path":           [],
        "eta_seconds":    0.0,
        "distance_m":     0.0,
        "status":         "idle",
        "reroute_reason": None,
        "hazard_type":    None,
    })


# ── WebSocket endpoint ────────────────────────────────────────────────────────

@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            data = await websocket.receive_json()
            print(f"[TEMP DIAGNOSIS] WS received data: {data}")
            event = data.get("event")
            print(f"[TEMP DIAGNOSIS] WS parsed event: {event}")

            if event == "flood_update":
                # No debounce on zone-based updates (one click = one zone)
                await _process_flood_update(data)

            elif event == "landslide_update":
                await _process_landslide_update(data)

            elif event == "start_trip":
                await _process_start_trip(data)

            elif event == "stop_trip":
                await _process_stop_trip(data)

            else:
                logger.warning("Unknown WS event: %r", event)

    except WebSocketDisconnect:
        manager.disconnect(websocket)
        logger.info("Client disconnected cleanly.")
    except Exception as exc:
        logger.error("WebSocket error: %s", exc, exc_info=True)
        manager.disconnect(websocket)
