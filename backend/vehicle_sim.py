"""
vehicle_sim.py — Single vehicle live state & reroute trigger

Public API
----------
start_trip(graph, path, eta_seconds, distance_m, destination)
    Call after a successful POST /route to begin tracking.

advance_vehicle(delta_seconds) -> dict
    Move the vehicle forward; call from a periodic background task or
    inline in the WebSocket loop.  Returns current vehicle state dict.

recheck_route(graph) -> dict | None
    Call immediately after any hazard update.  If the current path is
    now blocked or degraded, rereroutes from the vehicle's CURRENT
    interpolated position.  Returns a route_update payload dict if a
    reroute happened, or None if no change was needed.

get_state() -> dict
    Current vehicle state (position, speed, etc.) — read-only snapshot.

ARRIVAL_THRESHOLD_M : float
    Distance from destination at which we declare "arrived".
"""

import math
import logging
from typing import Optional

logger = logging.getLogger(__name__)

# ── Constants ──────────────────────────────────────────────────────────────────
ARRIVAL_THRESHOLD_M = 30.0   # declare "arrived" within 30 m of destination

# Speed look-up by segment length (mirrors vehicle.js heuristic)
def _speed_ms(seg_len_m: float) -> float:
    """Estimated speed in m/s based on segment length proxy for road type."""
    if seg_len_m > 400: return 16.7   # ~60 km/h
    if seg_len_m > 200: return 13.9   # ~50 km/h
    if seg_len_m > 150: return 11.1   # ~40 km/h
    if seg_len_m > 60:  return 6.9    # ~25 km/h
    return 2.2                         # ~8 km/h


# ── Haversine ──────────────────────────────────────────────────────────────────
def _haversine(a: list, b: list) -> float:
    """Haversine distance in metres between [lat,lon] pairs."""
    R = 6_371_000.0
    lat1, lon1 = math.radians(a[0]), math.radians(a[1])
    lat2, lon2 = math.radians(b[0]), math.radians(b[1])
    dlat, dlon = lat2 - lat1, lon2 - lon1
    x = math.sin(dlat/2)**2 + math.cos(lat1)*math.cos(lat2)*math.sin(dlon/2)**2
    return 2 * R * math.asin(math.sqrt(x))


def _bearing(a: list, b: list) -> float:
    """Bearing from a to b in degrees (0=N, clockwise)."""
    lat1, lon1 = math.radians(a[0]), math.radians(a[1])
    lat2, lon2 = math.radians(b[0]), math.radians(b[1])
    dlon = lon2 - lon1
    y = math.sin(dlon) * math.cos(lat2)
    x = math.cos(lat1)*math.sin(lat2) - math.sin(lat1)*math.cos(lat2)*math.cos(dlon)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


# ── Vehicle state ──────────────────────────────────────────────────────────────
_state: dict = {
    "status":      "idle",        # idle | moving | stranded | arrived
    "position":    None,          # [lat, lon] interpolated
    "heading":     0.0,           # degrees
    "speed_ms":    0.0,
    "path":        [],            # full remaining path from current position
    "seg_lens":    [],            # pre-computed segment lengths (m)
    "traveled_m":  0.0,           # meters traveled along current path
    "total_m":     0.0,
    "eta_seconds": 0.0,
    "distance_m":  0.0,
    "destination": None,          # [lat, lon] original destination
}


def _precompute_segs(path: list) -> tuple[list, float]:
    """Return (seg_lens, total_m) for a path."""
    segs = [_haversine(path[i], path[i+1]) for i in range(len(path)-1)]
    return segs, sum(segs)


def _pos_at(path: list, seg_lens: list, dist: float) -> tuple[list, int]:
    """
    Interpolate position at `dist` meters along `path`.
    Returns ([lat,lon], seg_idx).
    """
    acc = 0.0
    for i, slen in enumerate(seg_lens):
        if acc + slen >= dist or i == len(seg_lens) - 1:
            t = min((dist - acc) / slen, 1.0) if slen > 0 else 0.0
            a, b = path[i], path[i+1]
            return [a[0] + (b[0]-a[0])*t, a[1] + (b[1]-a[1])*t], i
        acc += slen
    return list(path[-1]), len(seg_lens) - 1


# ── Public API ─────────────────────────────────────────────────────────────────

