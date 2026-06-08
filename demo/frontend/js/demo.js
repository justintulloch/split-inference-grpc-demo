/**
 * demo.js — Starlink Reliability Demo orchestrator.
 *
 * Connects to the Hugging Face Spaces backend via WebSocket (with HTTP
 * JSON fallback if WS is unavailable), then drives:
 *   - GlobeRenderer  (3D satellite / flight visualisation)
 *   - ThroughputChart (Chart.js prediction chart)
 *   - Metric cards
 *   - Phase badge + event toast
 *   - Timeline cursor
 */

// ── Config ────────────────────────────────────────────────────────────────────
// Replace with your actual Hugging Face Space URL after deployment.
// e.g. "https://justintulloch-starlink-demo.hf.space"
const HF_BASE = "https://YOUR-HF-SPACE.hf.space";
const WS_URL  = HF_BASE.replace("https://", "wss://") + "/ws/stream";
const JSON_URL = HF_BASE + "/scenario";

// Total scenario ticks (must match scenarios.py)
const TOTAL_TICKS = 120;

// ── State ─────────────────────────────────────────────────────────────────────
let globe, throughputChart;
let ws = null;
let currentSpeed = 1;
let replayFrames = [];
let replayIndex  = 0;
let replayTimer  = null;
let toastTimer   = null;

// ── Init ──────────────────────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", () => {
  globe           = new GlobeRenderer("globe-canvas");
  throughputChart = new ThroughputChart("throughput-chart", 60);

  bindSpeedButtons();
  bindReplayButton();

  setStatus("connecting");
  connect();
});

// ── Connection ────────────────────────────────────────────────────────────────

function connect() {
  // Try WebSocket first for real-time streaming
  try {
    ws = new WebSocket(WS_URL);
    ws.onopen = () => {
      setStatus("connected");
      ws.send(JSON.stringify({ speed: currentSpeed }));
    };
    ws.onmessage = (e) => {
      const frame = JSON.parse(e.data);
      if (frame.done) {
        onScenarioDone();
        return;
      }
      replayFrames.push(frame);
      applyFrame(frame);
    };
    ws.onerror = () => {
      ws = null;
      fallbackToJSON();
    };
    ws.onclose = () => {};
  } catch {
    fallbackToJSON();
  }
}

async function fallbackToJSON() {
  setStatus("connecting");
  try {
    const res = await fetch(JSON_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    replayFrames = data.frames;
    setStatus("connected");
    startReplay(replayFrames, currentSpeed);
  } catch (err) {
    setStatus("error", "Backend unreachable");
    // Demo mode: generate synthetic frames in-browser so the UI still works
    replayFrames = generateSyntheticFrames();
    setStatus("connected");
    startReplay(replayFrames, currentSpeed);
  }
}

// ── Frame application ─────────────────────────────────────────────────────────

function applyFrame(frame) {
  const { tick, phase, true_throughput, predictions, features, event_label } = frame;

  // Globe
  globe.update({ phase, tick, totalTicks: TOTAL_TICKS });

  // Chart
  throughputChart.push(tick, true_throughput, predictions);

  // Metric cards
  setText("m-throughput", `${Math.max(0, true_throughput).toFixed(1)} <span class="unit">Mbps</span>`);
  setText("m-rtt",      `${(features.rtt_ms || 0).toFixed(0)} <span class="unit">ms</span>`);
  setText("m-jitter",   `${(features.jitter_ms || 0).toFixed(1)} <span class="unit">ms</span>`);
  setText("m-loss",     `${Math.max(0, features.packet_loss_pct || 0).toFixed(1)} <span class="unit">%</span>`);
  setText("m-signal",   `${(features.signal_strength_dbm || 0).toFixed(0)} <span class="unit">dBm</span>`);
  setText("m-elevation",`${(features.satellite_elevation_deg || 0).toFixed(0)} <span class="unit">°</span>`);

  // Predictions
  const maxMbps = 150;
  setText("pred-p50", `${predictions.p50.toFixed(1)} <span class="unit">Mbps</span>`);
  setText("pred-p90", `${predictions.p90.toFixed(1)} <span class="unit">Mbps</span>`);
  setText("pred-p95", `${predictions.p95.toFixed(1)} <span class="unit">Mbps</span>`);
  setBarWidth("bar-p50", (predictions.p50 / maxMbps) * 100);
  setBarWidth("bar-p90", (predictions.p90 / maxMbps) * 100);
  setBarWidth("bar-p95", (predictions.p95 / maxMbps) * 100);

  // Phase badge
  const badge = document.getElementById("phase-badge");
  badge.textContent = phase.charAt(0).toUpperCase() + phase.slice(1);
  badge.className   = `phase-badge ${phase}`;

  // Event toast
  if (event_label) showToast(event_label);

  // Timeline cursor
  const pct   = (tick / TOTAL_TICKS) * 100;
  const track  = document.querySelector(".timeline-track");
  const trackW = track ? track.clientWidth : 0;
  const cursorX = 12 + (trackW * pct / 100);
  document.getElementById("timeline-cursor").style.left = `${cursorX}px`;
  document.getElementById("timeline-tick").style.left   = `${cursorX}px`;
  document.getElementById("timeline-tick").textContent  = `${tick}s`;
}

// ── Replay (for JSON fallback / re-run) ───────────────────────────────────────

function startReplay(frames, speed) {
  clearInterval(replayTimer);
  replayIndex = 0;
  const delay = 1000 / speed;

  replayTimer = setInterval(() => {
    if (replayIndex >= frames.length) {
      clearInterval(replayTimer);
      onScenarioDone();
      return;
    }
    applyFrame(frames[replayIndex++]);
  }, delay);
}

function onScenarioDone() {
  document.getElementById("replay-btn").disabled = false;
  showToast("Scenario complete — press ↺ to replay");
}

// ── Speed controls ────────────────────────────────────────────────────────────

function bindSpeedButtons() {
  document.querySelectorAll(".speed-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      currentSpeed = parseFloat(btn.dataset.speed);
      document.querySelectorAll(".speed-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");

      // If replaying JSON frames, restart at current position with new speed
      if (replayFrames.length && !ws) {
        const remaining = replayFrames.slice(replayIndex);
        clearInterval(replayTimer);
        startReplay(remaining, currentSpeed);
      }

      // If WebSocket is open, signal new speed (server will restart)
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close();
        ws = null;
        throughputChart.reset();
        replayFrames = [];
        connect();
      }
    });
  });
}

