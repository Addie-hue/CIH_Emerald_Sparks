// Global Map and Socket State
let map;
let ws;
const routePolylines = {}; // Key: vehicle_id, Value: L.polyline
const ambulanceStatus = {}; // Key: vehicle_id, Value: status

document.addEventListener('DOMContentLoaded', () => {
    initMap();
    fetchSafeZones();
    connectWebSocket();
});

function initMap() {
    // Center on Mangaluru: 12.9141, 74.8560, zoom 13
    map = L.map('map', {
        zoomControl: false
    }).setView([12.9141, 74.8560], 13);

    // CartoDB Dark Matter tile layer
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 20
    }).addTo(map);

    // Add zoom control to top right
    L.control.zoom({ position: 'bottomright' }).addTo(map);
}

async function fetchSafeZones() {
    try {
        const response = await fetch('http://localhost:8000/safe-zones');
        if (!response.ok) throw new Error('Network response was not ok');
        const zones = await response.json();
        renderSafeZones(zones);
    } catch (error) {
        console.warn('Backend offline, using fallback mock safe zones.', error);
        // Fallback mock safe zones matching the contract
        const mockZones = [
            { name: "Wenlock Hospital", type: "hospital", lat: 12.8683, lon: 74.8427 },
            { name: "KMC Hospital", type: "hospital", lat: 12.8732, lon: 74.8465 },
            { name: "St. Aloysius Relief Camp", type: "relief_camp", lat: 12.8724, lon: 74.8449 },
            { name: "Kadri Hill", type: "high_ground", lat: 12.8837, lon: 74.8550 },
            { name: "NITK Relief Camp", type: "relief_camp", lat: 13.0108, lon: 74.7943 }
        ];
        renderSafeZones(mockZones);
    }
}

function renderSafeZones(zones) {
    zones.forEach(zone => {
        let color = '#3b82f6'; // default blue
        if (zone.type === 'hospital') color = '#ef4444'; // red
        else if (zone.type === 'relief_camp') color = '#22c55e'; // green
        else if (zone.type === 'high_ground') color = '#eab308'; // yellow

        L.circleMarker([zone.lat, zone.lon], {
            radius: 8,
            fillColor: color,
            color: '#fff',
            weight: 2,
            opacity: 1,
            fillOpacity: 0.8
        })
        .bindPopup(`<strong>${zone.name}</strong><br/><span class="capitalize text-gray-300 text-xs">${zone.type.replace('_', ' ')}</span>`)
        .addTo(map);
    });
}

function connectWebSocket() {
    // Attempt WebSocket connection
    ws = new WebSocket('ws://localhost:8000/ws');

    ws.onopen = () => {
        console.log('WebSocket connected to ws://localhost:8000/ws');
        showNotification('Connected to Operations Center', 'success');
        updateConnectionStatus(true);
        
        // Let controls.js know the socket is open
        if (window.onWebSocketOpen) {
            window.onWebSocketOpen(ws);
        }
    };

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.event === 'route_update') {
                handleRouteUpdate(data);
            }
        } catch (e) {
            console.error('Error parsing WS message:', e);
        }
    };

    ws.onclose = () => {
        console.log('WebSocket disconnected. Reconnecting in 5s...');
        updateConnectionStatus(false);
        setTimeout(connectWebSocket, 5000);
        
        if (window.onWebSocketClose) {
            window.onWebSocketClose();
        }
    };

    ws.onerror = (err) => {
        console.error('WebSocket error:', err);
    };
}

function updateConnectionStatus(isConnected) {
    const indicator = document.getElementById('connection-indicator');
    const text = document.getElementById('connection-text');
    if (isConnected) {
        indicator.classList.remove('bg-red-500');
        indicator.classList.add('bg-green-500');
        text.textContent = 'Online';
        text.classList.add('text-green-500');
        text.classList.remove('text-gray-400');
    } else {
        indicator.classList.remove('bg-green-500');
        indicator.classList.add('bg-red-500');
        text.textContent = 'Offline';
        text.classList.remove('text-green-500');
        text.classList.add('text-gray-400');
    }
}

function handleRouteUpdate(data) {
    const { vehicle_id, path, eta_seconds, status } = data;
    
    // Clear old polyline if exists
    if (routePolylines[vehicle_id]) {
        map.removeLayer(routePolylines[vehicle_id]);
    }

    // Determine color based on status
    const lineColor = status === 'stranded' ? '#ef4444' : '#3b82f6';
    const dashArray = status === 'stranded' ? '5, 10' : null;

    // Draw new polyline
    const polyline = L.polyline(path, {
        color: lineColor,
        weight: 5,
        opacity: 0.9,
        dashArray: dashArray,
        lineCap: 'round',
        lineJoin: 'round',
        className: 'route-path'
    }).addTo(map);

    routePolylines[vehicle_id] = polyline;
    ambulanceStatus[vehicle_id] = { status, eta_seconds };

    // Update UI
    updateAmbulanceList(vehicle_id, status, eta_seconds);

    // Notify if stranded
    if (status === 'stranded') {
        showNotification(`ALERT: ${vehicle_id} is stranded! Rerouting...`, 'error');
    }
}

