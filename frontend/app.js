const presets = {
  default: "NVDA, AAPL, AMZN, JPM, COST, UNH, TLT",
  defensive: "COST, UNH, JNJ, PG, XLU, TLT, IEF",
  growth: "NVDA, MSFT, AAPL, AMZN, GOOGL, META, TLT",
};

let activeResult = null;
let progressTimer = null;

const elements = {
  tickers: document.querySelector("#tickers"),
  startDate: document.querySelector("#startDate"),
  endDate: document.querySelector("#endDate"),
  benchmark: document.querySelector("#benchmark"),
  minWeight: document.querySelector("#minWeight"),
  minWeightValue: document.querySelector("#minWeightValue"),
  trainingWindow: document.querySelector("#trainingWindow"),
  rebalanceFreq: document.querySelector("#rebalanceFreq"),
  linkageMethod: document.querySelector("#linkageMethod"),
  runAnalysis: document.querySelector("#runAnalysis"),
  runStatus: document.querySelector("#runStatus span:last-child"),
  errorPanel: document.querySelector("#errorPanel"),
};

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function formatPct(value, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return `${(value * 100).toFixed(digits)}%`;
}

function formatNumber(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return value.toFixed(digits);
}

function formatMoney(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return `$${value.toFixed(2)}`;
}

function pctClass(value) {
  if (value > 0) return "positive";
  if (value < 0) return "negative";
  return "neutral";
}

function setText(id, value) {
  document.querySelector(`#${id}`).textContent = value;
}

function setStep(step) {
  document.querySelectorAll(".progress-step").forEach((node) => {
    node.classList.toggle("active", node.dataset.step === step);
  });
}

function setStatus(text) {
  elements.runStatus.textContent = text;
}

function showError(message) {
  elements.errorPanel.textContent = message;
  elements.errorPanel.classList.remove("hidden");
}

function clearError() {
  elements.errorPanel.textContent = "";
  elements.errorPanel.classList.add("hidden");
}

function collectPayload() {
  return {
    tickers: elements.tickers.value,
    startDate: elements.startDate.value,
    endDate: elements.endDate.value,
    benchmark: elements.benchmark.value,
    minWeight: Number(elements.minWeight.value) / 100,
    trainingWindow: Number(elements.trainingWindow.value),
    rebalanceFreq: Number(elements.rebalanceFreq.value),
    linkageMethod: elements.linkageMethod.value,
  };
}

function startProgress() {
  const steps = ["data", "hrp", "backtest", "report"];
  let index = 0;
  setStep(steps[index]);
  progressTimer = setInterval(() => {
    index = Math.min(index + 1, steps.length - 1);
    setStep(steps[index]);
  }, 850);
}

function stopProgress() {
  clearInterval(progressTimer);
  setStep("report");
}

async function runAnalysis() {
  clearError();
  elements.runAnalysis.disabled = true;
  setStatus("Running");
  startProgress();

  try {
    const response = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(collectPayload()),
    });

    const data = await response.json();

    if (!data.ok) {
      throw new Error(data.error || "Analysis failed.");
    }

    activeResult = data.result;
    renderDashboard(activeResult);
    setStatus("Complete");
  } catch (error) {
    showError(error.message);
    setStatus("Needs attention");
  } finally {
    stopProgress();
    elements.runAnalysis.disabled = false;
  }
}

function renderDashboard(result) {
  const strategy = result.metrics.strategy;
  setText("latestDate", result.config.latestDate);
  setText("totalReturn", formatPct(strategy.totalReturn));
  setText("maxDrawdown", formatPct(strategy.maxDrawdown));
  setText("sharpeRatio", formatNumber(strategy.sharpe));
  setText("downsideCapture", formatPct(result.metrics.downsideCapture));
  setText("largestWeight", formatPct(result.metrics.largestWeight));
  setText("effectivePositions", formatNumber(result.metrics.effectivePositions, 1));
  setText("upsideCapture", formatPct(result.metrics.upsideCapture));
  setText("clusterCount", String(result.clusterCount));

  drawLineChart("equityChart", result.series.equity, [
    { key: "strategy", label: "HRP", color: "#1f6feb" },
    { key: "benchmark", label: result.config.benchmark, color: "#64748b" },
  ]);
  drawLineChart("drawdownChart", result.series.drawdown, [
    { key: "strategy", label: "HRP", color: "#c2413b" },
    { key: "benchmark", label: result.config.benchmark, color: "#64748b" },
  ]);
  drawAllocation(result.weights);
  drawWeightsTable(result.weights);
  drawEvents(result.events);
  drawMonthlyTable(result.monthlyLeaders);
  drawHeatmap(result.risk.correlation);
  drawVolatility(result.risk.volatility);
  drawMarket(result.market);
}

