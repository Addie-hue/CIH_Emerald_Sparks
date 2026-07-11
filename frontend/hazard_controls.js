/**
 * hazard_controls.js — Flood zone (4 severity chips) + Landslide zone
 *
 * Flood flow: click "Add Flood Zone" → click map → 4 severity chips appear
 *             in panel → tap chip → zone drawn + sendWS(flood_update)
 *
 * Landslide: click "Add Landslide" → click map → immediate zone + sendWS
 *
 * Both use window.FIXED_RADIUS_M (defined by vehicle.js).
 *
 * After any zone is placed, the current path's segments inside the zone
 * are marked red via window._hazardSegments (Set of segment indices).
 */

'use strict';

// ── State ──────────────────────────────────────────────────────────────────────
let _activeTool    = null;   // 'flood' | 'landslide' | null
let _pendingCenter = null;   // [lat, lon] after first map click
let _pendingMarker = null;
let _zoneCounter   = 0;
const _zones       = {};     // id → zone data

// Signal to vehicle.js that a hazard tool is active (suppresses nav clicks)
window._hazardToolActive = false;

// ── Init ───────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    // Map click listener registered here (after map.js has run)
    setTimeout(() => {
        if (window.mapInstance) {
            window.mapInstance.on('click', _onMapHazardClick);
        }
    }, 400);
});

function _onMapHazardClick(e) {
    if (!_activeTool) return;
    const latLon = [e.latlng.lat, e.latlng.lng];

    if (_activeTool === 'flood') {
        _pendingCenter = latLon;
        _placePendingMarker(latLon);
        _showSeverityPicker();
        // Don't register another click — wait for chip tap
        // Re-enable map default cursor
        _setCrosshair(false);
    } else if (_activeTool === 'landslide') {
        _activeTool = null;
        window._hazardToolActive = false;
        _setCrosshair(false);
        document.getElementById('slide-tool-btn')?.classList.remove('active');
        _confirmLandslide(latLon);
    }
}

// ── Flood tool ─────────────────────────────────────────────────────────────────
window.activateFloodTool = function() {
    if (_activeTool === 'flood') { cancelHazardTool(); return; }
    cancelHazardTool(false);
    _activeTool = 'flood';
    window._hazardToolActive = true;
    _setCrosshair(true);
    document.getElementById('flood-tool-btn')?.classList.add('active');
    window.showToast?.('Click map to place flood zone center', 'info');
};

function _showSeverityPicker() {
    document.getElementById('severity-picker')?.classList.remove('hidden');
}

window.confirmFloodZone = function(severity) {
    if (!_pendingCenter) return;

    const radius = window.FIXED_RADIUS_M || 200;
    const id     = `flood-${++_zoneCounter}`;
    const ts     = new Date().toISOString();

    window.removeHazardZone?.('__preview__');
    window.drawHazardZone?.('flood', _pendingCenter, radius, id, severity);

    _zones[id] = { type: 'flood', center: _pendingCenter, radius_m: radius, severity };
    _renderZoneList();

    // Mark hazard segments on current path
    _markPathSegments(_pendingCenter, radius);

    // Send per contracts.md
    const floodPayload = {
        event:    'flood_update',
        zone:     { center: _pendingCenter, radius_m: radius },
        severity,
        timestamp: ts,
    };
    console.log('[TEMP DIAGNOSIS] Sending flood_update payload:', JSON.stringify(floodPayload));
    window.sendWS?.(floodPayload);

    const labels = { mild:'Mild (1–1.5×)', caution:'Caution (3–6×)', severe:'Severe (blocked)', blocked:'Blocked (impassable)' };
    window.showToast?.(`Flood zone: ${labels[severity]||severity}`, 'warn');

    _resetTool();
};

// ── Landslide tool ─────────────────────────────────────────────────────────────
window.activateLandslideTool = function() {
    if (_activeTool === 'landslide') { cancelHazardTool(); return; }
    cancelHazardTool(false);
    _activeTool = 'landslide';
    window._hazardToolActive = true;
    _setCrosshair(true);
    document.getElementById('slide-tool-btn')?.classList.add('active');
    window.showToast?.('Click map to mark landslide zone', 'info');
};

