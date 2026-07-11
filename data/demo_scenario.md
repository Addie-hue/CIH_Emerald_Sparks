# Emerald Sparks - Demo Scenario Script

This script outlines the step-by-step sequence for demonstrating the live real-time routing and resilience of the Emerald Sparks platform. It can be run fully automated or replayed manually if needed.

## Setup & Starting Positions

- **Target Town:** Mangaluru, Karnataka
- **Ambulance 1 (V1):** Near Wenlock District Hospital (Lat: 12.8680, Lon: 74.8430)
- **Incident 1 (I1):** Medical emergency near Kadri Park (Lat: 12.8820, Lon: 74.8520)

**Initial State:** Ambulance V1 is assigned to Incident I1. A baseline route is generated.

## Sequence of Events

### 1. The Baseline (T = 0s)
- **Action:** Show the initial route on the UI.
- **Talking Point:** "Here is our ambulance responding to a medical emergency. The system has calculated the fastest route using real-time baseline data without any floods."

### 2. Mild Flood Hits (T = 15s)
- **Action:** Send `flood_update` via WebSocket on a road segment along the active route.
  ```json
  { "event": "flood_update", "road_id": "<road_segment_id_1>", "depth_cm": 20, "timestamp": "<current_iso_time>" }
  ```
- **Expected Outcome:** The backend recalculates. Since 20cm is a 3x-6x cost penalty (but not blocked), the route might stay the same but the ETA increases, or it might slightly detour if a faster side street exists.
- **Talking Point:** "We just received a sensor update: 20cm of water on the main route. The ambulance can still pass, but the ETA has increased due to the slowdown."

### 3. Severe Flood / Full Blockage (T = 30s)
- **Action:** Send `flood_update` indicating a severe blockage on the next critical segment.
  ```json
  { "event": "flood_update", "road_id": "<road_segment_id_2>", "depth_cm": 65, "timestamp": "<current_iso_time>" }
  ```
- **Expected Outcome:** 65cm is infinite cost (blocked). The backend immediately recalculates and issues a `route_update` with a completely new path avoiding that segment.
- **Talking Point:** "The situation has escalated. The water depth has hit 65cm, making the road impassable. The system instantly reroutes the ambulance to a safe alternative path."

### 4. The "No Route" Case (T = 45s)
- **Action:** Send multiple `flood_update` events to surround the ambulance, blocking all outgoing segments.
  ```json
  { "event": "flood_update", "road_id": "<road_segment_id_3>", "depth_cm": 65, "timestamp": "<current_iso_time>" }
  { "event": "flood_update", "road_id": "<road_segment_id_4>", "depth_cm": 65, "timestamp": "<current_iso_time>" }
  ```
- **Expected Outcome:** The system attempts to route but fails. It gracefully handles the error and sends a `status: "stranded"` message via WebSocket. The UI reflects that the ambulance is currently stranded, without crashing the server.
- **Talking Point:** "In extreme cases where a vehicle becomes completely cut off, the system safely registers it as stranded rather than crashing, allowing dispatchers to coordinate rescue."

### 5. Connection Drop Recovery (T = 60s)
- **Action:** Forcefully disconnect the WebSocket from the client side, wait 3 seconds, and reconnect.
- **Expected Outcome:** The backend's `resilience.py` manager handles the drop without crashing, and upon reconnection, successfully sends the latest state.
- **Talking Point:** "If a field operator loses cell connection, our resilience layer ensures that once they reconnect, they pick up right where they left off without any server instability."