// ── Replay button ─────────────────────────────────────────────────────────────

function bindReplayButton() {
  document.getElementById("replay-btn").addEventListener("click", () => {
    document.getElementById("replay-btn").disabled = true;
    throughputChart.reset();

    if (ws) {
      ws.close();
      ws = null;
    }
    clearInterval(replayTimer);
    replayFrames = [];
    replayIndex  = 0;

    setStatus("connecting");
    connect();
  });
}

// ── Synthetic frames (offline demo fallback) ──────────────────────────────────

function generateSyntheticFrames() {
  const frames = [];
  const phases = [
    { name: "normal",      ticks: 30, throughput: 85, rtt: 28, loss: 0.1, elev: 52 },
    { name: "degradation", ticks: 25, throughput: 85, rtt: 28, loss: 0.1, elev: 52 },
    { name: "outage",      ticks: 15, throughput: 1,  rtt: 280, loss: 65, elev: 6  },
    { name: "recovery",    ticks: 30, throughput: 1,  rtt: 280, loss: 65, elev: 8  },
    { name: "normal",      ticks: 20, throughput: 85, rtt: 28,  loss: 0.1, elev: 52 },
  ];

  let tick = 0;
  for (const ph of phases) {
    for (let s = 0; s < ph.ticks; s++) {
      const p = s / Math.max(ph.ticks - 1, 1);
      let thr, rtt, loss, elev;

      if (ph.name === "normal") {
        thr = ph.throughput + (Math.random() - 0.5) * 6;
        rtt = ph.rtt + (Math.random() - 0.5) * 4;
        loss = ph.loss + Math.random() * 0.1;
        elev = ph.elev + (Math.random() - 0.5) * 2;
      } else if (ph.name === "degradation") {
        thr  = 85 - p * 60 + (Math.random() - 0.5) * 6;
        rtt  = 28 + p * 90  + (Math.random() - 0.5) * 8;
        loss = 0.1 + p * 8  + Math.random() * 0.5;
        elev = 52 - p * 38  + (Math.random() - 0.5) * 2;
      } else if (ph.name === "outage") {
        thr  = 1.5 + (Math.random() - 0.5) * 1;
        rtt  = 280 + (Math.random() - 0.5) * 40;
        loss = 65  + (Math.random() - 0.5) * 10;
        elev = 6   + (Math.random() - 0.5) * 2;
      } else { // recovery
        thr  = 5 + p * 80  + (Math.random() - 0.5) * 5;
        rtt  = 280 - p * 255 + (Math.random() - 0.5) * 8;
        loss = 65 - p * 65  + Math.random() * 2;
        elev = 8 + p * 46   + (Math.random() - 0.5) * 2;
      }

      thr  = Math.max(0, thr);
      rtt  = Math.max(10, rtt);
      loss = Math.max(0, Math.min(100, loss));
      elev = Math.max(2, Math.min(90, elev));

      // Simple synthetic prediction (offset from actual)
      const p50 = Math.max(0, thr * 0.85 + (Math.random() - 0.5) * 4);
      const p90 = Math.max(p50, thr * 0.95 + (Math.random() - 0.5) * 3);
      const p95 = Math.max(p90, thr * 0.98 + (Math.random() - 0.5) * 2);

      let event_label = null;
      if (ph.name === "degradation" && s === 0) event_label = "Satellite elevation dropping";
      if (ph.name === "outage" && s === 0)      event_label = "⚠ Handoff failure — blackout";
      if (ph.name === "recovery" && s === 0)    event_label = "New satellite acquired";

      frames.push({
        tick,
        phase: ph.name,
        phase_progress: p,
        true_throughput: thr,
        predictions: {
          p50: Math.round(p50 * 100) / 100,
          p90: Math.round(p90 * 100) / 100,
          p95: Math.round(p95 * 100) / 100,
        },
        features: {
          throughput_mbps: thr,
          rtt_ms: rtt,
          jitter_ms: 2.5 + loss * 0.5,
          packet_loss_pct: loss,
          signal_strength_dbm: -68 - (100 - elev) * 0.25,
          satellite_elevation_deg: elev,
          handoff_flag: ph.name === "outage" ? 1 : 0,
        },
        event_label,
      });
      tick++;
    }
  }
  return frames;
}

// ── UI helpers ────────────────────────────────────────────────────────────────

function setText(id, html) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
}

function setBarWidth(id, pct) {
  const el = document.getElementById(id);
  if (el) el.style.width = `${Math.min(100, Math.max(0, pct)).toFixed(1)}%`;
}

function showToast(msg) {
  const toast = document.getElementById("event-toast");
  toast.textContent = msg;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 3500);
}

function setStatus(state, msg) {
  const pill = document.getElementById("status-pill");
  const text = document.getElementById("status-text");
  pill.className = `status-pill ${state}`;
  text.textContent = {
    connecting: "Connecting…",
    connected:  "Live",
    error:      msg || "Offline",
  }[state] || state;
}
