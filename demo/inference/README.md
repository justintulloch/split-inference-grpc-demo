---
title: Starlink Reliability Predictor — Inference API
emoji: 🛰️
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 7860
pinned: false
---

# Starlink Reliability Predictor — Inference API

FastAPI + PyTorch backend for the Starlink demo.

Serves real-time predictions from `quantized_higgs_model.pth` (BitrateLSTM, qint8).

**Endpoints:**
- `GET /` — health check
- `GET /scenario` — full pre-computed scenario JSON
- `WS /ws/stream` — real-time frame streaming
