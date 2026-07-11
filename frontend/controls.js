let currentSocket = null;
let debounceTimer = null;

// The currently selected road ID
let selectedRoadId = null;

document.addEventListener('DOMContentLoaded', () => {
    const slider = document.getElementById('depth-slider');
    const depthDisplay = document.getElementById('depth-display');

    // Debounced slider input
    slider.addEventListener('input', (e) => {
        const val = e.target.value;
        depthDisplay.textContent = `${val} cm`;

        if (debounceTimer) {
            clearTimeout(debounceTimer);
        }

        debounceTimer = setTimeout(() => {
            dispatchFloodUpdate(val);
        }, 300);
    });

    // Mock functionality to select a road
    // In a real scenario, this would be bound to a Leaflet layer click event
    setupRoadSelectionMock();
});

// Hooks called by map.js
window.onWebSocketOpen = function(ws) {
    currentSocket = ws;
};

window.onWebSocketClose = function() {
    currentSocket = null;
};

function dispatchFloodUpdate(depth_cm) {
    if (!currentSocket || currentSocket.readyState !== WebSocket.OPEN) {
        console.warn('Cannot send flood update: WebSocket is not open.');
        if (window.showNotification) {
            window.showNotification('Cannot update depth. Operations Center is offline.', 'error');
        }
        return;
    }

    if (!selectedRoadId) {
        console.warn('No road selected to update.');
        return;
    }

    const payload = {
        event: "flood_update",
        road_id: selectedRoadId,
        depth_cm: parseInt(depth_cm, 10),
        timestamp: new Date().toISOString()
    };

    try {
        currentSocket.send(JSON.stringify(payload));
        console.log('Sent flood_update:', payload);
        
        // Show subtle visual feedback that data was sent
        depthDisplayFeedback();
    } catch (e) {
        console.error('Error sending message:', e);
    }
}

function depthDisplayFeedback() {
    const display = document.getElementById('depth-display');
    const card = document.getElementById('road-control-card');
    
    // Flash text
    display.classList.add('text-white', 'bg-blue-600');
    display.classList.remove('text-blue-400', 'bg-blue-900/20');
    
    // Subtle border pulse
    card.classList.add('border-blue-500/50');
    card.classList.remove('border-gray-700/50');

    setTimeout(() => {
        display.classList.remove('text-white', 'bg-blue-600');
        display.classList.add('text-blue-400', 'bg-blue-900/20');
        
        card.classList.remove('border-blue-500/50');
        card.classList.add('border-gray-700/50');
    }, 300);
}

// Temporary placeholder function showing how road selection works
function setupRoadSelectionMock() {
    // We expose a global function so the operator can simulate clicking a road layer
    window.selectRoad = function(roadId = "NH66_SEG_12") {
        selectedRoadId = roadId;
        
        const slider = document.getElementById('depth-slider');
        const roadNameLabel = document.getElementById('selected-road-name');
        
        slider.disabled = false;
        slider.classList.remove('cursor-not-allowed', 'bg-gray-700');
        slider.classList.add('cursor-pointer', 'bg-gray-600');
        
        roadNameLabel.textContent = `Road ID: ${roadId}`;
        roadNameLabel.classList.remove('text-gray-400');
        roadNameLabel.classList.add('text-white');
        
        console.log(`Road ${roadId} selected. Slider enabled.`);
        
        if (window.showNotification) {
            window.showNotification(`Selected ${roadId}. Adjust depth to update routes.`, 'success');
        }
    };
    
    console.log("Hint: run window.selectRoad('ROAD_123') in the console to test the depth slider.");
}
