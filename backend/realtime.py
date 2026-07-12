from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from typing import Dict, Any
import logging

from backend.resilience import ConnectionManager, safe_route_response

# These imports are expected to be provided by teammates
try:
    from backend.flood import update_flood
except ImportError:
    # Fallback/stub for testing if teammate's code is empty or missing
    def update_flood(road_id: str, depth_cm: float, timestamp: str):
        pass

try:
    from backend.active_routes import recheck_all_active_routes
except ImportError:
    # Fallback/stub for testing
    def recheck_all_active_routes() -> list[dict]:
        return []

logger = logging.getLogger(__name__)

router = APIRouter()
manager = ConnectionManager()

async def process_flood_update(payload: dict):
    """
    Called after debouncing a flood_update event.
    """
    road_id = payload.get("road_id")
    depth_cm = payload.get("depth_cm", 0.0)
    timestamp = payload.get("timestamp", "")
    
    logger.info(f"Processing flood update for {road_id}: {depth_cm}cm")
    
    # 1. Update the internal flood state (Person B's code)
    try:
        err_msg = update_flood(road_id, depth_cm, timestamp)
        if err_msg:
            # Broadcast the error back to the client that sent the malicious/invalid request
            await manager.broadcast_json({"event": "hazard_error", "message": err_msg, "road_id": road_id})
            return
    except Exception as e:
        logger.error(f"Error in update_flood: {e}")
        return

    # 2. Recheck all active routes (Person B's code)
    try:
        updated_routes = recheck_all_active_routes()
    except Exception as e:
        logger.error(f"Error in recheck_all_active_routes: {e}")
        return
        
    # 3. Push route_update events back to all connected clients
    if updated_routes:
        for route_data in updated_routes:
            try:
                # Ensure it matches the contracts.md shape
                response = {
                    "event": "route_update",
                    "vehicle_id": route_data.get("vehicle_id", "unknown"),
                    "path": route_data.get("path", []),
                    "eta_seconds": route_data.get("eta_seconds", 0.0),
                    "status": route_data.get("status", "ok")
                }
                await manager.broadcast_json(response)
            except Exception as e:
                logger.error(f"Failed to broadcast route_update: {e}")

@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            data = await websocket.receive_json()
            
            event_type = data.get("event")
            if event_type == "flood_update":
                road_id = data.get("road_id")
                if not road_id:
                    continue
                
                # Debounce rapid flood updates (e.g. 300ms)
                manager.debounce_flood_update(
                    road_id=road_id,
                    payload=data,
                    debounce_ms=300,
                    callback=process_flood_update
                )
            elif event_type == "update_location":
                try:
                    from backend.active_routes import update_vehicle_state
                    update_vehicle_state(
                        vehicle_id=data.get("vehicle_id"),
                        position=data.get("position"),
                        path=data.get("path"),
                        destination=data.get("destination"),
                        vehicle_type="ambulance"
                    )
                except ImportError:
                    pass
            else:
                logger.warning(f"Unknown event type received: {event_type}")
                
    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
        manager.disconnect(websocket)
