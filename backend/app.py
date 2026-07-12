"""
app.py — FastAPI entrypoint (Core Graph & Routing Engine)

Endpoints owned here
--------------------
POST /route         — implemented (contracts.md shape, including distance_m)

Endpoints wired in on teammate request
---------------------------------------
WebSocket /ws       — router from backend.realtime (teammate C owns logic)

Rules
-----
* This file is the SOLE owner of the FastAPI app instance and all includes.
* Teammates must NOT edit this file directly — they ask the owner to wire in
  their router or endpoint.
* No database, no elevation, no external routing service.
* No fleet, no dispatch, no allocation — single vehicle only.
"""

import sys
import os

# ── Path bootstrap (must be first) ────────────────────────────────────────────
# Guarantee the repo root (parent of backend/) is on sys.path so that
#   from backend.graph import ...
# resolves correctly whether uvicorn is launched as:
#   (repo root)  uvicorn backend.app:app
#   (backend/)   uvicorn app:app
_backend_dir = os.path.dirname(os.path.abspath(__file__))   # .../CIH 2026/backend
_repo_root   = os.path.dirname(_backend_dir)                 # .../CIH 2026
if _repo_root not in sys.path:
    sys.path.insert(0, _repo_root)

import logging
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, model_validator

# ── Internal imports ───────────────────────────────────────────────────────────

from backend.graph import get_graph
from backend.routing import find_route

# Optional teammate routers — imported defensively so the server can start
# even when a teammate's module is still empty / not yet written.
try:
    from backend.realtime import router as realtime_router
    _HAS_REALTIME = True
except ImportError:
    realtime_router = None
    _HAS_REALTIME = False

# ── Logging ────────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s — %(message)s",
)
logger = logging.getLogger(__name__)

# ── Lifespan: validate graph loaded before accepting requests ──────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Run once at startup to confirm the graph is in memory."""
    try:
        G = get_graph()
        logger.info(
            "Road graph ready — %d nodes, %d edges.",
            G.number_of_nodes(), G.number_of_edges(),
        )
    except RuntimeError as exc:
        logger.error("STARTUP FAILED: %s", exc)
        # Server will start but /route will return 503 — better than crashing
    yield
    logger.info("Server shutting down.")


# ── App creation ───────────────────────────────────────────────────────────────

app = FastAPI(
    title="CIH 2026 — Flood Emergency Routing API",
    description=(
        "Real-time flood-aware vehicle routing for disaster response. "
        "Graph lives in RAM; weights are mutated in place by flood updates."
    ),
    version="0.1.0",
    lifespan=lifespan,
)

# CORS — allow the frontend dev server and any deployed origin.
# Tighten origins for production if needed.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Teammate routers ───────────────────────────────────────────────────────────

if _HAS_REALTIME and realtime_router is not None:
    app.include_router(realtime_router)
    logger.info("WebSocket /ws router mounted from backend.realtime.")

# ── /route — Pydantic models (contracts.md) ────────────────────────────────────

class RouteRequest(BaseModel):
    origin:      list[float] = Field(..., min_length=2, max_length=2)
    destination: list[float] = Field(..., min_length=2, max_length=2)
    vehicle_type: str = "ambulance"


class RouteResponse(BaseModel):
    path:        list[list[float]]
    eta_seconds: float
    distance_m:  float
    status:      str  # "ok" | "no_route"


# ── POST /route ────────────────────────────────────────────────────────────────

@app.post("/route", response_model=RouteResponse, summary="Find shortest flood-aware route")
async def route_endpoint(req: RouteRequest) -> RouteResponse:
    """
    Compute the shortest vehicle-aware route between two lat/lon points.

    - Snaps coordinates to the nearest graph node.
    - Uses current edge weights (which reflect any live flood mutations).
    - Returns **status="no_route"** if no passable path exists.
    """
    try:
        G = get_graph()
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    result = find_route(G, req.origin, req.destination, req.vehicle_type)

    return RouteResponse(
        path=result["path"],
        eta_seconds=result["eta_seconds"],
        distance_m=result.get("distance_m", 0.0),
        status=result["status"],
    )


# ── POST /start-trip ───────────────────────────────────────────────────────────
# Called by the frontend after a successful /route call to begin tracking.

class StartTripRequest(BaseModel):
    path:        list[list[float]]
    eta_seconds: float
    distance_m:  float
    destination: list[float] = Field(..., min_length=2, max_length=2)

class ValidateHazardRequest(BaseModel):
    lat: float
    lon: float
    hazard_type: str = "flood"
    radius: float = 50.0

class ValidateHazardResponse(BaseModel):
    valid: bool
    message: str | None = None

@app.post("/validate_hazard", response_model=ValidateHazardResponse, summary="Check if hazard coords are within simulation area")
async def validate_hazard_endpoint(req: ValidateHazardRequest):
    try:
        G = get_graph()
        import math
        
        def haversine(lat1, lon1, lat2, lon2):
            R = 6371000
            phi1, phi2 = math.radians(lat1), math.radians(lat2)
            dphi = math.radians(lat2 - lat1)
            dlam = math.radians(lon2 - lon1)
            a = math.sin(dphi/2)**2 + math.cos(phi1)*math.cos(phi2)*math.sin(dlam/2)**2
            return 2 * R * math.atan2(math.sqrt(a), math.sqrt(1-a))
            
        min_dist = float('inf')
        for n, ndata in G.nodes(data=True):
            n_lat, n_lon = ndata.get('y'), ndata.get('x')
            if n_lat is not None and n_lon is not None:
                dist = haversine(req.lat, req.lon, n_lat, n_lon)
                if dist < min_dist:
                    min_dist = dist
                    
        # Add 20m buffer to the hazard radius for "reasonable snap distance"
        max_dist = req.radius + 20.0
        
        if min_dist > max_dist:
            msg = f"Cannot place a hazard here — no road at this location"
            if req.hazard_type == "landslide":
                msg = "Invalid location for a landslide zone"
            return {"valid": False, "message": msg}
            
        return {"valid": True}
    except Exception as exc:
        logger.error(f"Validation error: {exc}")
        return {"valid": False, "message": "Failed to validate location"}

@app.post("/start-trip", summary="Begin vehicle trip tracking")
async def start_trip_endpoint(req: StartTripRequest):
    from backend.vehicle_sim import start_trip as _start
    try:
        G = get_graph()
        _start(G, req.path, req.eta_seconds, req.distance_m, req.destination)
        return {"status": "ok"}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


# ── POST /stop-trip ────────────────────────────────────────────────────────────

@app.post("/stop-trip", summary="Halt vehicle trip")
async def stop_trip_endpoint():
    from backend.vehicle_sim import stop_trip as _stop
    _stop()
    return {"status": "ok"}


# ── ────────────────────────────────────────────────────────────────────────────
# TEAMMATE HOOK — WebSocket /ws  (Person C: backend.realtime)
# The realtime router is already imported defensively at the top of this file.
# It mounts automatically when backend.realtime exports an APIRouter named
# `router`.  No further edit to this file is required unless the import path
# changes — in that case, ask the app.py owner.
# ── ────────────────────────────────────────────────────────────────────────────


# ── Dev entry-point ────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "backend.app:app",
        host="0.0.0.0",
        port=int(os.getenv("PORT", "8000")),
        reload=False,  # reload=True would re-import graph.py and double-load the file
        log_level="info",
    )
