/**
 * vehicle.js — Vehicle animation, ETA pill, click-to-set origin/destination,
 *              setup/trip mode switching, Start/Stop navigation.
 *
 * Depends on: map.js (window.mapInstance, window.drawRoute, window.showToast,
 *                      window.showBanner, window.sendWS)
 */

'use strict';

// ── Constants ──────────────────────────────────────────────────────────────────
const FIXED_RADIUS_M = 200;   // shared zone radius (flood + landslide)
const ARRIVAL_DIST_M = 40;    // treat as arrived within this distance (m)

// ── State ──────────────────────────────────────────────────────────────────────
let _origin      = null;   // [lat, lon]
let _destination = null;   // [lat, lon]
let _tripActive  = false;

let _path       = [];
let _segLens    = [];
let _totalDist  = 0;
let _traveled   = 0;
let _animFrame  = null;
let _lastTs     = null;

// Leaflet markers
let _vehicleMarker = null;
let _etaMarker     = null;
let _destMarker    = null;
let _originMarker  = null;

// Hazard zone indices on the current path (for red coloring)
// — updated by hazard_controls.js whenever a zone is placed
window._hazardSegments = new Set();

// ── Haversine ──────────────────────────────────────────────────────────────────
function haversine(a, b) {
    const R = 6371000, φ1 = a[0]*Math.PI/180, φ2 = b[0]*Math.PI/180;
    const dφ = (b[0]-a[0])*Math.PI/180, dλ = (b[1]-a[1])*Math.PI/180;
    return 2*R*Math.asin(Math.sqrt(Math.sin(dφ/2)**2+Math.cos(φ1)*Math.cos(φ2)*Math.sin(dλ/2)**2));
}

function bearing(a, b) {
    const φ1=a[0]*Math.PI/180, φ2=b[0]*Math.PI/180, dλ=(b[1]-a[1])*Math.PI/180;
    return ((Math.atan2(Math.sin(dλ)*Math.cos(φ2),
        Math.cos(φ1)*Math.sin(φ2)-Math.sin(φ1)*Math.cos(φ2)*Math.cos(dλ))*180/Math.PI)+360)%360;
}

function segSpeed(len) {
    if (len > 400) return 60/3.6;
    if (len > 200) return 50/3.6;
    if (len > 150) return 40/3.6;
    if (len > 60)  return 25/3.6;
    return 8/3.6;
}

// ── Click-to-set origin / destination ─────────────────────────────────────────
let _clickMode = 'origin';   // 'origin' | 'destination' | 'none'

document.addEventListener('DOMContentLoaded', () => {
    // Register map click handler AFTER map.js has created the map
    setTimeout(() => {
        if (window.mapInstance) {
            window.mapInstance.on('click', _onMapClick);
        }
    }, 300);
});

function _onMapClick(e) {
    // If a hazard tool is active, let hazard_controls.js handle it
    if (window._hazardToolActive) return;

    const latLon = [e.latlng.lat, e.latlng.lng];

    if (_clickMode === 'origin') {
        setOrigin(latLon);
    } else if (_clickMode === 'destination') {
        setDestination(latLon);
    }
}

window.setOrigin = function(latLon) {
    _origin    = latLon;
    _clickMode = 'destination';

    // Update label
    const el = document.getElementById('origin-label');
    if (el) el.textContent = latLon.map(v=>v.toFixed(5)).join(', ');

    // Update hint
    const hint = document.getElementById('setup-hint');
    if (hint) hint.innerHTML = 'Click the map to set <strong>destination</strong>';

    // Place origin marker
    if (_originMarker) window.mapInstance.removeLayer(_originMarker);
    _originMarker = L.circleMarker(latLon, {
        radius: 7, color: '#2563eb', fillColor: '#93c5fd',
        fillOpacity: 0.9, weight: 2,
    }).addTo(window.mapInstance);

    _updateStartButton();
};

