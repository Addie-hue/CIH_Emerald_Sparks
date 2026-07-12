// State
let state = {
  vehicleType: 'ambulance', // Hardcoded as requested
  vehicleId: 'veh_' + Math.floor(Math.random() * 100000),
  activeHazardType: 'flood',
  hazards: [],
  ws: null,
  wsReconnectTimer: null,
  
  // Simulation State
  simulationSpeed: 1,
  currentPath: [],
  currentPathCost: 0,
  pathIndex: 0,
  currentLat: null,
  currentLon: null,
  destination: null,
  isMoving: false,
  lastFrameTime: 0,
  animationFrameId: null
};

// UI Elements
const els = {
  origin: document.getElementById('input-origin'),
  destination: document.getElementById('input-destination'),
  btnStartNav: document.getElementById('btn-start-nav'),
  valDistance: document.getElementById('val-distance'),
  valEta: document.getElementById('val-eta'),
  btnFlood: document.getElementById('btn-hazard-flood'),
  btnLandslide: document.getElementById('btn-hazard-landslide'),
  hazardInstruction: document.getElementById('hazard-instruction'),
  hazardList: document.getElementById('hazard-list'),
  inlinePopup: document.getElementById('inline-flood-input'),
  btnSeverityYellow: document.getElementById('btn-severity-yellow'),
  btnSeverityOrange: document.getElementById('btn-severity-orange'),
  btnSeverityRed: document.getElementById('btn-severity-red'),
  btnCancelFlood: document.getElementById('btn-cancel-flood'),
  reconnectBanner: document.getElementById('reconnect-banner'),
  strandedBanner: document.getElementById('stranded-banner'),
  dismissStranded: document.getElementById('dismiss-stranded'),
  speedBtns: [
    document.getElementById('btn-speed-1'),
    document.getElementById('btn-speed-10'),
    document.getElementById('btn-speed-50')
  ],
  btnPickOrigin: document.getElementById('btn-pick-origin'),
  btnPickDest: document.getElementById('btn-pick-dest'),
  btnStopNav: document.getElementById('btn-stop-nav'),
  msgOrigin: document.getElementById('msg-origin'),
  msgDest: document.getElementById('msg-dest')
};

// --- Map Pickers ---
els.btnPickOrigin.addEventListener('click', () => setHazardType('pick_origin'));
els.btnPickDest.addEventListener('click', () => setHazardType('pick_dest'));

// --- Hazard Placement ---
let pendingHazardLocation = null;

window.appMap.map.on('click', async (e) => {
  const { lat, lng } = e.latlng;
  
  if (state.activeHazardType === 'pick_origin') {
    els.origin.value = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    setHazardType('flood'); // Reset to default mode
    validateLocationField('origin');
    return;
  } else if (state.activeHazardType === 'pick_dest') {
    els.destination.value = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    setHazardType('flood'); // Reset to default mode
    validateLocationField('dest');
    return;
  }
  
  if (state.activeHazardType === 'flood' || state.activeHazardType === 'landslide') {
    try {
      const res = await fetch('http://localhost:8000/validate_hazard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lat, lon: lng, hazard_type: state.activeHazardType })
      });
      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
      const data = await res.json();
      if (!data.valid) {
        showToast(data.message || 'Invalid location for hazard');
        return;
      }
    } catch (err) {
      console.error('Validation fetch error:', err);
      showToast('Validation server unreachable.');
      return;
    }
  }
  
  if (state.activeHazardType === 'flood') {
    pendingHazardLocation = { lat, lon: lng };
    const point = window.appMap.map.latLngToContainerPoint(e.latlng);
    const x = Math.min(point.x + 10, window.innerWidth - 200);
    const y = Math.min(point.y + 10, window.innerHeight - 50);
    
    els.inlinePopup.style.left = `${x}px`;
    els.inlinePopup.style.top = `${y}px`;
    els.inlinePopup.classList.remove('hidden');
  } else if (state.activeHazardType === 'landslide') {
    createHazard({
      id: `hz_${Date.now()}`,
      type: 'landslide',
      lat,
      lon: lng,
      radius: 50
    });
  }
});

