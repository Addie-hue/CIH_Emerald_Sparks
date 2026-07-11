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
  slaIndicator: document.getElementById('sla-indicator'),
  btnFlood: document.getElementById('btn-hazard-flood'),
  btnLandslide: document.getElementById('btn-hazard-landslide'),
  hazardInstruction: document.getElementById('hazard-instruction'),
  hazardList: document.getElementById('hazard-list'),
  inlinePopup: document.getElementById('inline-flood-input'),
  inputFloodDepth: document.getElementById('input-flood-depth'),
  btnSubmitFlood: document.getElementById('btn-submit-flood'),
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
  btnPickDest: document.getElementById('btn-pick-dest')
};

// --- Map Pickers ---
els.btnPickOrigin.addEventListener('click', () => setHazardType('pick_origin'));
els.btnPickDest.addEventListener('click', () => setHazardType('pick_dest'));

// --- Hazard Placement ---
let pendingHazardLocation = null;

window.appMap.map.on('click', (e) => {
  const { lat, lng } = e.latlng;
  
  if (state.activeHazardType === 'pick_origin') {
    els.origin.value = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    setHazardType('flood'); // Reset to default mode
    return;
  } else if (state.activeHazardType === 'pick_dest') {
    els.destination.value = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    setHazardType('flood'); // Reset to default mode
    return;
  }
  
  if (state.activeHazardType === 'flood') {
    pendingHazardLocation = { lat, lon: lng };
    const point = window.appMap.map.latLngToContainerPoint(e.latlng);
    const x = Math.min(point.x + 10, window.innerWidth - 200);
    const y = Math.min(point.y + 10, window.innerHeight - 50);
    
    els.inlinePopup.style.left = `${x}px`;
    els.inlinePopup.style.top = `${y}px`;
    els.inlinePopup.classList.remove('hidden');
    els.inputFloodDepth.focus();
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

els.btnSubmitFlood.addEventListener('click', () => {
  if (!pendingHazardLocation) return;
  const depth = parseInt(els.inputFloodDepth.value, 10) || 30;
  
  createHazard({
    id: `hz_${Date.now()}`,
    type: 'flood',
    lat: pendingHazardLocation.lat,
    lon: pendingHazardLocation.lon,
    depth: depth,
    radius: 50
  });
  
  closeInlinePopup();
});

els.btnCancelFlood.addEventListener('click', closeInlinePopup);

function closeInlinePopup() {
  els.inlinePopup.classList.add('hidden');
  pendingHazardLocation = null;
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
    const desc = hz.type === 'flood' ? `Flood (${hz.depth}cm)` : 'Landslide';
      
    li.innerHTML = `
      <span style="display:flex; align-items:center; gap:8px;">
        <span style="color:${hz.type === 'flood' ? 'var(--accent-blue)' : 'var(--accent-amber)'}; font-size: 1.2rem;">●</span>
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

// --- Navigation & Simulation ---
els.btnStartNav.addEventListener('click', async () => {
  els.btnStartNav.textContent = 'Resolving locations...';
  els.btnStartNav.disabled = true;
  
  const originParts = await geocode(els.origin.value);
  const destParts = await geocode(els.destination.value);
  
  if (!originParts || !destParts) {
    alert('Could not resolve location names or coordinates. Please try again.');
    els.btnStartNav.textContent = 'Start Navigation';
    els.btnStartNav.disabled = false;
    return;
  }
  
  els.btnStartNav.textContent = 'Routing...';
  state.destination = destParts;
  
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
  } finally {
    els.btnStartNav.textContent = 'Start Navigation';
    els.btnStartNav.disabled = false;
  }
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
    els.valDistance.textContent = '-- km';
    els.slaIndicator.classList.add('hidden');
  } else {
    els.strandedBanner.classList.add('hidden');
    updateStatsUI(state.currentPathCost);
  }
}

function updateStatsUI(etaSeconds) {
  if (etaSeconds === undefined || isNaN(etaSeconds)) return;
  const etaMin = Math.round(etaSeconds / 60);
  els.valEta.textContent = `${etaMin} min`;
  
  // Calculate remaining distance in km approx
  const distKm = (etaMin * 1.0).toFixed(1); // Assuming 60km/h
  els.valDistance.textContent = `${distKm} km`;
  
  els.slaIndicator.classList.remove('hidden', 'success', 'warning');
  if (etaMin <= 15) {
    els.slaIndicator.classList.add('success');
    els.slaIndicator.textContent = ''; 
  } else {
    els.slaIndicator.classList.add('warning');
    els.slaIndicator.textContent = 'Exceeds 15-min response target';
  }
}

els.dismissStranded.addEventListener('click', () => {
  els.strandedBanner.classList.add('hidden');
});

// -- Movement Loop --
function getHaversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // metres
  const φ1 = lat1 * Math.PI/180; // φ, λ in radians
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
