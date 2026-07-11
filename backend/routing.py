"""
routing.py — Shortest-path finder (Core Graph & Routing Engine)

Public API
----------
find_route(graph, origin, destination) -> dict
    Returns a dict matching the contracts.md response shape for POST /route:
        {
            "path":        [[lat, lon], ...],
            "eta_seconds": float,
            "distance_m":  float,
            "status":      "ok" | "no_route"
        }

Design notes
------------
* vehicle_type has been removed — single fixed profile only (contracts.md).
* Edge weight used is 'weight' (set by flood.py on hazard zones, falls back
  to 'base_weight' for clean edges).
* Dijkstra on NetworkX; infinite-cost edges are treated as absent.
* origin/destination [lat, lon] snapped to nearest graph node via osmnx.
"""

import logging
from typing import Any

import networkx as nx
import osmnx as ox

logger = logging.getLogger(__name__)

# Single weight attribute name used by flood.py
_WEIGHT = "weight"


# ── Coordinate → node snapping ─────────────────────────────────────────────────

def _snap_to_node(graph: nx.MultiDiGraph, lat: float, lon: float) -> int:
    """Return the graph node id nearest to (lat, lon)."""
    return ox.nearest_nodes(graph, X=lon, Y=lat)


# ── Path helpers ───────────────────────────────────────────────────────────────

def _edge_cost(data: dict) -> float:
    """Return the current cost of one edge (parallel-edge dict entry)."""
    c = data.get(_WEIGHT, data.get("base_weight", 1.0))
    return float("inf") if (c != c or c == float("inf")) else float(c)  # NaN guard


def _path_eta(graph: nx.MultiDiGraph, node_path: list[int]) -> float:
    """Total travel time in seconds along node_path."""
    total = 0.0
    for u, v in zip(node_path[:-1], node_path[1:]):
        total += min(_edge_cost(d) for d in graph[u][v].values())
    return total


def _path_distance(graph: nx.MultiDiGraph, node_path: list[int]) -> float:
    """Total physical length in metres along node_path (ignores flood multipliers)."""
    total = 0.0
    for u, v in zip(node_path[:-1], node_path[1:]):
        total += min(float(d.get("length", 0.0)) for d in graph[u][v].values())
    return total


def _node_latlon(graph: nx.MultiDiGraph, node_id: int) -> tuple[float, float]:
    """Return (lat, lon) for a graph node."""
    d = graph.nodes[node_id]
    return float(d["y"]), float(d["x"])


# ── Public function ────────────────────────────────────────────────────────────

def find_route(
    graph: nx.MultiDiGraph,
    origin: list[float],
    destination: list[float],
    vehicle_type: str = "",   # kept for backward compat but ignored
) -> dict[str, Any]:
    """
    Find the shortest passable path from origin to destination.

    Parameters
    ----------
    graph       : NetworkX MultiDiGraph (from graph.get_graph())
    origin      : [lat, lon]
    destination : [lat, lon]
    vehicle_type: ignored — single fixed profile only

    Returns
    -------
    { "path", "eta_seconds", "distance_m", "status": "ok"|"no_route" }
    """
    _NO_ROUTE = {"path": [], "eta_seconds": 0.0, "distance_m": 0.0, "status": "no_route"}

    # ── 1. Validate inputs ─────────────────────────────────────────────────────
    if len(origin) != 2 or len(destination) != 2:
        logger.warning("find_route: origin/destination must be [lat, lon] pairs.")
        return _NO_ROUTE

    olat, olon = float(origin[0]), float(origin[1])
    dlat, dlon = float(destination[0]), float(destination[1])

    # ── 2. Snap to nearest graph nodes ─────────────────────────────────────────
    try:
        o_node = _snap_to_node(graph, olat, olon)
        d_node = _snap_to_node(graph, dlat, dlon)
    except Exception as exc:
        logger.error("find_route: node snapping failed — %s", exc)
        return _NO_ROUTE

    if o_node == d_node:
        coord = _node_latlon(graph, o_node)
        return {"path": [list(coord)], "eta_seconds": 0.0, "distance_m": 0.0, "status": "ok"}

    # ── 3. Dijkstra shortest path ──────────────────────────────────────────────
    def _ew(u: int, v: int, data: dict) -> float:
        return _edge_cost(data)

    try:
        node_path: list[int] = nx.dijkstra_path(graph, o_node, d_node, weight=_ew)
    except nx.NetworkXNoPath:
        logger.info("find_route: no path from %s to %s.", o_node, d_node)
        return _NO_ROUTE
    except nx.NodeNotFound as exc:
        logger.warning("find_route: node not found — %s", exc)
        return _NO_ROUTE
    except Exception as exc:
        logger.error("find_route: unexpected error — %s", exc, exc_info=True)
        return _NO_ROUTE

    # ── 4. Reject path if it contains a blocked edge ───────────────────────────
    for u, v in zip(node_path[:-1], node_path[1:]):
        if min(_edge_cost(d) for d in graph[u][v].values()) == float("inf"):
            logger.info("find_route: blocked edge on path (%s→%s) — no_route", u, v)
            return _NO_ROUTE

    # ── 5. Convert nodes → coords ──────────────────────────────────────────────
    path_coords = [list(_node_latlon(graph, n)) for n in node_path]

    # ── 6. Compute ETA + distance ──────────────────────────────────────────────
    eta      = _path_eta(graph, node_path)
    distance = _path_distance(graph, node_path)

    return {
        "path":        path_coords,
        "eta_seconds": round(eta, 2),
        "distance_m":  round(distance, 1),
        "status":      "ok",
    }
