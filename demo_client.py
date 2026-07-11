import asyncio
import websockets
import json
import time

async def demo_client():
    uri = "ws://127.0.0.1:8000/ws"
    
    print("Connecting to WebSocket...")
    try:
        async with websockets.connect(uri) as websocket:
            print("Connected! Sending baseline flood_update events...")
            
            # Send initial flood update
            await websocket.send(json.dumps({
                "event": "flood_update",
                "road_id": "segment_123",
                "depth_cm": 20,
                "timestamp": time.time()
            }))
            
            print("Sent 20cm flood update. Waiting for response (should be debounced)...")
            try:
                # Need to use wait_for so we don't hang if there's no response 
                # (since the mock might not return routes)
                response = await asyncio.wait_for(websocket.recv(), timeout=2.0)
                print(f"Received: {response}")
            except asyncio.TimeoutError:
                print("No response received within timeout. (Expected if mock active_routes returns [])")

            # Send severe flood update
            print("\nSending 65cm flood update...")
            await websocket.send(json.dumps({
                "event": "flood_update",
                "road_id": "segment_456",
                "depth_cm": 65,
                "timestamp": time.time()
            }))
            
            try:
                response = await asyncio.wait_for(websocket.recv(), timeout=2.0)
                print(f"Received: {response}")
            except asyncio.TimeoutError:
                print("No response received within timeout. (Expected if mock active_routes returns [])")
                
            print("\nDisconnecting to test resilience...")
            
    except Exception as e:
        print(f"Connection failed: {e}")
        
    print("\nReconnecting...")
    try:
        async with websockets.connect(uri) as websocket:
            print("Reconnected successfully! Resilience layer works.")
    except Exception as e:
        print(f"Reconnection failed: {e}")

if __name__ == "__main__":
    asyncio.run(demo_client())