function addFloodHazard(depth, severity) {
  if (!pendingHazardLocation) return;
  
  createHazard({
    id: `hz_${Date.now()}`,
    type: 'flood',
    lat: pendingHazardLocation.lat,
    lon: pendingHazardLocation.lon,
    depth: depth,
    severity: severity,
    radius: 50
  });
  
  closeInlinePopup();
}

els.btnSeverityYellow.addEventListener('click', () => addFloodHazard(12, 'Yellow'));
els.btnSeverityOrange.addEventListener('click', () => addFloodHazard(30, 'Orange'));
els.btnSeverityRed.addEventListener('click', () => addFloodHazard(55, 'Red'));

els.btnCancelFlood.addEventListener('click', closeInlinePopup);

function closeInlinePopup() {
  els.inlinePopup.classList.add('hidden');
  pendingHazardLocation = null;
}

function showToast(message) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'toast-msg';
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.remove();
  }, 4000);
}

function createHazard(hz) {
  hz.layer = window.appMap.addHazardMarker(hz);
  state.hazards.push(hz);
  renderHazardList();
  
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    if (hz.type === 'flood') {
      state.ws.send(JSON.stringify({
        event: "flood_update",
        road_id: `${hz.lat},${hz.lon}`,
        road_id_or_zone: { lat: hz.lat, lon: hz.lon, radius_m: hz.radius },
        depth_cm: hz.depth,
        timestamp: new Date().toISOString()
      }));
    } else {
      state.ws.send(JSON.stringify({
        event: "flood_update",
        zone: { lat: hz.lat, lon: hz.lon, radius_m: hz.radius },
        road_id: `${hz.lat},${hz.lon}`,
        depth_cm: 999,
        timestamp: new Date().toISOString()
      }));
    }
  }
}

function renderHazardList() {
  els.hazardList.innerHTML = '';
  state.hazards.forEach((hz) => {
    const li = document.createElement('li');
    li.className = 'hazard-item';
    const isFlood = hz.type === 'flood';
    let desc = isFlood ? `Flood - ${hz.severity || 'Unknown'}` : 'Landslide';
    let color = 'var(--accent-amber)'; // Default landslide color
    
    if (isFlood) {
      if (hz.severity === 'Yellow') color = '#eab308';
      else if (hz.severity === 'Orange') color = '#f97316';
      else if (hz.severity === 'Red') color = '#ef4444';
      else color = 'var(--accent-blue)';
    }
      
    li.innerHTML = `
      <span style="display:flex; align-items:center; gap:8px;">
        <span style="color:${color}; font-size: 1.2rem;">●</span>
        ${desc}
      </span>
      <button class="remove-btn" data-id="${hz.id}">&times;</button>
    `;
    
    li.querySelector('.remove-btn').addEventListener('click', () => removeHazard(hz.id));
    els.hazardList.appendChild(li);
  });
}

function removeHazard(id) {
  const index = state.hazards.findIndex(h => h.id === id);
  if (index !== -1) {
    const hz = state.hazards[index];
    window.appMap.removeHazardMarker(hz.layer);
    state.hazards.splice(index, 1);
    renderHazardList();
    
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({
        event: "flood_update",
        road_id: `${hz.lat},${hz.lon}`,
        road_id_or_zone: { lat: hz.lat, lon: hz.lon, radius_m: hz.radius },
        depth_cm: 0,
        timestamp: new Date().toISOString()
      }));
    }
  }
}

// --- Toggles ---
els.btnFlood.addEventListener('click', () => setHazardType('flood'));
els.btnLandslide.addEventListener('click', () => setHazardType('landslide'));

