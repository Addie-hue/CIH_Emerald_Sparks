import osmnx as ox
import os

def fetch_and_save_map():
    # Mangalore bounding box covering all areas
    north, south, east, west = 13.05, 12.75, 74.95, 74.75
    output_dir = os.path.join(os.path.dirname(__file__), "maps")
    output_file = os.path.join(output_dir, "mangaluru_drive.graphml")

    print(f"Fetching road network for Mangaluru bounding box...")
    
    # Ensure the output directory exists
    os.makedirs(output_dir, exist_ok=True)
    
    import osmnx.settings
    osmnx.settings.timeout = 1200 # 20 minutes timeout
    osmnx.settings.overpass_endpoint = "https://lz4.overpass-api.de/api"
    
    try:
        # Download the 'drive' network using bounding box
        G = ox.graph_from_bbox(bbox=(north, south, east, west), network_type="drive")
        
        print(f"Successfully downloaded graph with {len(G.nodes)} nodes and {len(G.edges)} edges.")
        
        # Save the graph
        ox.save_graphml(G, filepath=output_file)
        print(f"Graph saved successfully to {output_file}")
    except Exception as e:
        print(f"Error fetching or saving the map: {e}")

if __name__ == "__main__":
    fetch_and_save_map()
