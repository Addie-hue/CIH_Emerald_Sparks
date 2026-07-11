import sys
import os

# Add parent dir to path if run standalone
if __name__ == '__main__':
    sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

def assign_fleet(incidents, vehicles):
    """
    POST /assign-fleet
    Assigns incidents to available vehicles based on lowest travel time (greedy).
    """
    assignments = []
    
    # Try importing real dependencies
    try:
        from backend.routing import find_route
    except ImportError:
        # Fallback to the mock added in sys.modules during testing
        find_route = sys.modules['__main__'].mock_find_route
        
    try:
        from backend.graph import get_graph
        graph = get_graph()
    except ImportError:
        graph = None
        
    available_vehicles = [v for v in vehicles if v.get("status") == "available"]
    
    for incident in incidents:
        best_vehicle = None
        best_eta = float('inf')
        
        for v in available_vehicles:
            if v.get("status") != "available":
                continue
            
            origin = [v["lat"], v["lon"]]
            destination = [incident["lat"], incident["lon"]]
            vehicle_type = v.get("type", "ambulance")
            
            # Call Person A's find_route
            route_res = find_route(graph, origin, destination, vehicle_type)
            
            if route_res.get("status") == "ok":
                eta = route_res.get("eta_seconds", float('inf'))
                if eta < best_eta:
                    best_eta = eta
                    best_vehicle = v
        
        if best_vehicle is not None:
            assignments.append({
                "incident_id": incident["id"],
                "vehicle_id": best_vehicle["id"]
            })
            # Mark vehicle as unavailable for subsequent incidents
            best_vehicle["status"] = "assigned"
            
    return assignments


if __name__ == "__main__":
    # ---------------------------------------------------------
    # STANDALONE TEST
    # Proves the allocator picks the closest vehicle correctly.
    # ---------------------------------------------------------
    print("Running standalone test for assign_fleet...")
    
    # Simple mock that computes distance based on coordinates
    def mock_find_route(graph, origin, destination, vehicle_type):
        lat1, lon1 = origin
        lat2, lon2 = destination
        # Fake travel time based on euclidean distance (lower distance = lower eta)
        dist = ((lat2 - lat1)**2 + (lon2 - lon1)**2)**0.5
        eta = dist * 1000 # arbitrary multiplier
        return {
            "path": [origin, destination],
            "eta_seconds": eta,
            "status": "ok"
        }

    # Inject mock into sys.modules so assign_fleet can use it if real import fails
    sys.modules['__main__'].mock_find_route = mock_find_route

    fake_incidents = [
        {"id": "inc_1", "lat": 10.0, "lon": 10.0},
        {"id": "inc_2", "lat": 20.0, "lon": 20.0}
    ]

    fake_vehicles = [
        # Vehicle 1 is closest to incident 1
        {"id": "veh_1", "lat": 10.1, "lon": 10.1, "status": "available", "type": "ambulance"},
        # Vehicle 2 is busy
        {"id": "veh_2", "lat": 10.2, "lon": 10.2, "status": "busy", "type": "4x4"},
        # Vehicle 3 is closest to incident 2
        {"id": "veh_3", "lat": 19.9, "lon": 19.9, "status": "available", "type": "ambulance"},
        # Vehicle 4 is far away
        {"id": "veh_4", "lat": 50.0, "lon": 50.0, "status": "available", "type": "4x4"}
    ]

    print("Incidents:", fake_incidents)
    print("Vehicles before assignment:")
    for v in fake_vehicles:
        print(f"  {v['id']} at ({v['lat']}, {v['lon']}) - status: {v['status']}")
        
    result = assign_fleet(fake_incidents, fake_vehicles)
    
    print("\nAssignment Result:")
    for assignment in result:
        print(f"Incident {assignment['incident_id']} -> Vehicle {assignment['vehicle_id']}")
        
    print("\nVehicles after assignment:")
    for v in fake_vehicles:
        print(f"  {v['id']} status: {v['status']}")
        
    # Validation checks
    assert len(result) == 2, "Should assign exactly 2 vehicles"
    assert result[0]["incident_id"] == "inc_1" and result[0]["vehicle_id"] == "veh_1", "inc_1 should go to veh_1"
    assert result[1]["incident_id"] == "inc_2" and result[1]["vehicle_id"] == "veh_3", "inc_2 should go to veh_3"
    print("\nTest passed successfully!")
