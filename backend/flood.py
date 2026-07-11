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
            import osmnx as ox
            # Nearest edges returns u, v, key
            edge = ox.nearest_edges(graph, X=lon, Y=lat)
            if edge:
                u, v, key = edge
                data = graph[u][v][key]
                if 'base_weight' not in data:
                    data['base_weight'] = data.get('travel_time', data.get('length', 1.0))
                data['weight_ambulance'] = data['base_weight'] * mult_amb
                data['weight_4x4'] = data['base_weight'] * mult_4x4
                
                # Block reverse direction too
                if graph.has_edge(v, u, key):
                    data_rev = graph[v][u][key]
                    if 'base_weight' not in data_rev:
                        data_rev['base_weight'] = data_rev.get('travel_time', data_rev.get('length', 1.0))
                    data_rev['weight_ambulance'] = data_rev['base_weight'] * mult_amb
                    data_rev['weight_4x4'] = data_rev['base_weight'] * mult_4x4
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
