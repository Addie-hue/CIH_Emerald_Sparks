"""
app.py — FastAPI entrypoint (Core Graph & Routing Engine)

Endpoints owned here
--------------------
POST /route         — implemented (contracts.md shape)

Endpoints to be wired in by this file's owner when ready
---------------------------------------------------------
WebSocket /ws       — router imported from backend.realtime (teammate owns logic)
GET  /safe-zones    — teammate will ask; stub is clearly marked below
POST /assign-fleet  — teammate will ask; stub is clearly marked below

Rules
-----
* This file is the SOLE owner of the FastAPI app instance and all includes.
* Teammates must NOT edit this file directly — they ask the owner to wire in
  their router or endpoint.
* No database, no elevation, no external routing service.
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

_VEHICLE_TYPES = {"ambulance", "4x4"}


class RouteRequest(BaseModel):
    origin:       Annotated[list[float], Field(min_length=2, max_length=2)]
    destination:  Annotated[list[float], Field(min_length=2, max_length=2)]
    vehicle_type: str = Field(..., examples=["ambulance", "4x4"])

    @model_validator(mode="after")
    def _check_vehicle_type(self) -> "RouteRequest":
        if self.vehicle_type not in _VEHICLE_TYPES:
            raise ValueError(
                f"vehicle_type must be one of {sorted(_VEHICLE_TYPES)}, "
                f"got {self.vehicle_type!r}"
            )
        return self


class RouteResponse(BaseModel):
    path:        list[list[float]]
    eta_seconds: float
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
        status=result["status"],
    )


# ── ────────────────────────────────────────────────────────────────────────────
# TEAMMATE HOOK — GET /safe-zones
# When the safe-zones teammate is ready, they will ask the app.py owner to add:
#
#   from backend.<their_module> import safe_zones_router   (or the handler)
#   app.include_router(safe_zones_router)
#
# Do NOT edit this file directly — request the wiring from the app.py owner.
# ── ────────────────────────────────────────────────────────────────────────────

# ── ────────────────────────────────────────────────────────────────────────────
# TEAMMATE HOOK — POST /assign-fleet
# When the allocation teammate is ready, they will ask the app.py owner to add:
#
#   from backend.<their_module> import fleet_router
#   app.include_router(fleet_router)
#
# Do NOT edit this file directly — request the wiring from the app.py owner.
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
