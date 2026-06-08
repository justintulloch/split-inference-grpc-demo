"""
Starlink in-flight scenario generator.

Produces realistic telemetry frames for a transatlantic flight:
  Phase 1 — Normal cruise (stable Starlink link)
  Phase 2 — Degradation (satellite elevation dropping, link weakening)
  Phase 3 — Outage (handoff failure, brief blackout)
  Phase 4 — Recovery (new satellite acquired, link restoring)

Each frame contains the 15 features the BitrateLSTM expects.
"""

import math
import random
from dataclasses import dataclass
from typing import Generator


@dataclass
class TelemetryFrame:
    tick: int                       # frame index (1 frame = ~1 second)
    phase: str                      # normal | degradation | outage | recovery
    phase_progress: float           # 0.0 → 1.0 within current phase
    features: list[float]           # 15 model input features
    true_throughput: float          # ground truth for display
    event_label: str | None         # human-readable annotation if notable


def _clamp(v, lo, hi):
    return max(lo, min(hi, v))


def _noisy(base, std, lo=None, hi=None):
    v = base + random.gauss(0, std)
    if lo is not None or hi is not None:
        v = _clamp(v, lo or -1e9, hi or 1e9)
    return v


def generate_scenario(
    seed: int = 42,
    fps: float = 1.0,          # frames per second (1 = real-time, 10 = fast replay)
) -> Generator[TelemetryFrame, None, None]:
    """
    Yields TelemetryFrame objects for the full Starlink in-flight scenario.
    Designed for ~120 seconds total (adjustable via phase durations below).
    """
    random.seed(seed)

    # Phase durations in ticks (seconds at fps=1)
    phases = [
        ("normal",      30),
        ("degradation", 25),
        ("outage",      15),
        ("recovery",    30),
        ("normal",      20),   # second stable window after recovery
    ]

    tick = 0
    history = {
        "throughput": [],
        "rtt": [],
        "packet_loss": [],
    }

    for phase_name, duration in phases:
        for step in range(duration):
            progress = step / max(duration - 1, 1)

            # ── Base telemetry per phase ──────────────────────────────────────

            if phase_name == "normal":
                throughput     = _noisy(85.0, 3.0, 40, 150)
                rtt            = _noisy(28.0, 2.0, 18, 60)
                jitter         = _noisy(2.5,  0.5, 0.5, 8)
                packet_loss    = _noisy(0.1,  0.05, 0, 1)
                signal_dbm     = _noisy(-68.0, 1.5, -90, -50)
                elevation_deg  = _noisy(52.0, 1.0, 30, 90)
                handoff_flag   = 0.0
                since_handoff  = float(tick % 45)

            elif phase_name == "degradation":
                # Elevation dropping as satellite moves toward horizon
                elevation_deg  = _noisy(52.0 - progress * 38, 1.5, 8, 90)
                throughput     = _noisy(85.0 - progress * 60, 4.0, 5, 150)
                rtt            = _noisy(28.0 + progress * 90, 5.0, 18, 300)
                jitter         = _noisy(2.5  + progress * 18, 2.0, 0.5, 40)
                packet_loss    = _noisy(0.1  + progress * 8,  0.5, 0, 20)
                signal_dbm     = _noisy(-68.0 - progress * 18, 2.0, -95, -50)
                handoff_flag   = 1.0 if progress > 0.8 else 0.0
                since_handoff  = 0.0 if handoff_flag else float(tick % 45)

            elif phase_name == "outage":
                # Full blackout — near-zero throughput, very high RTT/loss
                throughput     = _noisy(1.5,  1.0, 0, 8)
                rtt            = _noisy(280.0, 30.0, 80, 600)
                jitter         = _noisy(45.0, 10.0, 5, 120)
                packet_loss    = _noisy(65.0, 10.0, 10, 100)
                signal_dbm     = _noisy(-92.0, 2.0, -100, -80)
                elevation_deg  = _noisy(6.0,  2.0, 2, 20)
                handoff_flag   = 1.0
                since_handoff  = float(step)

            elif phase_name == "recovery":
                # New satellite acquired, link climbing back
                throughput     = _noisy(5.0  + progress * 80, 5.0, 0, 150)
                rtt            = _noisy(280.0 - progress * 255, 8.0, 18, 400)
                jitter         = _noisy(45.0 - progress * 43, 3.0, 0.5, 80)
                packet_loss    = _noisy(65.0 - progress * 65, 4.0, 0, 100)
                signal_dbm     = _noisy(-92.0 + progress * 25, 2.0, -100, -50)
                elevation_deg  = _noisy(8.0  + progress * 46, 2.0, 5, 90)
                handoff_flag   = 0.0
                since_handoff  = float(step)

            else:
                throughput = rtt = jitter = packet_loss = 0.0
                signal_dbm = elevation_deg = handoff_flag = since_handoff = 0.0

            # ── Rolling history for lag / rolling features ────────────────────
            history["throughput"].append(throughput)
            history["rtt"].append(rtt)
            history["packet_loss"].append(packet_loss)

            def _lag(key, n):
                h = history[key]
                return h[-n] if len(h) >= n else h[0]

            def _rolling(key, n, fn):
                h = history[key][-n:]
                return fn(h)

            # ── Build the 15-feature vector ───────────────────────────────────
            features = [
                throughput,                                          # 0
                _lag("throughput", 2),                              # 1 lag1
                _lag("throughput", 3),                              # 2 lag2
                rtt,                                                # 3
                _lag("rtt", 2),                                     # 4 lag1
                jitter,                                             # 5
                packet_loss,                                        # 6
                _lag("packet_loss", 2),                             # 7 lag1
                signal_dbm,                                         # 8
                elevation_deg,                                      # 9
                handoff_flag,                                       # 10
                since_handoff,                                      # 11
                _rolling("throughput", 10, lambda h: sum(h)/len(h)),# 12 rolling mean
                _rolling("throughput", 10, lambda h: (            # 13 rolling std
                    math.sqrt(sum((x - sum(h)/len(h))**2 for x in h) / len(h))
                )),
                _rolling("rtt", 10, lambda h: sum(h)/len(h)),      # 14 rtt rolling mean
            ]

            # ── Event labels for UI annotations ──────────────────────────────
            label = None
            if phase_name == "degradation" and step == 0:
                label = "Satellite elevation dropping"
            elif phase_name == "degradation" and progress > 0.8 and handoff_flag:
                label = "Initiating handoff"
            elif phase_name == "outage" and step == 0:
                label = "⚠ Handoff failure — blackout"
            elif phase_name == "recovery" and step == 0:
                label = "New satellite acquired"
            elif phase_name == "recovery" and step == duration - 1:
                label = "Link fully restored"

            yield TelemetryFrame(
                tick=tick,
                phase=phase_name,
                phase_progress=progress,
                features=features,
                true_throughput=throughput,
                event_label=label,
            )

            tick += 1