function setHazardType(type) {
  state.activeHazardType = type;
  els.btnFlood.classList.toggle('active', type === 'flood');
  els.btnLandslide.classList.toggle('active', type === 'landslide');
  els.btnPickOrigin.classList.toggle('active', type === 'pick_origin');
  els.btnPickDest.classList.toggle('active', type === 'pick_dest');
  
  if (type === 'flood') els.hazardInstruction.textContent = 'Click map to place flood zone';
  else if (type === 'landslide') els.hazardInstruction.textContent = 'Click map to mark landslide';
  else if (type === 'pick_origin') els.hazardInstruction.textContent = 'Click map to set Origin';
  else if (type === 'pick_dest') els.hazardInstruction.textContent = 'Click map to set Destination';
}

els.speedBtns[0].addEventListener('click', () => setSpeed(1, 0));
els.speedBtns[1].addEventListener('click', () => setSpeed(10, 1));
els.speedBtns[2].addEventListener('click', () => setSpeed(50, 2));

function setSpeed(speed, index) {
  state.simulationSpeed = speed;
  els.speedBtns.forEach((btn, i) => btn.classList.toggle('active', i === index));
}

// --- Geocoding Helpers ---
async function geocode(input) {
  // If it's already coordinates e.g. "10.0, 20.0"
  if (/^[-+]?([1-8]?\d(\.\d+)?|90(\.0+)?),\s*[-+]?(180(\.0+)?|((1[0-7]\d)|([1-9]?\d))(\.\d+)?)$/.test(input.trim())) {
    return input.split(',').map(s => parseFloat(s.trim()));
  }
  
  // Use Nominatim API
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(input)}&format=json&limit=1`);
    const data = await res.json();
    if (data && data.length > 0) {
      return [parseFloat(data[0].lat), parseFloat(data[0].lon)];
    }
  } catch (e) {
    console.error("Geocoding failed", e);
  }
  return null;
}

let originMarker = null;
let destMarker = null;

function isWithinMangalore(coords) {
  const [lat, lon] = coords;
  return lat >= 12.75 && lat <= 13.05 && lon >= 74.75 && lon <= 74.95;
}

async function validateLocationField(type) {
  const isOrigin = type === 'origin';
  const inputEl = isOrigin ? els.origin : els.destination;
  const msgEl = isOrigin ? els.msgOrigin : els.msgDest;
  const val = inputEl.value.trim();
  
  if (!val) {
    msgEl.textContent = '';
    msgEl.className = 'input-message';
    if (isOrigin && originMarker) { originMarker.remove(); originMarker = null; }
    if (!isOrigin && destMarker) { destMarker.remove(); destMarker = null; }
    updateStartButtonState();
    return null;
  }
  
  msgEl.textContent = 'Resolving...';
  msgEl.className = 'input-message';
  
  // Notice we now just use geocode which returns [lat, lon] safely
  const coords = await geocode(val);
  
  if (!coords) {
    msgEl.textContent = 'Could not find this location.';
    msgEl.className = 'input-message error';
    if (isOrigin && originMarker) { originMarker.remove(); originMarker = null; }
    if (!isOrigin && destMarker) { destMarker.remove(); destMarker = null; }
    updateStartButtonState();
    return null;
  }
  
  if (!isWithinMangalore(coords)) {
    msgEl.textContent = 'Location is outside Mangalore coverage area.';
    msgEl.className = 'input-message error';
    if (isOrigin && originMarker) { originMarker.remove(); originMarker = null; }
    if (!isOrigin && destMarker) { destMarker.remove(); destMarker = null; }
    updateStartButtonState();
    return null;
  }
  
  msgEl.textContent = `${isOrigin ? 'Origin' : 'Destination'} set: ${coords[0].toFixed(5)}, ${coords[1].toFixed(5)}`;
  msgEl.className = 'input-message success';
  
  const color = isOrigin ? '#10b981' : '#ef4444'; // green or red
  const markerIcon = L.divIcon({
    className: 'custom-pin',
    html: `<div style="background:${color}; width:16px; height:16px; border-radius:50%; border:2px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.4);"></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8]
  });
  
  if (isOrigin) {
    if (originMarker) originMarker.remove();
    originMarker = L.marker([coords[0], coords[1]], {icon: markerIcon}).addTo(window.appMap.map);
  } else {
    if (destMarker) destMarker.remove();
    destMarker = L.marker([coords[0], coords[1]], {icon: markerIcon}).addTo(window.appMap.map);
  }
  
  updateStartButtonState();
  return coords;
}