window.setDestination = function(latLon) {
    _destination = latLon;
    _clickMode   = 'none';

    const el = document.getElementById('dest-label');
    if (el) el.textContent = latLon.map(v=>v.toFixed(5)).join(', ');

    const hint = document.getElementById('setup-hint');
    if (hint) hint.innerHTML = 'Press <strong>Start Navigation</strong> to begin.';

    // Destination pin marker (Google Maps style)
    if (_destMarker) window.mapInstance.removeLayer(_destMarker);
    const pinIcon = L.divIcon({
        className: '',
        html: `<div class="dest-pin"><div class="dest-pin-head"></div><div class="dest-pin-tail"></div></div>`,
        iconSize: [22, 30], iconAnchor: [11, 30],
    });
    _destMarker = L.marker(latLon, { icon: pinIcon }).addTo(window.mapInstance);

    _updateStartButton();
};

window.clearOrigin = function() {
    _origin    = null;
    _clickMode = 'origin';
    const el = document.getElementById('origin-label');
    if (el) el.textContent = 'Not set';
    if (_originMarker) { window.mapInstance.removeLayer(_originMarker); _originMarker = null; }
    document.getElementById('setup-hint').innerHTML = 'Click the map to set <strong>origin</strong>';
    _updateStartButton();
};

window.clearDestination = function() {
    _destination = null;
    _clickMode   = 'destination';
    const el = document.getElementById('dest-label');
    if (el) el.textContent = 'Not set';
    if (_destMarker) { window.mapInstance.removeLayer(_destMarker); _destMarker = null; }
    _updateStartButton();
};

function _updateStartButton() {
    const btn = document.getElementById('start-btn');
    if (btn) btn.disabled = !(_origin && _destination);
}

