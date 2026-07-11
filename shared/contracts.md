## POST /route
Request:  { origin: [lat,lon], destination: [lat,lon] }
Response: { path: [[lat,lon],...], eta_seconds: float, distance_m: float, status: "ok"|"no_route" }

## WebSocket — client to server
{ event: "flood_update", zone: {center: [lat,lon], radius_m: number},
  severity: "mild"|"caution"|"severe"|"blocked", timestamp: string }

{ event: "landslide_update", zone: {center: [lat,lon], radius_m: number},
  timestamp: string }

## WebSocket — server to client
{ event: "route_update", path: [[lat,lon],...], eta_seconds: float,
  distance_m: float, status: "ok"|"stranded"|"arrived",
  reroute_reason: string|null, hazard_type: "flood"|"landslide"|null }

## Fixed severity -> depth mapping (flood only, backend-internal)
mild -> 10cm (1.0x-1.5x cost)
caution -> 25cm (3x-6x cost)
severe -> 45cm (blocked for the fixed vehicle profile — see below)
blocked -> 80cm (infinite cost)

## Landslide (fixed, no severity levels)
Always applies the same cost as "blocked" flood severity — infinite cost.

## Vehicle profile
ONE fixed profile only (no user-facing vehicle type selector).
Use the ambulance-tier thresholds already defined:
  0-15cm -> 1.0x-1.5x | 15-30cm -> 3x-6x | 30cm+ -> blocked
This is now the only profile in the system — flood.py no longer branches
on vehicle_type anywhere.

## Out of scope (unchanged)
No elevation. No fleet/allocation. No database. No commercial map API.
No vehicle type selection.