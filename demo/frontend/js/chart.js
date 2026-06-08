/* global Chart */

/**
 * ThroughputChart — real-time Chart.js line chart showing:
 *   - Actual throughput (white)
 *   - p50 prediction (sky blue)
 *   - p90 prediction (indigo)
 *   - p95 prediction (pink)
 */

class ThroughputChart {
  constructor(canvasId, maxPoints = 60) {
    this.maxPoints = maxPoints;
    this.labels    = [];
    this.actual    = [];
    this.p50       = [];
    this.p90       = [];
    this.p95       = [];

    const ctx = document.getElementById(canvasId).getContext("2d");

    this.chart = new Chart(ctx, {
      type: "line",
      data: {
        labels: this.labels,
        datasets: [
          {
            label:           "Actual",
            data:            this.actual,
            borderColor:     "rgba(255,255,255,0.55)",
            borderWidth:     2,
            pointRadius:     0,
            tension:         0.3,
            fill:            false,
          },
          {
            label:           "p50",
            data:            this.p50,
            borderColor:     "#38bdf8",
            borderWidth:     1.5,
            borderDash:      [4, 3],
            pointRadius:     0,
            tension:         0.3,
            fill:            false,
          },
          {
            label:           "p90",
            data:            this.p90,
            borderColor:     "#818cf8",
            borderWidth:     1.5,
            borderDash:      [4, 3],
            pointRadius:     0,
            tension:         0.3,
            fill:            false,
          },
          {
            label:           "p95",
            data:            this.p95,
            borderColor:     "#f472b6",
            borderWidth:     1.5,
            borderDash:      [4, 3],
            pointRadius:     0,
            tension:         0.3,
            fill:            false,
          },
        ],
      },
      options: {
        responsive:          true,
        maintainAspectRatio: false,
        animation:           { duration: 0 },
        interaction:         { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: "rgba(10,14,26,0.9)",
            titleColor:      "#94a3b8",
            bodyColor:       "#e2e8f0",
            borderColor:     "rgba(255,255,255,0.07)",
            borderWidth:     1,
            callbacks: {
              label: (ctx) => ` ${ctx.dataset.label}: ${Number(ctx.raw).toFixed(1)} Mbps`,
            },
          },
        },
        scales: {
          x: {
            ticks: {
              color:    "#475569",
              maxTicksLimit: 8,
              font: { size: 10 },
            },
            grid: {
              color: "rgba(255,255,255,0.04)",
              drawBorder: false,
            },
          },
          y: {
            min:  0,
            max:  160,
            ticks: {
              color:    "#475569",
              font:     { size: 10 },
              callback: (v) => v + " Mb",
            },
            grid: {
              color: "rgba(255,255,255,0.04)",
              drawBorder: false,
            },
          },
        },
      },
    });
  }

  push(tick, throughput, predictions) {
    const label = `${tick}s`;

    this.labels.push(label);
    this.actual.push(Math.max(0, throughput));
    this.p50.push(predictions.p50);
    this.p90.push(predictions.p90);
    this.p95.push(predictions.p95);

    if (this.labels.length > this.maxPoints) {
      this.labels.shift();
      this.actual.shift();
      this.p50.shift();
      this.p90.shift();
      this.p95.shift();
    }

    this.chart.update("none");
  }

  reset() {
    this.labels.length = 0;
    this.actual.length = 0;
    this.p50.length    = 0;
    this.p90.length    = 0;
    this.p95.length    = 0;
    this.chart.update();
  }
}

window.ThroughputChart = ThroughputChart;
