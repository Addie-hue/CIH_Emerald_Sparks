/**
 * map.js — Map, WebSocket, route drawing, hazard zone circles + icons
 *
 * Globals exposed:
 *   window.mapInstance      — Leaflet map
 *   window.sendWS(obj)      — send JSON on the WebSocket
 *   window.drawRoute(path, traveledCount, hazardSegments)
 *   window.drawHazardZone(type, center, radius_m, id, severity?)
 *   window.removeHazardZone(id)
 *   window.showToast(msg, type)
 *   window.showBanner(msg, type)
 *   window.setBadge(online)
 *   window.onRouteUpdate    — set by vehicle.js
 */

'use strict';

const BACKEND_HTTP = 'http://localhost:8000';
const BACKEND_WS   = 'ws://localhost:8000/ws';
const TILE_URL     = 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';
const TILE_ATTR    = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';

const MAP_CENTER   = [12.8698, 74.8421];
const MAP_ZOOM     = 14;

// Route colors
const COLOR_GREEN   = '#16a34a';
const COLOR_RED     = '#ef4444';
const COLOR_GRAY    = '#94a3b8';

// Flood severity → fill color
const SEV_COLORS = {
    mild:    '#93c5fd',   // light blue
    caution: '#fde68a',   // amber
    severe:  '#fdba74',   // orange
    blocked: '#fca5a5',   // red
};
const SEV_BORDER = {
    mild:    '#2563eb',
    caution: '#d97706',
    severe:  '#ea580c',
    blocked: '#dc2626',
};

// ── State ──────────────────────────────────────────────────────────────────────
let _map;
let _ws;
let _wsReconnect = null;

let _routeLayers   = [];   // array of L.polyline (we draw per-segment for color)
let _hazardLayers  = {};   // id → { circle: L.circle, icon: L.marker }