function updateStartButtonState() {
  const originSuccess = els.msgOrigin.classList.contains('success');
  const destSuccess = els.msgDest.classList.contains('success');
  
  if (originSuccess && destSuccess && originMarker && destMarker) {
    const oCoords = originMarker.getLatLng();
    const dCoords = destMarker.getLatLng();
    // Using correct function getHaversineDistance this time!
    const dist = getHaversineDistance(oCoords.lat, oCoords.lng, dCoords.lat, dCoords.lng);
    
    if (dist < 20) {
      els.msgDest.textContent = 'Origin and destination cannot be the same location';
      els.msgDest.className = 'input-message error';
      els.btnStartNav.disabled = true;
    } else {
      els.btnStartNav.disabled = false;
    }
  } else {
    els.btnStartNav.disabled = true;
  }
}

els.origin.addEventListener('blur', () => validateLocationField('origin'));
els.destination.addEventListener('blur', () => validateLocationField('dest'));
els.origin.addEventListener('keyup', (e) => { if(e.key === 'Enter') validateLocationField('origin'); });
els.destination.addEventListener('keyup', (e) => { if(e.key === 'Enter') validateLocationField('dest'); });

// Initialize validation
setTimeout(() => {
  validateLocationField('origin');
  validateLocationField('dest');
}, 500);

// --- Navigation & Simulation ---
els.btnStartNav.addEventListener('click', async () => {
  if (els.btnStartNav.disabled) return;
  els.btnStartNav.textContent = 'Routing...';
  els.btnStartNav.disabled = true;
  
  const originParts = [originMarker.getLatLng().lat, originMarker.getLatLng().lng];
  const destParts = [destMarker.getLatLng().lat, destMarker.getLatLng().lng];
  
  state.destination = destParts;
  els.btnStopNav.classList.remove('hidden');
  els.btnStartNav.classList.add('hidden');
  
  try {
    const res = await fetch('http://localhost:8000/route', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        origin: originParts,
        destination: destParts,
        vehicle_type: state.vehicleType
      })
    });
    
    if (!res.ok) throw new Error('API Error');
    const data = await res.json();
    
    if (data.status === 'ok') {
      state.currentPath = data.path;
      state.currentPathCost = data.eta_seconds;
      state.pathIndex = 0;
      state.currentLat = data.path[0][0];
      state.currentLon = data.path[0][1];
      startSimulation();
    }
    
    handleRouteResponse(data);
    
  } catch (err) {
    console.error('Routing failed:', err);
    alert('Failed to calculate route. Check backend connection.');
    els.btnStartNav.classList.remove('hidden');
    els.btnStopNav.classList.add('hidden');
  } finally {
    els.btnStartNav.textContent = 'Start Navigation';
    els.btnStartNav.disabled = false;
  }
});

els.btnStopNav.addEventListener('click', () => {
  stopSimulation();
  if (window.appMap.routeLayer) {
    window.appMap.map.removeLayer(window.appMap.routeLayer);
    window.appMap.routeLayer = null;
  }
  if (window.appMap.vehicleMarker) {
    window.appMap.map.removeLayer(window.appMap.vehicleMarker);
    window.appMap.vehicleMarker = null;
  }
  els.btnStartNav.textContent = 'Start Navigation';
  els.btnStartNav.disabled = false;
  els.btnStartNav.classList.remove('hidden');
  els.btnStopNav.classList.add('hidden');
  els.valDistance.textContent = '-- km';
  els.valEta.textContent = '-- min';
  els.valEta.style.color = '';
});

