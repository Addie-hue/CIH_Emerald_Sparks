"""
flood.py — Hazard zone application (flood + landslide)

Single fixed vehicle profile (ambulance thresholds):
  0-15 cm  ->  1.0x–1.5x cost
  15-30 cm ->  3x–6x cost
  30+ cm   ->  blocked (infinite)

Severity → depth mapping (contracts.md):
  mild    ->  10 cm
  caution ->  25 cm
  severe  ->  45 cm
  blocked ->  80 cm

Public API
----------
apply_flood_zone(graph, center, radius_m, severity)
apply_landslide_zone(graph, center, radius_m)
get_active_zones()        -> list of zone dicts (read-only copy)
reset_edge_weights(graph) -> restore all edges to base_weight (for testing)
"""

import math
import logging
from typing import Literal

logger = logging.getLogger(__name__)

# ── Severity → depth mapping ───────────────────────────────────────────────────
SEVERITY_TO_DEPTH: dict[str, float] = {
    "mild":    10.0,
    "caution": 25.0,
    "severe":  45.0,
    "blocked": 80.0,
}

# Landslide is always treated as max blocked depth
LANDSLIDE_DEPTH = 80.0

# ── Fixed vehicle profile (ambulance tier) ─────────────────────────────────────
def depth_to_multiplier(depth_cm: float) -> float:
    """
    Single fixed profile — no vehicle_type branching.
      0-15 cm  ->  1.0x–1.5x (linear interpolation)
      15-30 cm ->  3x–6x (linear interpolation)
      30+ cm   ->  blocked (infinite)
    """
    if depth_cm < 0:
        depth_cm = 0.0
    if depth_cm <= 15:
        return 1.0 + (depth_cm / 15.0) * 0.5
    elif depth_cm <= 30:
        return 3.0 + ((depth_cm - 15.0) / 15.0) * 3.0
    else:
        return float("inf")


# ── Active zone registry ───────────────────────────────────────────────────────
# List of dicts: {type, center, radius_m, depth_cm, severity?}
_active_zones: list[dict] = []


def get_active_zones() -> list[dict]:
    """Return a snapshot of currently registered hazard zones."""
    return list(_active_zones)


# ── Geometry helpers ───────────────────────────────────────────────────────────
def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Haversine distance in metres between two lat/lon points."""
    R = 6_371_000.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def _edge_within_radius(data: dict, center_lat: float, center_lon: float, radius_m: float) -> bool:
    """
    Return True if any part of the edge passes within radius_m of center.

    Strategy: check the edge's midpoint and both endpoints (node coordinates
    are stored on the edge as 'geometry' if available, otherwise fallback to
    the graph nodes).  Using the midpoint covers the majority of real cases
    cheaply; we also check a point 25% and 75% along if geometry is present.
    """
    # Fast path: check midpoint stored on edge (osmnx stores it as 'geometry')
    geom = data.get("geometry")
    if geom is not None:
        try:
            coords = list(geom.coords)  # [(lon, lat), ...]
            # Sample up to 5 evenly-spaced points along the edge geometry
            n = len(coords)
            step = max(1, n // 4)
            sample = [coords[i] for i in range(0, n, step)] + [coords[-1]]
            for lon, lat in sample:
                if _haversine_m(lat, lon, center_lat, center_lon) <= radius_m:
                    return True
            return False
        except Exception:
            pass  # fall through to midpoint check

    # Fallback: use stored midpoint lat/lon if available
    mid_lat = data.get("y")
    mid_lon = data.get("x")
    if mid_lat is not None and mid_lon is not None:
        return _haversine_m(float(mid_lat), float(mid_lon), center_lat, center_lon) <= radius_m

    return False


def _apply_multiplier_to_graph(
    graph,
    center: list[float],
    radius_m: float,
    multiplier: float,
) -> int:
    """
    Walk every edge; set weight = base_weight * multiplier for edges whose
    geometry passes within radius_m of center.  Returns count of matched edges.
    """
    center_lat, center_lon = float(center[0]), float(center[1])
    matched = 0
    matched_edges = []
    print(f"[TEMP DIAGNOSIS] _apply_multiplier_to_graph center=({center_lat}, {center_lon}) radius_m={radius_m} multiplier={multiplier}")

    for u, v, k, data in graph.edges(keys=True, data=True):
        # Build a quick check using node coordinates stored on the edge,
        # or fall back to the edge-midpoint geometry approach.
        hit = False

        # Primary: use stored geometry for accurate segment sampling
        if _edge_within_radius(data, center_lat, center_lon, radius_m):
            hit = True
        else:
            # Secondary: check the actual node lat/lon from the graph
            try:
                u_data = graph.nodes[u]
                v_data = graph.nodes[v]
                for nd in (u_data, v_data):
                    if _haversine_m(
                        float(nd["y"]), float(nd["x"]), center_lat, center_lon
                    ) <= radius_m:
                        hit = True
                        break
                if not hit:
                    # Also check midpoint of the two nodes
                    mid_lat = (float(u_data["y"]) + float(v_data["y"])) / 2
                    mid_lon = (float(u_data["x"]) + float(v_data["x"])) / 2
                    if _haversine_m(mid_lat, mid_lon, center_lat, center_lon) <= radius_m:
                        hit = True
            except (KeyError, TypeError):
                pass

        if hit:
            if "base_weight" not in data:
                data["base_weight"] = data.get("travel_time", data.get("length", 1.0))
            if multiplier == float("inf"):
                data["weight"] = float("inf")
            else:
                data["weight"] = data["base_weight"] * multiplier
            matched += 1
            matched_edges.append((u, v, k))

    print(f"[TEMP DIAGNOSIS] Matched edges: {matched_edges}")
    logger.info(
        "Hazard zone at (%.5f, %.5f) r=%.0fm mult=%.1f — %d edges affected",
        center_lat, center_lon, radius_m, multiplier, matched
    )
    return matched


# ── Public zone-application functions ─────────────────────────────────────────

def apply_flood_zone(
    graph,
    center: list[float],
    radius_m: float,
    severity: str,
) -> int:
    """
    Apply a flood zone defined by a center point, radius, and severity label.

    severity must be one of: "mild", "caution", "severe", "blocked"

    Returns the number of graph edges that were affected.
    """
    if severity not in SEVERITY_TO_DEPTH:
        logger.warning("apply_flood_zone: unknown severity %r — defaulting to 'blocked'", severity)
        severity = "blocked"

    depth_cm   = SEVERITY_TO_DEPTH[severity]
    multiplier = depth_to_multiplier(depth_cm)

    # Register zone
    _active_zones.append({
        "type":     "flood",
        "center":   center,
        "radius_m": radius_m,
        "depth_cm": depth_cm,
        "severity": severity,
    })

    return _apply_multiplier_to_graph(graph, center, radius_m, multiplier)


def apply_landslide_zone(
    graph,
    center: list[float],
    radius_m: float,
) -> int:
    """
    Apply a landslide zone — always infinite cost (blocked for all vehicles).

    Returns the number of graph edges that were affected.
    """
    _active_zones.append({
        "type":     "landslide",
        "center":   center,
        "radius_m": radius_m,
        "depth_cm": LANDSLIDE_DEPTH,
    })

    return _apply_multiplier_to_graph(graph, center, radius_m, float("inf"))


def reset_edge_weights(graph) -> None:
    """Restore every edge's weight to its base_weight (for testing / cleanup)."""
    for u, v, k, data in graph.edges(keys=True, data=True):
        if "base_weight" in data:
            data["weight"] = data["base_weight"]
    _active_zones.clear()
    logger.info("All edge weights reset to base_weight.")
