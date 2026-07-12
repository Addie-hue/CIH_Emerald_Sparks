import math

# { road_id: current_depth_cm }
current_floods = {}

def depth_to_multiplier(depth_cm, vehicle_type):
    """
    0-15cm   -> 1.0x to 1.5x
    15-30cm  -> 3x to 6x
    30-60cm  -> infinite (blocked) if vehicle_type == "ambulance", high-cost-but-passable (e.g. 10x) if vehicle_type == "4x4"
    60cm+    -> infinite (blocked) for ALL vehicle types
    """
    if depth_cm < 0:
        depth_cm = 0
        
    if 0 <= depth_cm <= 15:
        # Interpolate between 1.0 and 1.5
        return 1.0 + (depth_cm / 15.0) * 0.5
    elif 15 < depth_cm <= 30:
        # Interpolate between 3.0 and 6.0
        return 3.0 + ((depth_cm - 15.0) / 15.0) * 3.0
    elif 30 < depth_cm < 60:
        if vehicle_type == "ambulance":
            return float('inf')
        elif vehicle_type == "4x4":
            return 10.0
        else:
            return float('inf')
    else:
        # 60cm+
        return float('inf')

def update_flood(road_id, depth_cm, timestamp=None):
    """
    Updates the dictionary AND directly mutates the matching edge's weight on the graph object
    using the multiplier.
    """
    from backend.graph import get_graph
    try:
        graph = get_graph()
    except RuntimeError:
        return
        
    current_floods[road_id] = depth_cm
    
    mult_amb = depth_to_multiplier(depth_cm, "ambulance")
    mult_4x4 = depth_to_multiplier(depth_cm, "4x4")
    
    if ',' in str(road_id):
        try:
            lat_str, lon_str = str(road_id).split(',')
            lat, lon = float(lat_str), float(lon_str)
            import math
            
            def haversine(lat1, lon1, lat2, lon2):
                R = 6371000
                phi1, phi2 = math.radians(lat1), math.radians(lat2)
                dphi = math.radians(lat2 - lat1)
                dlam = math.radians(lon2 - lon1)
                a = math.sin(dphi/2)**2 + math.cos(phi1)*math.cos(phi2)*math.sin(dlam/2)**2
                return 2 * R * math.atan2(math.sqrt(a), math.sqrt(1-a))
            
            close_nodes = set()
            for n, ndata in graph.nodes(data=True):
                n_lat, n_lon = ndata.get('y'), ndata.get('x')
                if n_lat is not None and n_lon is not None:
                    if haversine(lat, lon, n_lat, n_lon) <= 70:
                        close_nodes.add(n)
                        
            if not close_nodes and depth_cm > 0:
                if depth_cm == 999:
                    return "Invalid location for a landslide zone"
                return "Cannot place a hazard here — no road at this location"
            
            for u, v, key, data in graph.edges(keys=True, data=True):
                if u in close_nodes or v in close_nodes:
                    if 'base_weight' not in data:
                        data['base_weight'] = data.get('travel_time', data.get('length', 1.0))
                    data['weight_ambulance'] = data['base_weight'] * mult_amb
                    data['weight_4x4'] = data['base_weight'] * mult_4x4
        except Exception as e:
            print(f"Error updating nearest edge for {road_id}: {e}")
        return

    for u, v, k, data in graph.edges(keys=True, data=True):
        is_match = False
        osmid = data.get("osmid")
        
        # osmid can be a list if multiple osm ways are simplified into one edge
        if isinstance(osmid, list):
            if road_id in osmid or str(road_id) in [str(x) for x in osmid]:
                is_match = True
        else:
            if str(osmid) == str(road_id):
                is_match = True
                
        # Also check custom 'id' or 'road_id' just in case
        if str(data.get("id")) == str(road_id) or str(data.get("road_id")) == str(road_id):
            is_match = True
            
        if is_match:
            if 'base_weight' not in data:
                # Default base weight if not already stored
                data['base_weight'] = data.get('travel_time', data.get('length', 1.0))
            
            data['weight_ambulance'] = data['base_weight'] * mult_amb
            data['weight_4x4'] = data['base_weight'] * mult_4x4
