"""
routing.py — Shortest-path finder (Core Graph & Routing Engine)

Public API
----------
find_route(graph, origin, destination, vehicle_type) -> dict
    Returns a dict matching the contracts.md response shape for POST /route:
        {
            "path":        [[lat, lon], ...],
            "eta_seconds": float,
            "status":      "ok" | "no_route"
        }

Design notes
------------
* Origin/destination are [lat, lon] pairs.  We snap them to the nearest graph
  node with osmnx.nearest_nodes BEFORE pathfinding — the graph is projected
  (or unprojected) in whatever CRS osmnx produced, so we pass the raw lon/lat
  and let osmnx handle the geometry.

* Edge weight used is whichever of weight_ambulance / weight_4x4 is currently
  stored on the edge at call time.  flood.py mutates those in place; we never
  touch them ourselves.

* NetworkX Dijkstra is used because the graph can have negative-weight edges
  after flood.py sets multipliers < 1 on dry roads (not strictly the case here,
  but Dijkstra is safer than Bellman-Ford for density of this graph size, and
  A* requires a consistent heuristic tied to CRS which is more fragile).

* If any edge along the computed path has infinite cost (flood cut-off), the
  path is discarded and "no_route" is returned — that situation arises when
  Dijkstra picks a path that passes through a manually blocked edge before
  flood.py has had a chance to remove it from the graph.

* If NetworkX raises NetworkXNoPath or NodeNotFound, we return "no_route"
  cleanly — never raise to the caller.
"""

import logging
from typing import Any

import networkx as nx
import osmnx as ox

logger = logging.getLogger(__name__)

# ── Weight attribute selection ─────────────────────────────────────────────────

def _weight_attr(vehicle_type: str) -> str:
    """
    Return the edge-attribute name that holds the current travel cost for this
    vehicle type.  flood.py writes 'weight_ambulance' and 'weight_4x4'.
    """
    if vehicle_type == "ambulance":
        return "weight_ambulance"
    return "weight_4x4"


# ── Coordinate → node snapping ─────────────────────────────────────────────────

def _snap_to_node(graph: nx.MultiDiGraph, lat: float, lon: float) -> int:
    """
    Return the graph node id nearest to (lat, lon).

    osmnx.nearest_nodes expects (X=longitude, Y=latitude).
    """
    return ox.nearest_nodes(graph, X=lon, Y=lat)


# ── Path cost (ETA) computation ────────────────────────────────────────────────

def _path_eta(graph: nx.MultiDiGraph, node_path: list[int], weight_attr_name: str) -> float:
    """
    Sum the minimum edge weight across parallel edges for each hop.
    Returns total travel time in seconds.
    """
    total = 0.0
    for u, v in zip(node_path[:-1], node_path[1:]):
        edge_bundle = graph[u][v]          # {key: data_dict, ...} in MultiDiGraph
        # Pick the cheapest parallel edge
        min_cost = min(
            data.get(weight_attr_name, data.get("base_weight", 1.0))
            for data in edge_bundle.values()
        )
        total += min_cost
    return total


# ── Node coordinates ───────────────────────────────────────────────────────────

def _node_latlon(graph: nx.MultiDiGraph, node_id: int) -> tuple[float, float]:
    """Return (lat, lon) for a graph node."""
    data = graph.nodes[node_id]
    return float(data["y"]), float(data["x"])


# ── Public function ────────────────────────────────────────────────────────────

def find_route(
    graph: nx.MultiDiGraph,
    origin: list[float],
    destination: list[float],
    vehicle_type: str,
) -> dict[str, Any]:
    """
    Find the shortest path from origin to destination on *graph*.

    Parameters
    ----------
    graph        : NetworkX MultiDiGraph (from graph.get_graph())
    origin       : [lat, lon]
    destination  : [lat, lon]
    vehicle_type : "ambulance" | "4x4"

    Returns
    -------
    {
        "path":        [[lat, lon], ...],   # empty list when status == "no_route"
        "eta_seconds": float,               # 0.0 when status == "no_route"
        "status":      "ok" | "no_route"
    }
    """
    _NO_ROUTE = {"path": [], "eta_seconds": 0.0, "status": "no_route"}

    # ── 1. Validate inputs ─────────────────────────────────────────────────────
    if len(origin) != 2 or len(destination) != 2:
        logger.warning("find_route: origin/destination must be [lat, lon] pairs.")
        return _NO_ROUTE

    origin_lat,      origin_lon      = float(origin[0]),      float(origin[1])
    destination_lat, destination_lon = float(destination[0]), float(destination[1])

    weight_key = _weight_attr(vehicle_type)

    # ── 2. Snap coordinates to nearest graph nodes ─────────────────────────────
    try:
        origin_node = _snap_to_node(graph, origin_lat, origin_lon)
        dest_node   = _snap_to_node(graph, destination_lat, destination_lon)
    except Exception as exc:
        logger.error("find_route: node snapping failed — %s", exc)
        return _NO_ROUTE

    if origin_node == dest_node:
        # Already at destination — trivial route
        coord = _node_latlon(graph, origin_node)
        return {"path": [list(coord)], "eta_seconds": 0.0, "status": "ok"}

    # ── 3. Dijkstra shortest path ──────────────────────────────────────────────
    # We use a custom weight function so we can pick the minimum cost across
    # parallel edges (MultiDiGraph may have several edges between the same pair).
    def _edge_weight(u: int, v: int, data: dict) -> float:
        """
        Called by NetworkX for each edge.  For MultiDiGraph, data is the dict
        of the *best* (lowest-weight) parallel edge that NetworkX has already
        selected — but since NetworkX calls this per parallel edge, we just
        return the weight for this specific one and let NX minimise.
        """
        cost = data.get(weight_key, data.get("base_weight", 1.0))
        # Treat infinite-cost edges as absent
        if cost == float("inf") or cost != cost:  # nan check
            return float("inf")
        return cost

    try:
        node_path: list[int] = nx.dijkstra_path(
            graph, origin_node, dest_node, weight=_edge_weight
        )
    except nx.NetworkXNoPath:
        logger.info(
            "find_route: no path from node %s to node %s (vehicle=%s).",
            origin_node, dest_node, vehicle_type,
        )
        return _NO_ROUTE
    except nx.NodeNotFound as exc:
        logger.warning("find_route: node not found — %s", exc)
        return _NO_ROUTE
    except Exception as exc:
        logger.error("find_route: unexpected pathfinding error — %s", exc, exc_info=True)
        return _NO_ROUTE

    # ── 4. Sanity-check: no infinite-cost edge on the returned path ────────────
    # (can happen if graph topology changed between weight function calls)
    for u, v in zip(node_path[:-1], node_path[1:]):
        bundle = graph[u][v]
        min_cost = min(
            data.get(weight_key, data.get("base_weight", 1.0))
            for data in bundle.values()
        )
        if min_cost == float("inf"):
            logger.info(
                "find_route: path passes through a blocked edge (%s→%s); "
                "returning no_route.", u, v
            )
            return _NO_ROUTE

    # ── 5. Convert node IDs → [lat, lon] coordinates ──────────────────────────
    path_coords: list[list[float]] = [
        list(_node_latlon(graph, n)) for n in node_path
    ]

    # ── 6. Compute ETA ─────────────────────────────────────────────────────────
    eta = _path_eta(graph, node_path, weight_key)

    return {
        "path":        path_coords,
        "eta_seconds": round(eta, 2),
        "status":      "ok",
    }
