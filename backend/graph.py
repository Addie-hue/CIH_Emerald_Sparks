"""
graph.py — Road graph loader (Core Graph & Routing Engine)

Loads a pre-saved road graph ONCE at startup and holds it in RAM.
Edge weights are computed from road type / length so that downstream
flood mutations (flood.py) only need to multiply the stored base_weight.

Public API
----------
get_graph() -> networkx.MultiDiGraph
    Returns the single shared graph instance.  Every other backend
    module must import this function — never re-load the file.

Edge weight attributes written here
------------------------------------
base_weight        : float  — length_m / typical_speed_m_s  (seconds)
weight_ambulance   : float  — starts equal to base_weight; mutated by flood.py
weight_4x4         : float  — starts equal to base_weight; mutated by flood.py
"""

import os
import glob
import logging
import pickle
from pathlib import Path

import networkx as nx
import osmnx as ox

logger = logging.getLogger(__name__)

# ── Typical road speeds (m/s) per OSM highway tag ─────────────────────────────
# Source: commonly accepted OSM-to-speed mappings used in routing.
_SPEED_MS: dict[str, float] = {
    "motorway":       33.3,   # ~120 km/h
    "motorway_link":  22.2,   # ~80 km/h
    "trunk":          25.0,   # ~90 km/h
    "trunk_link":     16.7,   # ~60 km/h
    "primary":        13.9,   # ~50 km/h
    "primary_link":   11.1,   # ~40 km/h
    "secondary":      11.1,   # ~40 km/h
    "secondary_link":  8.3,   # ~30 km/h
    "tertiary":        8.3,   # ~30 km/h
    "tertiary_link":   6.9,   # ~25 km/h
    "residential":     5.6,   # ~20 km/h
    "living_street":   2.8,   # ~10 km/h
    "service":         4.2,   # ~15 km/h
    "unclassified":    6.9,   # ~25 km/h
    "road":            6.9,   # ~25 km/h
    "track":           2.8,   # ~10 km/h
    "path":            1.4,   # ~5 km/h
    "footway":         1.4,
    "cycleway":        2.8,
}
_DEFAULT_SPEED_MS = 6.9  # fallback ~25 km/h


def _speed_for_edge(data: dict) -> float:
    """Return the typical speed in m/s for an edge based on its highway tag."""
    highway = data.get("highway", "")
    # OSMnx may store highway as a list when multiple tags are merged
    if isinstance(highway, list):
        highway = highway[0] if highway else ""
    return _SPEED_MS.get(highway, _DEFAULT_SPEED_MS)


def _compute_base_weight(data: dict) -> float:
    """
    base_weight = length_meters / speed_m_s   →   travel time in seconds.

    Falls back to `travel_time` if present, then to `length`, then 1.0.
    """
    length = data.get("length")
    if length is not None and float(length) > 0:
        speed = _speed_for_edge(data)
        return float(length) / speed

    # Secondary fallbacks
    tt = data.get("travel_time")
    if tt is not None and float(tt) > 0:
        return float(tt)

    return 1.0


# ── Graph state ────────────────────────────────────────────────────────────────

_graph: nx.MultiDiGraph | None = None  # singleton, populated at import time


def _annotate_graph(G: nx.MultiDiGraph) -> nx.MultiDiGraph:
    """
    Walk every edge and write base_weight, weight_ambulance, weight_4x4.
    This is idempotent — calling it twice is safe.
    """
    for _u, _v, _k, data in G.edges(keys=True, data=True):
        bw = _compute_base_weight(data)
        data["base_weight"]      = bw
        data["weight_ambulance"] = bw   # flood.py will raise these when flooded
        data["weight_4x4"]       = bw
    logger.debug("Graph annotation complete — %d edges processed.", G.number_of_edges())
    return G


def _find_graph_file(maps_dir: str) -> str | None:
    """
    Look for a GraphML or pickle file under maps_dir.
    Preference order: .graphml → .pkl → .pickle
    """
    for pattern in ("*.graphml", "*.pkl", "*.pickle"):
        matches = sorted(glob.glob(os.path.join(maps_dir, pattern)))
        if matches:
            return matches[0]
    return None


def _load_graph_file(path: str) -> nx.MultiDiGraph:
    """Load a GraphML or pickle file and return a MultiDiGraph."""
    ext = Path(path).suffix.lower()
    logger.info("Loading road graph from: %s", path)

    if ext == ".graphml":
        G = ox.load_graphml(path)
    elif ext in (".pkl", ".pickle"):
        with open(path, "rb") as fh:
            G = pickle.load(fh)
        if not isinstance(G, nx.MultiDiGraph):
            raise TypeError(
                f"Pickle file does not contain a MultiDiGraph (got {type(G).__name__})"
            )
    else:
        raise ValueError(f"Unsupported graph file extension: {ext!r}")

    logger.info(
        "Graph loaded — %d nodes, %d edges.", G.number_of_nodes(), G.number_of_edges()
    )
    return G


def _initialise() -> nx.MultiDiGraph:
    """
    Locate the graph file, load it, annotate edges, return the instance.
    Called ONCE when this module is first imported.
    """
    # Resolve data/maps/ relative to this file's location
    backend_dir = Path(__file__).parent
    maps_dir    = backend_dir.parent / "data" / "maps"

    graph_path = _find_graph_file(str(maps_dir))
    if graph_path is None:
        raise FileNotFoundError(
            f"No graph file (.graphml / .pkl / .pickle) found in {maps_dir}. "
            "Run data/fetch_map.py to generate one before starting the server."
        )

    G = _load_graph_file(graph_path)
    G = _annotate_graph(G)
    return G


# Load the graph at module import time so any module that does
#   from backend.graph import get_graph
# gets the same object without triggering a second load.
try:
    _graph = _initialise()
except FileNotFoundError as _e:
    logger.error(
        "Road graph not found — routing will be unavailable until the file exists. "
        "Detail: %s", _e
    )
    _graph = None


# ── Public API ─────────────────────────────────────────────────────────────────

def get_graph() -> nx.MultiDiGraph:
    """
    Return the in-memory road graph.

    Raises
    ------
    RuntimeError
        If the graph file was not present when the server started.
    """
    if _graph is None:
        raise RuntimeError(
            "Road graph is not loaded.  "
            "Ensure data/maps/ contains a .graphml or .pkl file and restart."
        )
    return _graph