function handleRouteResponse(data) {
  const isStranded = data.status === 'stranded' || data.status === 'no_route';
  
  // If the backend sent a route update while we are moving, update our path
  if (!isStranded && data.path && data.path.length > 0) {
    // If it's a reroute from current position, reset index
    state.currentPath = data.path;
    state.pathIndex = 0;
    state.currentPathCost = data.eta_seconds;
  }
  
  window.appMap.drawRoute(state.currentPath, isStranded);
  
  if (isStranded) {
    stopSimulation();
    els.strandedBanner.classList.remove('hidden');
    els.valEta.textContent = '-- min';
    els.valEta.style.color = '';
    els.valDistance.textContent = '-- km';
    els.btnStartNav.textContent = 'Start Navigation';
    els.btnStartNav.disabled = false;
    els.btnStartNav.classList.remove('hidden');
    els.btnStopNav.classList.add('hidden');
  } else {
    els.strandedBanner.classList.add('hidden');
    updateStatsUI(state.currentPathCost);
  }
}

function updateStatsUI(etaSeconds) {
  if (etaSeconds === undefined || isNaN(etaSeconds)) return;
  const etaMin = Math.round(etaSeconds / 60);
  els.valEta.textContent = `${etaMin} min`;
  
  // Calculate remaining distance in km based on path
  let remainingDist = 0;
  if (state.currentPath && state.pathIndex < state.currentPath.length) {
    // Distance from current position to the next node
    if (state.pathIndex < state.currentPath.length - 1) {
      remainingDist += getHaversineDistance(
        state.currentLat, state.currentLon,
        state.currentPath[state.pathIndex + 1][0], state.currentPath[state.pathIndex + 1][1]
      );
    }
    // Distance for the rest of the path
    for (let i = state.pathIndex + 1; i < state.currentPath.length - 1; i++) {
      remainingDist += getHaversineDistance(
        state.currentPath[i][0], state.currentPath[i][1],
        state.currentPath[i+1][0], state.currentPath[i+1][1]
      );
    }
  }
  
  const distKm = (remainingDist / 1000).toFixed(1);
  els.valDistance.textContent = `${distKm} km`;
  
  if (etaMin > 15) {
    els.valEta.style.color = 'var(--error-red)';
  } else {
    els.valEta.style.color = '';
  }
}

els.dismissStranded.addEventListener('click', () => {
  els.strandedBanner.classList.add('hidden');
});

// -- Movement Loop --
function getHaversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // metres
  const φ1 = lat1 * Math.PI/180;
  const φ2 = lat2 * Math.PI/180;
  const Δφ = (lat2-lat1) * Math.PI/180;
  const Δλ = (lon2-lon1) * Math.PI/180;

  const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ/2) * Math.sin(Δλ/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c; 
}


function startSimulation() {
  if (state.animationFrameId) cancelAnimationFrame(state.animationFrameId);
  state.isMoving = true;
  state.lastFrameTime = performance.now();
  
  // Register vehicle with backend immediately
  sendLocationUpdate();
  
  requestAnimationFrame(simulationLoop);
}

function stopSimulation() {
  state.isMoving = false;
  if (state.animationFrameId) cancelAnimationFrame(state.animationFrameId);
}

let lastWsUpdate = 0;

