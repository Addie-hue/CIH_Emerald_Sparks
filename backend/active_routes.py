from backend.routing import find_route

# { vehicle_id: { "current_path": [[lat,lon],...], "current_position": [lat,lon], "destination": [lat,lon], "vehicle_type": "ambulance"|"4x4", "status": "ok", "current_path_cost": float } }
active_vehicles = {}

_node_cache = {}

def get_node_id_cached(graph, lat, lon):
    # Use rounded lat/lon to handle floating point precision issues
    key = (round(lat, 5), round(lon, 5))
    if key in _node_cache:
        return _node_cache[key]
    
    best_n = None
    min_dist = float('inf')
    for n, data in graph.nodes(data=True):
        if 'y' in data and 'x' in data:
            dist = abs(data['y'] - lat) + abs(data['x'] - lon)
            if dist < min_dist:
                min_dist = dist
                best_n = n
                
    if min_dist < 0.00001:
        _node_cache[key] = best_n
        return best_n
    return None

def get_edge_weight(graph, u, v, vehicle_type):
    if not graph.has_edge(u, v):
        return float('inf')
    
    edge_data_dict = graph[u][v]
    min_cost = float('inf')
    weight_attr = 'weight_ambulance' if vehicle_type == 'ambulance' else 'weight_4x4'
    
    for key, data in edge_data_dict.items():
        cost = data.get(weight_attr, data.get('travel_time', data.get('length', 1.0)))
        if cost < min_cost:
            min_cost = cost
    return min_cost

def update_vehicle_state(vehicle_id, position, path, destination, vehicle_type="ambulance"):
    active_vehicles[vehicle_id] = {
        'current_position': position,
        'current_path': path,
        'destination': destination,
        'vehicle_type': vehicle_type,
        'status': 'ok',
        'current_path_cost': 0.0 # Could calculate based on path, but we rely on front-end for now
    }

def recheck_all_active_routes():
    """
    Called AFTER any flood update.
    For every active vehicle, check if any road on its current path just became blocked or much more costly.
    If so, call Person A's find_route() FROM THE VEHICLE'S CURRENT POSITION to its original destination.
    """
    from backend.graph import get_graph
    try:
        graph = get_graph()
    except RuntimeError:
        return []

    updated_routes = []

    for vehicle_id, info in active_vehicles.items():
        if info.get('status') == 'stranded':
            continue
            
        current_path = info.get('current_path', [])
        if not current_path or len(current_path) < 2:
            continue
            
        vehicle_type = info.get('vehicle_type', 'ambulance')
        
        path_blocked_or_costly = False
        current_cost = 0.0
        
        nodes = []
        for point in current_path:
            lat, lon = point[0], point[1]
            nid = get_node_id_cached(graph, lat, lon)
            if nid is not None:
                nodes.append(nid)
                
        if len(nodes) == len(current_path):
            for i in range(len(nodes) - 1):
                u = nodes[i]
                v = nodes[i+1]
                edge_cost = get_edge_weight(graph, u, v, vehicle_type)
                if edge_cost == float('inf'):
                    path_blocked_or_costly = True
                    break
                current_cost += edge_cost
                
            old_cost = info.get('current_path_cost', 0)
            if not path_blocked_or_costly and old_cost > 0 and current_cost > old_cost * 1.5:
                path_blocked_or_costly = True
        else:
            path_blocked_or_costly = True
            
        if path_blocked_or_costly:
            route_res = find_route(graph, info['current_position'], info['destination'], vehicle_type)
            
            if route_res.get('status') == 'ok' and route_res.get('path'):
                info['current_path'] = route_res['path']
                info['status'] = 'ok'
                info['current_path_cost'] = route_res.get('eta_seconds', current_cost)
            else:
                info['status'] = 'stranded'
                info['current_path'] = []
                info['current_path_cost'] = 0.0
                
            updated_routes.append({
                "vehicle_id": vehicle_id,
                "path": info['current_path'],
                "eta_seconds": info['current_path_cost'],
                "status": info['status']
            })
            
    return updated_routes