function valueExtent(series, lines) {
  const values = [];
  series.forEach((point) => {
    lines.forEach((line) => {
      if (point[line.key] !== null && point[line.key] !== undefined) {
        values.push(point[line.key]);
      }
    });
  });
  return [Math.min(...values), Math.max(...values)];
}

function drawLineChart(containerId, series, lines) {
  const container = document.querySelector(`#${containerId}`);
  if (!series.length) {
    container.innerHTML = "<p>No chart data returned.</p>";
    return;
  }

  const width = 900;
  const height = 342;
  const padding = { top: 24, right: 26, bottom: 34, left: 52 };
  const [minValue, maxValue] = valueExtent(series, lines);
  const span = maxValue - minValue || 1;

  const x = (index) =>
    padding.left + (index / Math.max(series.length - 1, 1)) * (width - padding.left - padding.right);
  const y = (value) =>
    padding.top + (1 - (value - minValue) / span) * (height - padding.top - padding.bottom);

  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map((ratio) => {
      const yPos = padding.top + ratio * (height - padding.top - padding.bottom);
      const value = maxValue - ratio * span;
      return `
        <line x1="${padding.left}" y1="${yPos}" x2="${width - padding.right}" y2="${yPos}" stroke="#e5e7eb" />
        <text x="10" y="${yPos + 4}" class="axis-label">${containerId === "drawdownChart" ? formatPct(value, 0) : formatNumber(value, 1)}</text>
      `;
    })
    .join("");

  const paths = lines
    .map((line) => {
      const points = series
        .map((point, index) => `${index === 0 ? "M" : "L"} ${x(index)} ${y(point[line.key])}`)
        .join(" ");
      return `<path d="${points}" fill="none" stroke="${line.color}" stroke-width="3" />`;
    })
    .join("");

  const legend = lines
    .map((line, index) => {
      const xPos = padding.left + index * 104;
      return `
        <rect x="${xPos}" y="8" width="12" height="12" fill="${line.color}" rx="2"></rect>
        <text x="${xPos + 18}" y="19" class="chart-label">${line.label}</text>
      `;
    })
    .join("");

  const firstDate = series[0].date;
  const lastDate = series[series.length - 1].date;

  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img">
      ${grid}
      ${paths}
      ${legend}
      <text x="${padding.left}" y="${height - 8}" class="axis-label">${firstDate}</text>
      <text x="${width - padding.right - 78}" y="${height - 8}" class="axis-label">${lastDate}</text>
    </svg>
  `;
}

function drawAllocation(weights) {
  const container = document.querySelector("#allocationChart");
  const maxWeight = Math.max(...weights.map((row) => row.weight));

  container.innerHTML = weights
    .map((row) => {
      const width = (row.weight / maxWeight) * 100;
      return `
        <div class="allocation-row">
          <strong>${row.ticker}</strong>
          <div class="bar-track">
            <div class="bar-fill ${row.floor ? "floor" : ""}" style="width:${width}%"></div>
          </div>
          <span>${formatPct(row.weight)}</span>
        </div>
      `;
    })
    .join("");
}

function drawWeightsTable(weights) {
  document.querySelector("#weightsTable").innerHTML = `
    <table>
      <thead><tr><th>Ticker</th><th>Weight</th><th>Status</th></tr></thead>
      <tbody>
        ${weights
          .map(
            (row) => `
              <tr>
                <td><strong>${row.ticker}</strong></td>
                <td>${formatPct(row.weight, 2)}</td>
                <td>${row.floor ? "At floor" : "Flexible"}</td>
              </tr>
            `
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function drawEvents(events) {
  document.querySelector("#eventGrid").innerHTML = events
    .map(
      (event) => `
        <article class="event-card">
          <strong>${event.name}</strong>
          <p>HRP: <span class="${pctClass(event.strategy)}">${formatPct(event.strategy)}</span></p>
          <p>Benchmark: <span class="${pctClass(event.benchmark)}">${formatPct(event.benchmark)}</span></p>
          <p>Spread: <span class="${pctClass(event.spread)}">${formatPct(event.spread)}</span></p>
        </article>
      `
    )
    .join("");
}

function drawMonthlyTable(rows) {
  document.querySelector("#monthlyTable").innerHTML = `
    <table>
      <thead><tr><th>Month</th><th>HRP spread</th></tr></thead>
      <tbody>
        ${rows
          .map(
            (row) => `
              <tr>
                <td>${row.month}</td>
                <td class="${pctClass(row.spread)}">${formatPct(row.spread)}</td>
              </tr>
            `
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function correlationColor(value) {
  const clamped = Math.max(-1, Math.min(1, value));
  if (clamped >= 0) {
    const alpha = 0.25 + clamped * 0.65;
    return `rgba(31, 111, 235, ${alpha})`;
  }
  const alpha = 0.25 + Math.abs(clamped) * 0.65;
  return `rgba(194, 65, 59, ${alpha})`;
}

function drawHeatmap(correlation) {
  const tickers = correlation.tickers;
  const size = tickers.length + 1;
  const cells = ['<div class="heatmap-label"></div>'];

  tickers.forEach((ticker) => cells.push(`<div class="heatmap-label">${ticker}</div>`));
  tickers.forEach((ticker, rowIndex) => {
    cells.push(`<div class="heatmap-label">${ticker}</div>`);
    tickers.forEach((_, columnIndex) => {
      const value = correlation.values[rowIndex][columnIndex];
      cells.push(
        `<div class="heatmap-cell" style="background:${correlationColor(value)}">${value.toFixed(2)}</div>`
      );
    });
  });

  document.querySelector("#correlationHeatmap").innerHTML = `
    <div class="heatmap-grid" style="grid-template-columns: repeat(${size}, minmax(54px, 1fr));">
      ${cells.join("")}
    </div>
  `;
}

function drawVolatility(rows) {
  const container = document.querySelector("#volatilityList");
  const maxVol = Math.max(...rows.map((row) => row.value));

  container.innerHTML = rows
    .map((row) => {
      const width = (row.value / maxVol) * 100;
      return `
        <div class="rank-row">
          <strong>${row.ticker}</strong>
          <div class="bar-track">
            <div class="bar-fill" style="width:${width}%; background:#0f8b8d;"></div>
          </div>
          <span>${formatPct(row.value)}</span>
        </div>
      `;
    })
    .join("");
}

function drawMarket(rows) {
  document.querySelector("#marketGrid").innerHTML = rows
    .map(
      (row) => `
        <article class="market-card">
          <header>
            <strong>${row.ticker}</strong>
            <span>${formatMoney(row.latest)}</span>
          </header>
          <div class="market-row"><span>1 day</span><span class="${pctClass(row.oneDay)}">${formatPct(row.oneDay)}</span></div>
          <div class="market-row"><span>5 day</span><span class="${pctClass(row.fiveDay)}">${formatPct(row.fiveDay)}</span></div>
          <div class="market-row"><span>1 month</span><span class="${pctClass(row.oneMonth)}">${formatPct(row.oneMonth)}</span></div>
          <div class="market-row"><span>Realized vol</span><span>${formatPct(row.realizedVol)}</span></div>
          <div class="market-row"><span>Trend</span><strong>${row.trend}</strong></div>
        </article>
      `
    )
    .join("");
}

document.querySelectorAll(".tab-button").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".tab-button").forEach((node) => node.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((node) => node.classList.remove("active"));
    button.classList.add("active");
    document.querySelector(`#${button.dataset.tab}`).classList.add("active");
  });
});

document.querySelectorAll("[data-preset]").forEach((button) => {
  button.addEventListener("click", () => {
    elements.tickers.value = presets[button.dataset.preset];
  });
});

elements.minWeight.addEventListener("input", () => {
  elements.minWeightValue.textContent = `${elements.minWeight.value}%`;
});

elements.runAnalysis.addEventListener("click", runAnalysis);
elements.endDate.value = todayIso();
setStatus("Ready");
