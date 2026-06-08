"""
FastAPI inference server — runs on Hugging Face Spaces (free tier).

Endpoints:
  GET  /            Health check
  GET  /scenario    Full scenario as JSON (for GitHub Pages fetch)
  WS   /ws/stream   WebSocket: streams frames in real-time with model predictions
"""

import asyncio
import json
import os
from contextlib import asynccontextmanager

import torch
import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from model import BitrateLSTM, load_model, QUANTILES, FEATURE_NAMES
from scenarios import generate_scenario, TelemetryFrame


# ── Model loading ─────────────────────────────────────────────────────────────

MODEL_PATH = os.environ.get("MODEL_PATH", "quantized_higgs_model.pth")
model: BitrateLSTM | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global model
    if os.path.exists(MODEL_PATH):
        model = load_model(MODEL_PATH)
        print(f"[server] Model loaded from {MODEL_PATH}")
    else:
        # Hugging Face Spaces — model uploaded as Space file
        print(f"[server] Model file not found at {MODEL_PATH}, using random weights")
        model = BitrateLSTM()
        model.eval()
    yield


# ── App setup ─────────────────────────────────────────────────────────────────

app = FastAPI(title="Starlink Reliability Demo", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],          # GitHub Pages can call us
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Normalisation helpers ─────────────────────────────────────────────────────
# Approximate feature statistics from Higgs dataset training range.
# If you have the original stats.json, replace these values.

FEATURE_MEANS = [
    60.0,   # throughput_mbps
    60.0,   # throughput_lag1
    60.0,   # throughput_lag2
    50.0,   # rtt_ms
    50.0,   # rtt_lag1
    5.0,    # jitter_ms
    2.0,    # packet_loss_pct
    2.0,    # packet_loss_lag1
    -75.0,  # signal_strength_dbm
    40.0,   # satellite_elevation_deg
    0.1,    # handoff_flag
    20.0,   # time_since_handoff_s
    60.0,   # throughput_rolling_mean
    10.0,   # throughput_rolling_std
    50.0,   # rtt_rolling_mean
]

FEATURE_STDS = [
    30.0, 30.0, 30.0,   # throughput family
    40.0, 40.0,          # rtt family
    8.0,                 # jitter
    5.0, 5.0,            # packet_loss family
    12.0,                # signal
    20.0,                # elevation
    0.3,                 # handoff flag
    15.0,                # since_handoff
    30.0, 15.0,          # rolling throughput
    40.0,                # rolling rtt
]


def normalise(features: list[float]) -> torch.Tensor:
    arr = np.array(features, dtype=np.float32)
    means = np.array(FEATURE_MEANS, dtype=np.float32)
    stds = np.array(FEATURE_STDS, dtype=np.float32)
    normed = (arr - means) / (stds + 1e-8)
    # shape: (1, 1, 15) — batch=1, seq_len=1, features=15
    return torch.tensor(normed, dtype=torch.float32).unsqueeze(0).unsqueeze(0)


def run_inference(frame: TelemetryFrame) -> dict:
    """Run one frame through the model, return p50/p90/p95 predictions."""
    assert model is not None
    with torch.no_grad():
        x = normalise(frame.features)
        preds, _ = model(x)
        raw = preds.squeeze().tolist()

    # Model outputs are in normalised space — denormalise back to Mbps
    # Using throughput mean/std (index 0)
    mean, std = FEATURE_MEANS[0], FEATURE_STDS[0]

    def denorm(v):
        # Clamp to plausible range after denormalisation
        return max(0.0, min(200.0, float(v) * std + mean))

    # Ensure ordering: p50 ≤ p90 ≤ p95
    p50 = denorm(raw[0] if isinstance(raw, list) else raw)
    p90 = denorm(raw[1] if isinstance(raw, list) else raw)
    p95 = denorm(raw[2] if isinstance(raw, list) else raw)

    # Sort to maintain quantile ordering
    p50, p90, p95 = sorted([p50, p90, p95])

    return {"p50": round(p50, 2), "p90": round(p90, 2), "p95": round(p95, 2)}


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/")
def health():
    return {
        "status": "ok",
        "model_loaded": model is not None,
        "features": FEATURE_NAMES,
        "outputs": QUANTILES,
    }


@app.get("/scenario")
def full_scenario():
    """
    Return the entire scenario pre-computed as JSON.
    GitHub Pages fetches this once on load for the non-streaming fallback.
    """
    frames = []
    for frame in generate_scenario(seed=42):
        preds = run_inference(frame)
        frames.append({
            "tick": frame.tick,
            "phase": frame.phase,
            "phase_progress": round(frame.phase_progress, 3),
            "true_throughput": round(frame.true_throughput, 2),
            "event_label": frame.event_label,
            "features": {
                name: round(val, 3)
                for name, val in zip(FEATURE_NAMES, frame.features)
            },
            "predictions": preds,
        })
    return {"frames": frames, "total": len(frames)}


@app.websocket("/ws/stream")
async def stream_scenario(websocket: WebSocket):
    """
    Stream frames in real-time over WebSocket.
    Client sends {"speed": 2} to control playback speed (1x, 2x, 5x).
    """
    await websocket.accept()
    speed = 1.0

    try:
        # Read optional config from client
        try:
            msg = await asyncio.wait_for(websocket.receive_text(), timeout=0.5)
            cfg = json.loads(msg)
            speed = float(cfg.get("speed", 1.0))
        except (asyncio.TimeoutError, Exception):
            pass

        delay = 1.0 / speed   # seconds between frames

        for frame in generate_scenario(seed=42):
            preds = run_inference(frame)

            payload = {
                "tick": frame.tick,
                "phase": frame.phase,
                "phase_progress": round(frame.phase_progress, 3),
                "true_throughput": round(frame.true_throughput, 2),
                "event_label": frame.event_label,
                "predictions": preds,
                "features": {
                    "throughput_mbps":       round(frame.features[0], 2),
                    "rtt_ms":                round(frame.features[3], 2),
                    "jitter_ms":             round(frame.features[5], 2),
                    "packet_loss_pct":       round(frame.features[6], 2),
                    "signal_strength_dbm":   round(frame.features[8], 2),
                    "satellite_elevation_deg": round(frame.features[9], 2),
                    "handoff_flag":          frame.features[10],
                },
            }

            await websocket.send_text(json.dumps(payload))
            await asyncio.sleep(delay)

        # Signal end of scenario
        await websocket.send_text(json.dumps({"done": True}))

    except WebSocketDisconnect:
        pass