function _confirmLandslide(center) {
    const radius = window.FIXED_RADIUS_M || 200;
    const id     = `slide-${++_zoneCounter}`;
    const ts     = new Date().toISOString();

    window.drawHazardZone?.('landslide', center, radius, id);
    _zones[id] = { type: 'landslide', center, radius_m: radius };
    _renderZoneList();

    _markPathSegments(center, radius);

    const landslidePayload = {
        event:    'landslide_update',
        zone:     { center, radius_m: radius },
        timestamp: ts,
    };
    console.log('[TEMP DIAGNOSIS] Sending landslide_update payload:', JSON.stringify(landslidePayload));
    window.sendWS?.(landslidePayload);

    window.showToast?.('Landslide marked — roads blocked', 'error');
}

// ── Cancel tool ────────────────────────────────────────────────────────────────
window.cancelHazardTool = function(notify = true) {
    _resetTool(notify);
};

function _resetTool(notify = false) {
    _activeTool = null;
    window._hazardToolActive = false;
    _pendingCenter = null;

    if (_pendingMarker && window.mapInstance) {
        window.mapInstance.removeLayer(_pendingMarker);
        _pendingMarker = null;
    }
    window.removeHazardZone?.('__preview__');
    _setCrosshair(false);

    document.getElementById('flood-tool-btn')?.classList.remove('active');
    document.getElementById('slide-tool-btn')?.classList.remove('active');
    document.getElementById('severity-picker')?.classList.add('hidden');

    if (notify) window.showToast?.('Cancelled', 'info');
}

// ── Segment marking ────────────────────────────────────────────────────────────
function _markPathSegments(center, radius_m) {
    const path = window.getCurrentPath?.();
    if (!path || path.length < 2) return;

    for (let i = 0; i < path.length - 1; i++) {
        const mid = [
            (path[i][0] + path[i+1][0]) / 2,
            (path[i][1] + path[i+1][1]) / 2,
        ];
        if (_haversine(mid, center) <= radius_m) {
            window._hazardSegments.add(i);
        }
    }
}

function _haversine(a, b) {
    const R = 6371000, φ1=a[0]*Math.PI/180, φ2=b[0]*Math.PI/180;
    const dφ=(b[0]-a[0])*Math.PI/180, dλ=(b[1]-a[1])*Math.PI/180;
    return 2*R*Math.asin(Math.sqrt(Math.sin(dφ/2)**2+Math.cos(φ1)*Math.cos(φ2)*Math.sin(dλ/2)**2));
}

// ── Pending center marker ──────────────────────────────────────────────────────
function _placePendingMarker(latLon) {
    if (_pendingMarker) window.mapInstance.removeLayer(_pendingMarker);
    _pendingMarker = L.circleMarker(latLon, {
        radius: 5, color: '#2563eb', fillColor: '#93c5fd',
        fillOpacity: 0.8, weight: 2,
    }).addTo(window.mapInstance);
}

// ── Zone list ──────────────────────────────────────────────────────────────────
function _renderZoneList() {
    const container = document.getElementById('active-zones');
    const list      = document.getElementById('zone-list');
    if (!container || !list) return;

    const ids = Object.keys(_zones);
    if (ids.length === 0) { container.classList.add('hidden'); return; }
    container.classList.remove('hidden');
    list.innerHTML = '';
    ids.forEach(id => {
        const z  = _zones[id];
        const li = document.createElement('li');
        li.className = `zone-item zone-${z.type}`;
        const lbl = z.type === 'flood'
            ? `💧 ${z.severity} / ${z.radius_m}m`
            : `⛰ Landslide / ${z.radius_m}m`;
        li.innerHTML = `<span>${lbl}</span><button class="zone-remove" onclick="removeZone('${id}')">✕</button>`;
        list.appendChild(li);
    });
}

window.removeZone = function(id) {
    window.removeHazardZone?.(id);
    delete _zones[id];
    _renderZoneList();
    // Rebuild hazard segments (clear and re-add from remaining zones)
    window._hazardSegments = new Set();
    Object.values(_zones).forEach(z => _markPathSegments(z.center, z.radius_m));
};

// ── Cursor helper ──────────────────────────────────────────────────────────────
function _setCrosshair(on) {
    document.getElementById('map')?.classList.toggle('crosshair-mode', on);
}
