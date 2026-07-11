# Contracts — do not change without telling all 4 people

## POST /route
Request:  { origin: [lat,lon], destination: [lat,lon], vehicle_type: "ambulance"|"4x4" }
Response: { path: [[lat,lon], ...], eta_seconds: float, status: "ok"|"no_route" }

## GET /safe-zones
Response: [ { name: string, type: "hospital"|"relief_camp"|"high_ground", lat: float, lon: float } ]

## POST /assign-fleet
Request:  { incidents: [{id, lat, lon}], vehicles: [{id, lat, lon, status}] }
Response: [ { incident_id: string, vehicle_id: string } ]

## WebSocket — client sends to server
{ event: "flood_update", road_id: string, depth_cm: number, timestamp: string }

## WebSocket — server sends to client
{ event: "route_update", vehicle_id: string, path: [[lat,lon],...], eta_seconds: float, status: "ok"|"stranded" }

## Flood depth bands (fixed, do not change mid-build)
0-15cm   -> 1.0x-1.5x cost
15-30cm  -> 3x-6x cost
30-60cm  -> blocked for "ambulance", high-cost-passable for "4x4"
60cm+    -> infinite cost, blocked for ALL vehicle types

## Explicitly out of scope
- No elevation data, no elevation API, anywhere.
- No commercial map/routing API (no Google Maps, Mapbox, HERE).
- No database — the road graph and flood state live in RAM only.