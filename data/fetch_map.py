import osmnx as ox
import os

def fetch_and_save_map():
    target_point = (12.8700, 74.8400) # Mangaluru coords
    dist_meters = 8000 # 8km radius
    output_dir = os.path.join(os.path.dirname(__file__), "maps")
    output_file = os.path.join(output_dir, "mangaluru_drive.graphml")

    print(f"Fetching road network for Mangaluru ({dist_meters}m radius)...")
    
    # Ensure the output directory exists
    os.makedirs(output_dir, exist_ok=True)
    
    try:
        # Download the 'drive' network
        G = ox.graph_from_point(target_point, dist=dist_meters, network_type="drive")
        
        print(f"Successfully downloaded graph with {len(G.nodes)} nodes and {len(G.edges)} edges.")
        
        # Save the graph
        ox.save_graphml(G, filepath=output_file)
        print(f"Graph saved successfully to {output_file}")
    except Exception as e:
        print(f"Error fetching or saving the map: {e}")

if __name__ == "__main__":
    fetch_and_save_map()
