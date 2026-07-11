import uvicorn
from fastapi import FastAPI
from backend.realtime import router as realtime_router

app = FastAPI(title="Emerald Sparks Demo Server")

# Include the websocket router
app.include_router(realtime_router)

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)