def start_trip(
    graph,
    path: list,
    eta_seconds: float,
    distance_m: float,
    destination: list,
) -> None:
    """Initialise vehicle state for a new trip."""
    global _state
    if len(path) < 2:
        logger.warning("start_trip: path too short")
        return
    segs, total = _precompute_segs(path)
    _state = {
        "status":      "moving",
        "position":    list(path[0]),
        "heading":     _bearing(path[0], path[1]),
        "speed_ms":    _speed_ms(segs[0]),
        "path":        path,
        "seg_lens":    segs,
        "traveled_m":  0.0,
        "total_m":     total,
        "eta_seconds": eta_seconds,
        "distance_m":  distance_m,
        "destination": list(destination),
    }
    logger.info("Trip started — %d waypoints, %.0f m", len(path), total)


def get_state() -> dict:
    """Return a snapshot of the current vehicle state."""
    return dict(_state)


def advance_vehicle(delta_seconds: float) -> dict:
    """
    Move the vehicle forward by delta_seconds of travel time.
    Updates _state in place and returns the new state snapshot.
    """
    if _state["status"] == "arrived":
        return get_state()
        
    if _state["status"] != "moving":
        return get_state()

    path    = _state["path"]
    seg_lens= _state["seg_lens"]
    if len(path) < 2:
        return get_state()

    # Current segment speed
    pos, seg_idx = _pos_at(path, seg_lens, _state["traveled_m"])
    speed = _speed_ms(seg_lens[seg_idx] if seg_idx < len(seg_lens) else 30)
    advance = speed * delta_seconds

    new_traveled = min(_state["traveled_m"] + advance, _state["total_m"])
    new_pos, new_seg = _pos_at(path, seg_lens, new_traveled)

    # Update heading
    if new_seg < len(path) - 1:
        heading = _bearing(path[new_seg], path[new_seg+1])
    else:
        heading = _state["heading"]

    # Remaining distance & ETA
    remaining_m = max(_state["total_m"] - new_traveled, 0.0)
    new_speed   = _speed_ms(seg_lens[new_seg] if new_seg < len(seg_lens) else 30)
    eta_s       = remaining_m / new_speed if new_speed > 0 else 0.0

    _state.update({
        "traveled_m":  new_traveled,
        "position":    new_pos,
        "heading":     heading,
        "speed_ms":    new_speed,
        "distance_m":  remaining_m,
        "eta_seconds": eta_s,
    })

    # Check arrival
    dest = _state.get("destination")
    if dest and _haversine(new_pos, dest) <= ARRIVAL_THRESHOLD_M:
        _state["status"] = "arrived"
        logger.info("Vehicle arrived at destination.")

    return get_state()


def recheck_route(graph) -> Optional[dict]:
    """
    Call after any hazard update. Unconditionally checks for a better path 
    (or updated ETA) from the vehicle's current interpolated position.
    """
    from backend.routing import find_route

    if _state["status"] not in ("moving",):
        return None

    cur_pos = _state["position"]
    dest    = _state["destination"]

    logger.info("recheck_route: checking new path from %s", cur_pos)
    result = find_route(graph, cur_pos, dest)

    if result["status"] == "no_route":
        _state["status"] = "stranded"
        return {
            "event":          "route_update",
            "path":           [],
            "eta_seconds":    0.0,
            "distance_m":     0.0,
            "status":         "stranded",
            "reroute_reason": "Path blocked by hazard",
            "hazard_type":    None,
        }

    new_path = result["path"]
    segs, tot = _precompute_segs(new_path)
    
    _state.update({
        "path":        new_path,
        "seg_lens":    segs,
        "traveled_m":  0.0,
        "total_m":     tot,
        "eta_seconds": result["eta_seconds"],
        "distance_m":  result["distance_m"],
    })

    return {
        "event":          "route_update",
        "path":           new_path,
        "eta_seconds":    result["eta_seconds"],
        "distance_m":     result["distance_m"],
        "status":         "ok",
        "reroute_reason": "Hazard triggered route check",
        "hazard_type":    None,
    }




def stop_trip() -> None:
    """Halt the vehicle and reset to idle."""
    global _state
    _state = {**_state, "status": "idle", "speed_ms": 0.0}
    logger.info("Trip stopped.")
