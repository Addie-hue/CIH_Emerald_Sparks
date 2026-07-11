"""
test_routing.py — Standalone smoke test for graph.py + routing.py
Run from the repo root:
    python -m backend.test_routing
OR with the venv active:
    python backend/test_routing.py

DELETE THIS FILE BEFORE FINAL SUBMISSION.

What it does
------------
1. Loads the real Mangaluru graph from data/maps/mangaluru_drive.graphml
2. Hard-codes two coordinate pairs within Mangaluru city.
3. Calls find_route() for both vehicle types.
4. Prints the results in a readable way.

No external dependencies beyond what requirements.txt already lists.
"""

import sys
import os

# Allow running as  `python backend/test_routing.py`  from the repo root
# by ensuring the repo root is on the Python path.
_repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _repo_root not in sys.path:
    sys.path.insert(0, _repo_root)

# ── 1. Load graph ──────────────────────────────────────────────────────────────
print("=" * 60)
print("CIH 2026 — routing smoke test")
print("=" * 60)

print("\n[1/3] Loading road graph …", flush=True)
from backend.graph import get_graph

G = get_graph()
print(
    f"      Graph loaded: {G.number_of_nodes()} nodes, "
    f"{G.number_of_edges()} edges."
)

# ── 2. Define test coordinates ─────────────────────────────────────────────────
# Both points are within the Mangaluru city area covered by the graph.
# Mangaluru city center (~Hampankatta)
ORIGIN      = [12.8698, 74.8421]   # [lat, lon]
# KMC Hospital area
DESTINATION = [12.8550, 74.8400]   # [lat, lon]

print(f"\n[2/3] Test coordinates:")
print(f"      Origin      : {ORIGIN}  (Mangaluru City Centre area)")
print(f"      Destination : {DESTINATION}  (KMC Hospital area)")

# ── 3. Route for both vehicle types ───────────────────────────────────────────
from backend.routing import find_route

print("\n[3/3] Computing routes …\n")

for vtype in ("ambulance", "4x4"):
    result = find_route(G, ORIGIN, DESTINATION, vtype)

    status      = result["status"]
    eta         = result["eta_seconds"]
    path_coords = result["path"]
    n_points    = len(path_coords)

    print(f"  vehicle_type = {vtype!r}")
    print(f"    status      : {status}")
    if status == "ok":
        print(f"    eta_seconds : {eta:.1f}  ({eta/60:.1f} min)")
        print(f"    path points : {n_points}")
        print(f"    first coord : {path_coords[0]}")
        print(f"    last coord  : {path_coords[-1]}")
        if n_points <= 6:
            for i, coord in enumerate(path_coords):
                print(f"      [{i}] {coord}")
        else:
            for coord in path_coords[:3]:
                print(f"      … {coord}")
            print(f"      … ({n_points - 6} more)")
            for coord in path_coords[-3:]:
                print(f"      … {coord}")
    else:
        print("    (no passable route found — check coordinates are within the graph)")
    print()

print("Smoke test complete.")
print("=" * 60)