// ── Map init ───────────────────────────────────────────────────────────────────
function initMap() {
    _map = L.map('map', { zoomControl: false }).setView(MAP_CENTER, MAP_ZOOM);
    L.tileLayer(TILE_URL, { attribution: TILE_ATTR, subdomains: 'abcd', maxZoom: 20 }).addTo(_map);
    L.control.zoom({ position: 'bottomright' }).addTo(_map);
    window.mapInstance = _map;
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
function connectWS() {
    if (_ws && (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING)) return;
    _ws = new WebSocket(BACKEND_WS);
    window.wsSocket = _ws;

    _ws.onopen = () => {
        console.log('[WS] connected');
        window.setBadge(true);
        showToast('Connected to backend', 'success');
        if (_wsReconnect) { clearTimeout(_wsReconnect); _wsReconnect = null; }
    };

    _ws.onmessage = (evt) => {
        try {
            const data = JSON.parse(evt.data);
            console.log('[WS] ←', data.event, data.status);
            if (data.event === 'route_update') {
                if (typeof window.onRouteUpdate === 'function') window.onRouteUpdate(data);
            }
        } catch (e) { console.error('[WS] parse error', e); }
    };

    _ws.onclose = () => {
        console.warn('[WS] disconnected — reconnect in 5s');
        window.setBadge(false);
        _wsReconnect = setTimeout(connectWS, 5000);
    };

    _ws.onerror = (e) => console.error('[WS] error', e);
}

window.sendWS = function(obj) {
    if (!_ws || _ws.readyState !== WebSocket.OPEN) {
        showToast('Backend offline', 'error');
        return false;
    }
    console.log('[WS] →', obj.event);
    _ws.send(JSON.stringify(obj));
    return true;
};

window.setBadge = function(online) {
    const el = document.getElementById('ws-badge');
    if (!el) return;
    el.textContent = online ? '● Online' : '● Offline';
    el.className   = 'badge ' + (online ? 'badge-online' : 'badge-offline');
};

// ── Route drawing ─────────────────────────────────────────────────────────────
/**
 * @param {Array}  path            [[lat,lon],...] full path
 * @param {number} traveledCount   nodes already passed (gray portion)
 * @param {Set}    hazardSegIdxs   set of segment indices that pass through active hazard zones (draw red)
 */
window.drawRoute = function(path, traveledCount = 0, hazardSegIdxs = new Set()) {
    if (!_map) return;

    // Remove old route layers
    _routeLayers.forEach(l => _map.removeLayer(l));
    _routeLayers = [];

    if (!path || path.length < 2) return;

    // Draw segment by segment so each can be a different color
    for (let i = 0; i < path.length - 1; i++) {
        const seg  = [path[i], path[i + 1]];
        const past = i < traveledCount;
        let color, opacity, weight;

        if (past) {
            color   = COLOR_GRAY;
            opacity = 0.4;
            weight  = 4;
        } else if (hazardSegIdxs.has(i)) {
            color   = COLOR_RED;
            opacity = 0.9;
            weight  = 5;
        } else {
            color   = COLOR_GREEN;
            opacity = 0.9;
            weight  = 5;
        }

        const line = L.polyline(seg, { color, opacity, weight, lineCap: 'round', lineJoin: 'round' });
        line.addTo(_map);
        _routeLayers.push(line);
    }
};

// ── Hazard zones ──────────────────────────────────────────────────────────────
window.drawHazardZone = function(type, center, radius_m, id, severity) {
    // Remove existing layer with same id
    window.removeHazardZone(id);

    let circleOpts, iconHtml;

    if (type === 'flood') {
        const fill   = SEV_COLORS[severity]  || '#93c5fd';
        const border = SEV_BORDER[severity]  || '#2563eb';
        circleOpts = {
            color: border, fillColor: fill,
            weight: 2, opacity: 0.9,
            fillOpacity: 0.35, dashArray: null,
        };
        iconHtml = `<div class="hz-icon">💧</div>`;
    } else {
        // Landslide — dashed border, warm earth color
        circleOpts = {
            color: '#b45309', fillColor: '#d97706',
            weight: 2.5, opacity: 0.85,
            fillOpacity: 0.20, dashArray: '8, 6',
        };
        iconHtml = `<div class="hz-icon">⛰</div>`;
    }

    const circle = L.circle(center, { radius: radius_m, ...circleOpts });
    const label  = type === 'flood'
        ? `💧 Flood — ${severity}`
        : '⛰ Landslide — blocked';
    circle.bindPopup(label);

    // Use a custom Leaflet pane so icons sit ABOVE route lines
    if (!_map.getPane('hazardIcons')) {
        _map.createPane('hazardIcons');
        _map.getPane('hazardIcons').style.zIndex = 450;
    }

    const icon = L.divIcon({ className: '', html: iconHtml, iconSize: [22, 22], iconAnchor: [11, 11] });
    const iconMarker = L.marker(center, { icon, pane: 'hazardIcons', interactive: false });

    circle.addTo(_map);
    iconMarker.addTo(_map);

    _hazardLayers[id] = { circle, icon: iconMarker };
};

window.removeHazardZone = function(id) {
    if (_hazardLayers[id]) {
        _map.removeLayer(_hazardLayers[id].circle);
        _map.removeLayer(_hazardLayers[id].icon);
        delete _hazardLayers[id];
    }
};

// ── Toast ─────────────────────────────────────────────────────────────────────
const TOAST_ICONS = { info:'ℹ️', success:'✅', warn:'⚠️', error:'❌' };

window.showToast = function(msg, type = 'info') {
    const c = document.getElementById('toast-container');
    if (!c) return;
    const t = document.createElement('div');
    t.className = `toast toast-${type}`;
    t.innerHTML = `<span class="toast-icon">${TOAST_ICONS[type]||'ℹ️'}</span><span>${msg}</span>`;
    c.appendChild(t);
    setTimeout(() => { t.classList.add('fade-out'); setTimeout(() => t.remove(), 300); }, 4000);
};

// ── Banner ────────────────────────────────────────────────────────────────────
window.showBanner = function(msg, type = 'info') {
    const el = document.getElementById('status-banner');
    if (!el) return;
    el.textContent = msg;
    el.className = 'status-banner banner-' + (type || 'ok');
    el.classList.remove('hidden');
    if (type === 'ok' || type === 'arrived') setTimeout(() => el.classList.add('hidden'), 4000);
};

// ── Init ───────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    initMap();
    connectWS();
});