// ── Start / Stop navigation ────────────────────────────────────────────────────
window.startNavigation = async function() {
    if (!_origin || !_destination) return;
    const btn = document.getElementById('start-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Routing…'; }

    try {
        const res = await fetch(`${window.BACKEND_HTTP||'http://localhost:8000'}/route`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ origin: _origin, destination: _destination }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        if (data.status === 'no_route') {
            window.showToast('No passable route found', 'error');
            window.showBanner('⚠ No route available', 'stranded');
            return;
        }

        // Tell backend to start tracking
        fetch(`${window.BACKEND_HTTP||'http://localhost:8000'}/start-trip`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                path: data.path,
                eta_seconds: data.eta_seconds,
                distance_m: data.distance_m,
                destination: _destination,
            }),
        }).catch(() => {});

        // Also notify via WS (so the advance loop starts)
        window.sendWS?.({
            event: 'start_trip',
            path: data.path,
            eta_seconds: data.eta_seconds,
            distance_m: data.distance_m,
            destination: _destination,
        });

        window.showToast(`Route: ${(data.distance_m/1000).toFixed(1)} km`, 'success');
        _beginTrip(data.path, data.eta_seconds, data.distance_m);

    } catch(e) {
        console.error('[startNavigation]', e);
        window.showToast(`Error: ${e.message}`, 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> Start Navigation`;
        }
    }
};

window.stopNavigation = function() {
    _tripActive = false;
    if (_animFrame) { cancelAnimationFrame(_animFrame); _animFrame = null; }

    // Tell backend
    window.sendWS?.({ event: 'stop_trip' });
    fetch(`${window.BACKEND_HTTP||'http://localhost:8000'}/stop-trip`, { method: 'POST' }).catch(()=>{});

    // Clear route lines
    window.drawRoute([], 0, new Set());

    // Remove vehicle + ETA markers
    if (_vehicleMarker) { window.mapInstance.removeLayer(_vehicleMarker); _vehicleMarker = null; }
    if (_etaMarker)     { window.mapInstance.removeLayer(_etaMarker);     _etaMarker = null; }

    // Return to setup mode
    _switchToSetup();
    window.showToast('Navigation ended', 'info');
};

// ── Trip animation ─────────────────────────────────────────────────────────────
function _beginTrip(path, eta_seconds, distance_m) {
    _path      = path;
    _segLens   = [];
    for (let i = 0; i < path.length - 1; i++) _segLens.push(haversine(path[i], path[i+1]));
    _totalDist = _segLens.reduce((a,b)=>a+b, 0);
    _traveled  = 0;
    _lastTs    = null;
    _tripActive= true;

    _switchToTrip(eta_seconds, distance_m);
    window.drawRoute(path, 0, window._hazardSegments);

    if (_animFrame) cancelAnimationFrame(_animFrame);
    _animFrame = requestAnimationFrame(_tick);
}

// Called by map.js when a route_update WebSocket message arrives
window.onRouteUpdate = function(data) {
    const { path, eta_seconds, distance_m, status, reroute_reason, hazard_type } = data;

    if (status === 'arrived') {
        _tripActive = false;
        if (_animFrame) { cancelAnimationFrame(_animFrame); _animFrame = null; }
        window.showBanner('🏁 Arrived at destination!', 'arrived');
        window.showToast('Destination reached', 'success');
        setTimeout(_switchToSetup, 3000);
        return;
    }

    if (status === 'idle') {
        return;  // stop_trip ack, ignore
    }

    if (status === 'stranded') {
        _tripActive = false;
        if (_animFrame) { cancelAnimationFrame(_animFrame); _animFrame = null; }
        window.showBanner('⚠ No route — vehicle stranded', 'stranded');
        window.showToast('Vehicle stranded — no passable route', 'error');
        return;
    }

    // ok or reroute
    if (path && path.length >= 2) {
        if (reroute_reason) {
            const pre = hazard_type === 'landslide' ? '⛰' : '💧';
            window.showBanner(`${pre} Rerouting due to ${hazard_type || 'hazard'}…`, 'recalc');
            setTimeout(() => window.showBanner('✓ New route computed', 'ok'), 1500);
        }
        _beginTrip(path, eta_seconds, distance_m);
    }
};

function _tick(ts) {
    if (!_tripActive || _path.length < 2) return;
    if (_lastTs === null) _lastTs = ts;
    const dt = Math.min((ts - _lastTs) / 1000, 0.3);
    _lastTs = ts;

    // Position at current distance
    const { pos, segIdx } = _posAt(_traveled);
    const speed = segSpeed(_segLens[segIdx] || 50);
    _traveled = Math.min(_traveled + speed * dt, _totalDist);

    const { pos: newPos, segIdx: newSeg } = _posAt(_traveled);

    // Vehicle bearing
    const br = newSeg < _path.length - 1 ? bearing(_path[newSeg], _path[newSeg+1]) : 0;

    // Update markers
    _placeVehicle(newPos, br, _remainingEta());

    // Split traveled / remaining
    let traveledNodes = 0, acc = 0;
    for (let i = 0; i < _segLens.length; i++) {
        if (acc + _segLens[i] <= _traveled) { traveledNodes = i + 1; acc += _segLens[i]; }
        else break;
    }
    window.drawRoute(_path, traveledNodes, window._hazardSegments);

    // Update stats panel
    const rem = _totalDist - _traveled;
    const eta = rem / speed;
    _updateStats(speed * 3.6, rem, eta);

    // Arrival check
    const dest = _destination;
    if (dest && haversine(newPos, dest) <= ARRIVAL_DIST_M) {
        _tripActive = false;
        window.showBanner('🏁 Arrived!', 'arrived');
        window.showToast('Destination reached', 'success');
        setTimeout(_switchToSetup, 3000);
        return;
    }

    _animFrame = requestAnimationFrame(_tick);
}

function _posAt(dist) {
    let acc = 0;
    for (let i = 0; i < _segLens.length; i++) {
        if (acc + _segLens[i] >= dist || i === _segLens.length - 1) {
            const t = _segLens[i] > 0 ? Math.min((dist - acc) / _segLens[i], 1) : 0;
            const a = _path[i], b = _path[i+1];
            return { pos: [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t], segIdx: i };
        }
        acc += _segLens[i];
    }
    return { pos: _path[_path.length-1], segIdx: _segLens.length-1 };
}

function _remainingEta() {
    const rem = _totalDist - _traveled;
    const pos = _posAt(_traveled);
    const spd = segSpeed(_segLens[pos.segIdx] || 50);
    return rem / spd;
}

// ── Markers ────────────────────────────────────────────────────────────────────
function _placeVehicle(latLon, bearingDeg, etaSec) {
    const map = window.mapInstance;
    if (!map) return;

    const vIcon = L.divIcon({
        className: '',
        iconSize: [30, 30], iconAnchor: [15, 15],
        html: `<div class="vehicle-wrap" style="transform:rotate(${Math.round(bearingDeg)}deg)">🚗</div>`,
    });

    if (!_vehicleMarker) {
        _vehicleMarker = L.marker(latLon, { icon: vIcon, zIndexOffset: 900 }).addTo(map);
    } else {
        _vehicleMarker.setLatLng(latLon);
        _vehicleMarker.setIcon(vIcon);
    }

    // ETA pill (offset 22px above vehicle)
    const etaMin  = Math.ceil(etaSec / 60);
    const etaIcon = L.divIcon({
        className: '',
        iconSize: [60, 22], iconAnchor: [30, 38],
        html: `<div class="eta-pill">${etaMin} min</div>`,
    });

    if (!_etaMarker) {
        _etaMarker = L.marker(latLon, { icon: etaIcon, zIndexOffset: 901, interactive: false }).addTo(map);
    } else {
        _etaMarker.setLatLng(latLon);
        _etaMarker.setIcon(etaIcon);
    }
}

// ── Stat panel ─────────────────────────────────────────────────────────────────
function _updateStats(kmh, remainM, etaSec) {
    const ss = document.getElementById('stat-speed');
    const sd = document.getElementById('stat-dist');
    const se = document.getElementById('stat-eta');
    if (ss) ss.textContent = Math.round(kmh);
    if (sd) sd.textContent = (remainM / 1000).toFixed(2);
    if (se) se.textContent = Math.ceil(etaSec / 60);
}

// ── Mode switching ─────────────────────────────────────────────────────────────
function _switchToTrip(eta_s, dist_m) {
    document.getElementById('setup-section')?.classList.add('hidden');
    document.getElementById('trip-section')?.classList.remove('hidden');
    _updateStats(0, dist_m, eta_s);
}

function _switchToSetup() {
    _tripActive = false;
    document.getElementById('setup-section')?.classList.remove('hidden');
    document.getElementById('trip-section')?.classList.add('hidden');

    // Reset click mode for new trip
    _origin      = null;
    _destination = null;
    _clickMode   = 'origin';
    _path        = [];

    // Reset labels
    const ol = document.getElementById('origin-label');
    const dl = document.getElementById('dest-label');
    if (ol) ol.textContent = 'Not set';
    if (dl) dl.textContent = 'Not set';

    // Reset hint
    const h = document.getElementById('setup-hint');
    if (h) h.innerHTML = 'Click the map to set <strong>origin</strong>';

    // Remove markers
    if (_vehicleMarker) { window.mapInstance.removeLayer(_vehicleMarker); _vehicleMarker = null; }
    if (_etaMarker)     { window.mapInstance.removeLayer(_etaMarker);     _etaMarker = null; }
    if (_destMarker)    { window.mapInstance.removeLayer(_destMarker);    _destMarker = null; }
    if (_originMarker)  { window.mapInstance.removeLayer(_originMarker);  _originMarker = null; }

    window.drawRoute([], 0, new Set());
    _updateStartButton();
}

// ── Expose for hazard_controls.js ──────────────────────────────────────────────
window.getCurrentPath = () => _path;
window.FIXED_RADIUS_M = FIXED_RADIUS_M;
window.BACKEND_HTTP   = 'http://localhost:8000';