function updateAmbulanceList(vehicle_id, status, eta_seconds) {
    const list = document.getElementById('ambulance-list');
    const noAmbulances = document.getElementById('no-ambulances');
    
    if (noAmbulances) noAmbulances.remove();

    let listItem = document.getElementById(`amb-${vehicle_id}`);
    
    const minutes = Math.floor(eta_seconds / 60);
    const seconds = Math.floor(eta_seconds % 60);
    const timeStr = `${minutes}m ${seconds}s`;
    
    const isStranded = status === 'stranded';
    const statusClass = isStranded 
        ? 'text-red-300 bg-red-900/30 border-red-800' 
        : 'text-blue-300 bg-blue-900/30 border-blue-800';
    const statusText = isStranded ? 'STRANDED' : 'EN ROUTE';
    
    const bgClass = isStranded ? 'bg-red-950/20 border-red-900/40' : 'bg-gray-800/40 border-gray-700/50';

    const innerHTML = `
        <div class="flex justify-between items-center mb-1">
            <span class="font-bold text-gray-200 flex items-center gap-2">
                <div class="w-1.5 h-1.5 rounded-full ${isStranded ? 'bg-red-500 animate-ping' : 'bg-blue-500'}"></div>
                ${vehicle_id}
            </span>
            <span class="text-[10px] px-2 py-0.5 rounded border font-semibold tracking-wide ${statusClass}">${statusText}</span>
        </div>
        <div class="flex justify-between items-end mt-2">
            <p class="text-xs text-gray-400 font-mono">ETA: <span class="text-gray-300">${timeStr}</span></p>
            <button onclick="window.focusVehicle('${vehicle_id}')" class="text-[10px] text-gray-500 hover:text-blue-400 transition-colors uppercase tracking-wider">Locate</button>
        </div>
    `;

    if (listItem) {
        // Update existing
        listItem.className = `border rounded-xl p-3 ambulance-item backdrop-blur-sm ${bgClass}`;
        listItem.innerHTML = innerHTML;
    } else {
        // Create new
        listItem = document.createElement('li');
        listItem.id = `amb-${vehicle_id}`;
        listItem.className = `border rounded-xl p-3 ambulance-item backdrop-blur-sm ${bgClass}`;
        listItem.innerHTML = innerHTML;
        list.appendChild(listItem);
    }
}

// Allow user to click locate button
window.focusVehicle = function(vehicle_id) {
    const polyline = routePolylines[vehicle_id];
    if (polyline) {
        map.fitBounds(polyline.getBounds(), { padding: [50, 50] });
    }
};

window.showNotification = function(message, type = 'info') {
    const container = document.getElementById('notifications-container');
    const toast = document.createElement('div');
    
    let bgClass = 'bg-gray-800/90 border-gray-700 text-white';
    let icon = '<svg class="w-5 h-5 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>';
    
    if (type === 'error') {
        bgClass = 'bg-red-950/90 border-red-800 text-red-50';
        icon = '<svg class="w-5 h-5 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>';
    }
    if (type === 'success') {
        bgClass = 'bg-green-950/90 border-green-800 text-green-50';
        icon = '<svg class="w-5 h-5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>';
    }

    toast.className = `p-4 rounded-xl shadow-2xl border backdrop-blur-md ${bgClass} text-sm font-medium transition-all duration-300 pointer-events-auto flex items-start space-x-3 transform translate-x-full opacity-0`;
    toast.innerHTML = `
        <div class="mt-0.5 flex-shrink-0">${icon}</div>
        <div class="flex-1">${message}</div>
    `;

    container.appendChild(toast);

    // Animate in
    requestAnimationFrame(() => {
        toast.classList.remove('translate-x-full', 'opacity-0');
    });

    // Remove after 4s
    setTimeout(() => {
        toast.classList.add('opacity-0', 'scale-95');
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

// Global debug function
window.simulateIncomingRoute = function() {
    const mockData = {
        event: "route_update",
        vehicle_id: "AMB-101",
        path: [
            [12.8732, 74.8465], // KMC Hospital
            [12.8800, 74.8500],
            [12.8850, 74.8550],
            [12.8900, 74.8600],
            [12.8950, 74.8620]
        ],
        eta_seconds: 450,
        status: Math.random() > 0.6 ? "stranded" : "ok"
    };
    handleRouteUpdate(mockData);
    
    // Animate map to route
    map.fitBounds(mockData.path, { padding: [100, 100] });
};
