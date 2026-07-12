// Initialize map
const map = L.map('map', {zoomControl: false}).setView([10.0, 20.0], 10); 
L.control.zoom({ position: 'bottomright' }).addTo(map);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© OpenStreetMap contributors'
}).addTo(map);

// Localized English raster label overlay layer restricted strictly to Jammu & Kashmir and Ladakh regions
const jkBounds = L.latLngBounds(
  [32.0, 73.0], // Southwest boundary
  [37.5, 80.5]  // Northeast boundary
);

L.tileLayer('https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png', {
  maxZoom: 19,
  bounds: jkBounds,
  attribution: '© CARTO'
}).addTo(map);

// Dataset bounds visualization
const datasetBounds = [
  [12.75, 74.75], // Southwest [South, West]
  [13.05, 74.95]  // Northeast [North, East]
];

L.rectangle(datasetBounds, {
  color: '#0d6efd',
  weight: 2,
  fillColor: '#0d6efd',
  fillOpacity: 0.03,
  dashArray: '5, 10'
}).addTo(map).bindTooltip("Simulation Dataset Boundary", { permanent: false, sticky: true });

// Center map to dataset bounds
map.fitBounds(datasetBounds);


// Official India Boundary Geopolitical Correction Layer (CORS-enabled jsDelivr CDN)
fetch('https://cdn.jsdelivr.net/gh/datameet/maps@master/Country/india-composite.geojson')
  .then(res => {
    if (!res.ok) throw new Error('Failed to fetch India boundary data');
    return res.json();
  })
  .then(geoJsonData => {
    L.geoJSON(geoJsonData, {
      style: {
        color: '#876D93',
        weight: 2.5,
        opacity: 0.80,
        lineCap: 'round',
        lineJoin: 'round',
        fillColor: 'none',
        fillOpacity: 0
      },
      interactive: false
    }).addTo(map);
  })
  .catch(err => {
    console.error('Failed to load official India boundary GeoJSON overlay:', err);
  });

const layers = {
  routeLine: null,
  vehicleMarker: null,
  hazards: L.layerGroup().addTo(map)
};

const vehicleIcon = L.divIcon({
  className: 'vehicle-marker',
  html: `<div style="background-color: var(--accent-blue); width: 18px; height: 18px; border-radius: 50%; border: 3px solid white; box-shadow: 0 0 6px rgba(0,0,0,0.5);"></div>`,
  iconSize: [24, 24],
  iconAnchor: [12, 12]
});

const vehicleWarningIcon = L.divIcon({
  className: 'vehicle-marker warning',
  html: `<div style="background-color: var(--error-red); width: 18px; height: 18px; border-radius: 50%; border: 3px solid white; box-shadow: 0 0 10px var(--error-red);"></div>`,
  iconSize: [24, 24],
  iconAnchor: [12, 12]
});

function drawRoute(pathCoords, isStranded, skipFitBounds = false) {
  if (layers.routeLine) {
    map.removeLayer(layers.routeLine);
    layers.routeLine = null;
  }
  
  if (pathCoords && pathCoords.length > 0) {
    const color = isStranded ? 'var(--error-red)' : 'var(--accent-blue)';
    layers.routeLine = L.polyline(pathCoords, { color: color, weight: 6, opacity: 0.8 }).addTo(map);
    
    if (!skipFitBounds) {
      map.fitBounds(layers.routeLine.getBounds(), { padding: [50, 50], maxZoom: 16 });
    }
    
    updateVehicleMarker(pathCoords[0], isStranded);
  } else if (isStranded && layers.vehicleMarker) {
    // Path might be empty if fully stranded, just update marker to warning
    layers.vehicleMarker.setIcon(vehicleWarningIcon);
  }
}

function updateVehicleMarker(coord, isStranded) {
  const icon = isStranded ? vehicleWarningIcon : vehicleIcon;
  if (!layers.vehicleMarker) {
    layers.vehicleMarker = L.marker(coord, { icon: icon }).addTo(map);
  } else {
    layers.vehicleMarker.setLatLng(coord);
    layers.vehicleMarker.setIcon(icon);
  }
}

function addHazardMarker(hazard) {
  let color, label;
  if (hazard.type === 'flood') {
    if (hazard.severity === 'Yellow') color = '#eab308';
    else if (hazard.severity === 'Orange') color = '#f97316';
    else if (hazard.severity === 'Red') color = '#ef4444';
    else color = 'var(--accent-blue)';
    label = hazard.severity || `${hazard.depth}cm`;
  } else {
    color = 'var(--accent-amber)';
    label = ''; // No depth for landslides
  }
  
  const circle = L.circle([hazard.lat, hazard.lon], {
    color: color,
    fillColor: color,
    fillOpacity: 0.4,
    weight: 2,
    radius: hazard.radius
  }).addTo(layers.hazards);
  
  if (label) {
    circle.bindTooltip(label, { 
      permanent: true, 
      direction: 'center', 
      className: 'hazard-tooltip' 
    }).openTooltip();
  }
  
  return circle;
}

function removeHazardMarker(layer) {
  layers.hazards.removeLayer(layer);
}

// Add global styles for tooltips injected by map.js
const style = document.createElement('style');
style.textContent = `
  .hazard-tooltip { 
    background: transparent; 
    border: none; 
    box-shadow: none; 
    color: white; 
    font-weight: 700; 
    text-shadow: 0 1px 3px rgba(0,0,0,0.8); 
    font-size: 13px; 
  }
  .hazard-tooltip::before { display: none; }
`;
document.head.appendChild(style);

window.appMap = {
  drawRoute,
  updateVehicleMarker,
  addHazardMarker,
  removeHazardMarker,
  map
};