function simulationLoop(timestamp) {
  if (!state.isMoving) return;
  
  const dtSeconds = (timestamp - state.lastFrameTime) / 1000;
  state.lastFrameTime = timestamp;
  
  // Base speed: 60km/h = 16.6 m/s
  const speedMetersPerSec = 16.6 * state.simulationSpeed;
  let distanceToMove = speedMetersPerSec * dtSeconds;
  
  while (distanceToMove > 0 && state.pathIndex < state.currentPath.length - 1) {
    const nextNode = state.currentPath[state.pathIndex + 1];
    const distToNext = getHaversineDistance(state.currentLat, state.currentLon, nextNode[0], nextNode[1]);
    
    if (distanceToMove >= distToNext) {
      // Reached next node
      distanceToMove -= distToNext;
      state.pathIndex++;
      state.currentLat = nextNode[0];
      state.currentLon = nextNode[1];
    } else {
      // Move fraction of the way
      const fraction = distanceToMove / distToNext;
      state.currentLat += (nextNode[0] - state.currentLat) * fraction;
      state.currentLon += (nextNode[1] - state.currentLon) * fraction;
      distanceToMove = 0;
    }
  }
  
  window.appMap.updateVehicleMarker([state.currentLat, state.currentLon]);
  
  // Update the drawn route to only show the remaining path from the vehicle's current position
  if (state.currentPath && state.currentPath.length > 0) {
      const remainingPath = [[state.currentLat, state.currentLon], ...state.currentPath.slice(state.pathIndex + 1)];
      window.appMap.drawRoute(remainingPath, false, true); // true = skip fitBounds
  }
  
  // Calculate remaining ETA dynamically
  const dtSimulated = dtSeconds * state.simulationSpeed;
  state.currentPathCost = Math.max(0, state.currentPathCost - dtSimulated);
  updateStatsUI(state.currentPathCost);
  
  // Send WS update every 1s of real time
  if (timestamp - lastWsUpdate > 1000) {
    sendLocationUpdate();
    lastWsUpdate = timestamp;
  }
  
  if (state.pathIndex >= state.currentPath.length - 1) {
    stopSimulation(); // Reached destination
    els.btnStartNav.textContent = 'Start Navigation';
    els.btnStartNav.disabled = false;
    els.btnStartNav.classList.remove('hidden');
    els.btnStopNav.classList.add('hidden');
  } else {
    state.animationFrameId = requestAnimationFrame(simulationLoop);
  }
}

function sendLocationUpdate() {
  if (state.ws && state.ws.readyState === WebSocket.OPEN && state.destination) {
    state.ws.send(JSON.stringify({
      event: "update_location",
      vehicle_id: state.vehicleId,
      position: [state.currentLat, state.currentLon],
      path: state.currentPath.slice(state.pathIndex), // Send remaining path
      destination: state.destination
    }));
  }
}

// --- WebSocket Connection ---
function connectWebSocket() {
  state.ws = new WebSocket(`ws://localhost:8000/ws`);
  
  state.ws.onopen = () => {
    els.reconnectBanner.classList.add('hidden');
    if (state.wsReconnectTimer) {
      clearInterval(state.wsReconnectTimer);
      state.wsReconnectTimer = null;
    }
  };
  
  state.ws.onmessage = (msg) => {
    try {
      const data = JSON.parse(msg.data);
      if (data.event === 'route_update') {
        if (!data.vehicle_id || data.vehicle_id === state.vehicleId) {
          handleRouteResponse(data);
        }
      } else if (data.event === 'hazard_error') {
        showToast(data.message || 'Hazard validation failed');
        if (data.road_id) {
          // Find and remove the optimistic hazard if it exists
          const latlon = data.road_id.split(',');
          if (latlon.length === 2) {
            const lat = parseFloat(latlon[0]);
            const lon = parseFloat(latlon[1]);
            const hz = state.hazards.find(h => h.lat === lat && h.lon === lon);
            if (hz) {
              removeHazard(hz.id);
            }
          }
        }
      }
    } catch(e) {
      console.error("Failed to parse WS message", e);
    }
  };
  
  state.ws.onclose = () => {
    els.reconnectBanner.classList.remove('hidden');
    if (!state.wsReconnectTimer) {
      state.wsReconnectTimer = setInterval(connectWebSocket, 3000);
    }
  };
  
  state.ws.onerror = (e) => {
    console.error('WebSocket error:', e);
    state.ws.close();
  };
}

connectWebSocket();

// --- Toast Messages ---
function showToast(msg) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'toast-msg';
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => {
    if (el.parentNode) el.parentNode.removeChild(el);
  }, 4000);
}
