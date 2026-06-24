const presets = {
  default: "NVDA, AAPL, AMZN, JPM, COST, UNH, TLT",
  defensive: "COST, UNH, JNJ, PG, XLU, TLT, IEF",
  growth: "NVDA, MSFT, AAPL, AMZN, GOOGL, META, TLT",
};

const palette = ["#00d4aa", "#4f8cff", "#3dd68c", "#e8b84b", "#e05252", "#8b5cf6", "#38bdf8", "#f97316"];

let activeResult = null;
let activeTicker = null;
let candleWindow = 45;
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
  candleCanvas: document.querySelector("#candleCanvas"),
  candleTooltip: document.querySelector("#candleTooltip"),
  allocationCanvas: document.querySelector("#allocationCanvas"),
  equityCanvas: document.querySelector("#equityCanvas"),
  drawdownCanvas: document.querySelector("#drawdownCanvas"),
};

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function formatPct(value, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(value)) return "--";
  return `${(value * 100).toFixed(digits)}%`;
}

function formatNumber(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "--";
  return value.toFixed(digits);
}

function formatMoney(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "--";
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

function setStatus(text) {
  elements.runStatus.textContent = text;
  setText("statusFooter", text.toUpperCase());
}

function setStep(step) {
  document.querySelectorAll(".pipeline-step").forEach((node) => {
    node.classList.toggle("active", node.dataset.step === step);
  });
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
  }, 700);
}

function stopProgress() {
  clearInterval(progressTimer);
  setStep("report");
}

async function runAnalysis() {
  clearError();
  elements.runAnalysis.disabled = true;
  setStatus("Running");
  setText("tapeState", "RUNNING");
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
    activeTicker = activeResult.config.tickers[0];
    renderDashboard(activeResult);
    setStatus("Complete");
    setText("tapeState", "LIVE");
  } catch (error) {
    showError(error.message);
    setStatus("Needs attention");
    setText("tapeState", "ERROR");
  } finally {
    stopProgress();
    elements.runAnalysis.disabled = false;
  }
}

function renderDashboard(result) {
  const strategy = result.metrics.strategy;
  const benchmark = result.metrics.benchmark;

  setText("latestDate", result.config.latestDate);
  setText("tapeBenchmark", result.config.benchmark);
  setText("benchmarkLabel", `${result.config.benchmark} total return`);
  setText("totalReturn", formatPct(strategy.totalReturn));
  setText("benchmarkReturn", formatPct(benchmark.totalReturn));
  setText("maxDrawdown", formatPct(strategy.maxDrawdown));
  setText("sharpeRatio", formatNumber(strategy.sharpe));
  setText("downsideCapture", formatPct(result.metrics.downsideCapture));
  setText("largestWeight", formatPct(result.metrics.largestWeight));
  setText("effectivePositions", formatNumber(result.metrics.effectivePositions, 1));
  setText("upsideCapture", formatPct(result.metrics.upsideCapture));
  setText("clusterCount", String(result.clusterCount));

  drawSymbolRail(result.config.tickers);
  drawCandles();
  drawAllocationRing(result.weights);
  drawLineCanvas(elements.equityCanvas, result.series.equity, [
    { key: "strategy", label: "HRP", color: cssVar("--accent") },
    { key: "benchmark", label: result.config.benchmark, color: cssVar("--text-secondary") },
  ]);
  drawLineCanvas(elements.drawdownCanvas, result.series.drawdown, [
    { key: "strategy", label: "HRP", color: cssVar("--red") },
    { key: "benchmark", label: result.config.benchmark, color: cssVar("--text-secondary") },
  ], true);
  drawWeightsTable(result.weights, result.market);
  drawEvents(result.events);
  drawMonthlyTable(result.monthlyLeaders);
  drawHeatmap(result.risk.correlation);
  drawVolatility(result.risk.volatility);
  drawMarket(result.market);
}

function prepareCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const cssWidth = rect.width || Number(canvas.getAttribute("width")) || 600;
  const cssHeight = rect.height || Number(canvas.getAttribute("height")) || 300;
  canvas.width = Math.max(1, Math.floor(cssWidth * ratio));
  canvas.height = Math.max(1, Math.floor(cssHeight * ratio));
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { ctx, width: cssWidth, height: cssHeight };
}

function drawSymbolRail(tickers) {
  const rail = document.querySelector("#symbolRail");
  rail.innerHTML = tickers
    .map(
      (ticker) => `<button class="symbol-button ${ticker === activeTicker ? "active" : ""}" data-ticker="${ticker}">${ticker}</button>`
    )
    .join("");

  rail.querySelectorAll(".symbol-button").forEach((button) => {
    button.addEventListener("click", () => {
      activeTicker = button.dataset.ticker;
      drawSymbolRail(activeResult.config.tickers);
      drawCandles();
    });
  });
}

function isFinitePrice(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function quantile(values, probability) {
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * probability;
  const base = Math.floor(position);
  const rest = position - base;
  return sorted[base + 1] !== undefined
    ? sorted[base] + rest * (sorted[base + 1] - sorted[base])
    : sorted[base];
}

function cleanCandles(rawCandles) {
  const numeric = rawCandles
    .map((row) => ({
      date: row.date,
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
    }))
    .filter(
      (row) =>
        isFinitePrice(row.open) &&
        isFinitePrice(row.high) &&
        isFinitePrice(row.low) &&
        isFinitePrice(row.close) &&
        row.high >= Math.max(row.open, row.close, row.low) &&
        row.low <= Math.min(row.open, row.close, row.high)
    );

  if (!numeric.length) return [];

  const medianClose = median(numeric.map((row) => row.close));
  return numeric.filter(
    (row) =>
      row.high / row.low < 1.45 &&
      row.high < medianClose * 2.4 &&
      row.low > medianClose * 0.35
  );
}

function priceTicks(minValue, maxValue, count = 5) {
  const span = maxValue - minValue || 1;
  const roughStep = span / Math.max(1, count - 1);
  const exponent = Math.floor(Math.log10(roughStep));
  const base = 10 ** exponent;
  const fraction = roughStep / base;
  const niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  const step = niceFraction * base;
  const first = Math.ceil(minValue / step) * step;
  const ticks = [];

  for (let tick = first; tick <= maxValue + step * 0.5; tick += step) {
    ticks.push(tick);
  }

  return ticks.length >= 3 ? ticks : [minValue, (minValue + maxValue) / 2, maxValue];
}

function drawCandles() {
  if (!activeResult || !activeTicker) return;

  const rawCandles = activeResult.candles[activeTicker] || [];
  const candles = cleanCandles(rawCandles).slice(-candleWindow);
  const canvas = elements.candleCanvas;
  const { ctx, width, height } = prepareCanvas(canvas);
  const padding = { top: 22, right: 76, bottom: 38, left: 16 };
  ctx.clearRect(0, 0, width, height);

  if (!candles.length) {
    ctx.fillStyle = cssVar("--text-muted");
    ctx.font = "12px " + cssVar("--mono");
    ctx.fillText("No clean candle data returned.", 20, 40);
    return;
  }

  const lows = candles.map((row) => row.low);
  const highs = candles.map((row) => row.high);
  let minPrice = quantile(lows, 0.02);
  let maxPrice = quantile(highs, 0.98);

  if (maxPrice <= minPrice) {
    minPrice = Math.min(...lows);
    maxPrice = Math.max(...highs);
  }

  const domainPad = (maxPrice - minPrice || maxPrice * 0.02) * 0.08;
  minPrice -= domainPad;
  maxPrice += domainPad;

  const span = maxPrice - minPrice || 1;
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const slot = plotWidth / candles.length;
  const bodyWidth = Math.max(4, Math.min(12, slot * 0.58));

  const unclippedY = (value) => padding.top + (1 - (value - minPrice) / span) * plotHeight;
  const y = (value) => Math.max(padding.top, Math.min(padding.top + plotHeight, unclippedY(value)));
  const x = (index) => padding.left + index * slot + slot / 2;

  ctx.font = "11px " + cssVar("--mono");
  ctx.textBaseline = "middle";
  ctx.strokeStyle = cssVar("--grid");
  ctx.lineWidth = 1;

  priceTicks(minPrice, maxPrice, 5).forEach((tick) => {
    const yPos = y(tick);
    ctx.beginPath();
    ctx.moveTo(padding.left, yPos);
    ctx.lineTo(width - padding.right, yPos);
    ctx.stroke();
    ctx.fillStyle = cssVar("--text-muted");
    ctx.fillText(tick.toFixed(2), width - padding.right + 10, yPos);
  });

  const dateTickCount = Math.min(5, candles.length);
  for (let i = 0; i < dateTickCount; i += 1) {
    const index = Math.round((i / Math.max(1, dateTickCount - 1)) * (candles.length - 1));
    const xPos = x(index);
    ctx.beginPath();
    ctx.moveTo(xPos, padding.top);
    ctx.lineTo(xPos, padding.top + plotHeight);
    ctx.stroke();
    ctx.fillStyle = cssVar("--text-muted");
    ctx.textAlign = i === dateTickCount - 1 ? "right" : "center";
    ctx.fillText(candles[index].date.slice(5), xPos, height - 16);
  }
  ctx.textAlign = "left";

  candles.forEach((row, index) => {
    const up = row.close >= row.open;
    const color = up ? cssVar("--green") : cssVar("--red");
    const cx = x(index);
    const openY = y(row.open);
    const closeY = y(row.close);
    const highY = y(row.high);
    const lowY = y(row.low);
    const top = Math.min(openY, closeY);
    const bodyHeight = Math.max(2, Math.abs(closeY - openY));

    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(cx, highY);
    ctx.lineTo(cx, lowY);
    ctx.stroke();
    ctx.fillRect(cx - bodyWidth / 2, top, bodyWidth, bodyHeight);
  });

  const last = candles[candles.length - 1];
  const lastY = y(last.close);
  ctx.strokeStyle = cssVar("--accent");
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(padding.left, lastY);
  ctx.lineTo(width - padding.right, lastY);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = cssVar("--accent");
  ctx.fillRect(width - padding.right + 7, lastY - 9, 58, 18);
  ctx.fillStyle = "#031b16";
  ctx.font = "700 10px " + cssVar("--mono");
  ctx.fillText(last.close.toFixed(2), width - padding.right + 12, lastY);

  canvas.onmousemove = (event) => {
    const rect = canvas.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const index = Math.max(0, Math.min(candles.length - 1, Math.floor((mouseX - padding.left) / slot)));
    const candle = candles[index];
    elements.candleTooltip.style.display = "block";
    elements.candleTooltip.style.left = `${Math.min(mouseX + 12, rect.width - 210)}px`;
    elements.candleTooltip.style.top = `${Math.min(event.clientY - rect.top + 14, rect.height - 92)}px`;
    elements.candleTooltip.innerHTML = `
      <strong>${activeTicker} ${candle.date}</strong><br>
      O ${formatMoney(candle.open)} &nbsp; H ${formatMoney(candle.high)}<br>
      L ${formatMoney(candle.low)} &nbsp; C ${formatMoney(candle.close)}
    `;
  };

  canvas.onmouseleave = () => {
    elements.candleTooltip.style.display = "none";
  };
}

function drawAllocationRing(weights) {
  const canvas = elements.allocationCanvas;
  const { ctx, width, height } = prepareCanvas(canvas);
  const centerX = width / 2;
  const centerY = height / 2;
  const radius = Math.min(width, height) * 0.34;
  const lineWidth = 24;
  let startAngle = -Math.PI / 2;

  ctx.clearRect(0, 0, width, height);

  weights.forEach((row, index) => {
    const angle = row.weight * Math.PI * 2;
    ctx.beginPath();
    ctx.strokeStyle = palette[index % palette.length];
    ctx.lineWidth = lineWidth;
    ctx.arc(centerX, centerY, radius, startAngle, startAngle + angle);
    ctx.stroke();
    startAngle += angle;
  });

  ctx.fillStyle = cssVar("--text-primary");
  ctx.font = "700 18px " + cssVar("--mono");
  ctx.textAlign = "center";
  ctx.fillText("HRP", centerX, centerY - 2);
  ctx.fillStyle = cssVar("--text-muted");
  ctx.font = "11px " + cssVar("--mono");
  ctx.fillText("weights", centerX, centerY + 16);
  ctx.textAlign = "left";

  document.querySelector("#allocationLegend").innerHTML = weights
    .map(
      (row, index) => `
        <div class="legend-row">
          <span class="legend-left">
            <span class="legend-dot" style="background:${palette[index % palette.length]}"></span>
            <strong>${row.ticker}</strong>
          </span>
          <span>${formatPct(row.weight, 2)}</span>
        </div>
      `
    )
    .join("");
}

function chartExtent(series, lines) {
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

function drawLineCanvas(canvas, series, lines, percentAxis = false) {
  const { ctx, width, height } = prepareCanvas(canvas);
  const padding = { top: 22, right: 22, bottom: 30, left: 54 };
  ctx.clearRect(0, 0, width, height);

  if (!series.length) return;

  const [minValue, maxValue] = chartExtent(series, lines);
  const span = maxValue - minValue || 1;
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const x = (index) => padding.left + (index / Math.max(series.length - 1, 1)) * plotWidth;
  const y = (value) => padding.top + (1 - (value - minValue) / span) * plotHeight;

  ctx.strokeStyle = cssVar("--grid");
  ctx.fillStyle = cssVar("--text-muted");
  ctx.font = "11px " + cssVar("--mono");
  for (let i = 0; i <= 4; i += 1) {
    const yPos = padding.top + (plotHeight / 4) * i;
    const value = maxValue - (span / 4) * i;
    ctx.beginPath();
    ctx.moveTo(padding.left, yPos);
    ctx.lineTo(width - padding.right, yPos);
    ctx.stroke();
    ctx.fillText(percentAxis ? formatPct(value, 0) : formatNumber(value, 1), 8, yPos + 4);
  }

  lines.forEach((line) => {
    ctx.strokeStyle = line.color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    series.forEach((point, index) => {
      const xPos = x(index);
      const yPos = y(point[line.key]);
      if (index === 0) ctx.moveTo(xPos, yPos);
      else ctx.lineTo(xPos, yPos);
    });
    ctx.stroke();
  });

  lines.forEach((line, index) => {
    const xPos = padding.left + index * 92;
    ctx.fillStyle = line.color;
    ctx.fillRect(xPos, 8, 10, 10);
    ctx.fillStyle = cssVar("--text-secondary");
    ctx.fillText(line.label, xPos + 15, 17);
  });

  ctx.fillStyle = cssVar("--text-muted");
  ctx.fillText(series[0].date, padding.left, height - 9);
  ctx.fillText(series[series.length - 1].date, width - padding.right - 78, height - 9);
}

function drawWeightsTable(weights, market) {
  const marketByTicker = Object.fromEntries(market.map((row) => [row.ticker, row]));
  const maxWeight = Math.max(...weights.map((row) => row.weight));

  document.querySelector("#weightsTable").innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Ticker</th><th>Weight</th><th>Bar</th><th>Status</th><th>Last</th><th>1D</th><th>1M</th><th>Vol</th>
        </tr>
      </thead>
      <tbody>
        ${weights
          .map((row) => {
            const tape = marketByTicker[row.ticker] || {};
            return `
              <tr>
                <td><strong>${row.ticker}</strong></td>
                <td>${formatPct(row.weight, 2)}</td>
                <td><div class="bar-track"><div class="bar-fill" style="width:${(row.weight / maxWeight) * 100}%"></div></div></td>
                <td>${row.floor ? "Floor" : "Flexible"}</td>
                <td>${formatMoney(tape.latest)}</td>
                <td class="${pctClass(tape.oneDay)}">${formatPct(tape.oneDay)}</td>
                <td class="${pctClass(tape.oneMonth)}">${formatPct(tape.oneMonth)}</td>
                <td>${formatPct(tape.realizedVol)}</td>
              </tr>
            `;
          })
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
          <p><span>HRP</span><span class="${pctClass(event.strategy)}">${formatPct(event.strategy)}</span></p>
          <p><span>Benchmark</span><span class="${pctClass(event.benchmark)}">${formatPct(event.benchmark)}</span></p>
          <p><span>Spread</span><span class="${pctClass(event.spread)}">${formatPct(event.spread)}</span></p>
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
          .map((row) => `<tr><td>${row.month}</td><td class="${pctClass(row.spread)}">${formatPct(row.spread)}</td></tr>`)
          .join("")}
      </tbody>
    </table>
  `;
}

function correlationColor(value) {
  const clamped = Math.max(-1, Math.min(1, value));
  if (clamped >= 0) return `rgba(0, 212, 170, ${0.18 + clamped * 0.72})`;
  return `rgba(224, 82, 82, ${0.18 + Math.abs(clamped) * 0.72})`;
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
      cells.push(`<div class="heatmap-cell" style="background:${correlationColor(value)}">${value.toFixed(2)}</div>`);
    });
  });

  document.querySelector("#correlationHeatmap").innerHTML = `
    <div class="heatmap-grid" style="grid-template-columns: repeat(${size}, minmax(56px, 1fr));">
      ${cells.join("")}
    </div>
  `;
}

function drawVolatility(rows) {
  const maxVol = Math.max(...rows.map((row) => row.value));
  document.querySelector("#volatilityList").innerHTML = rows
    .map(
      (row) => `
        <div class="rank-row">
          <strong>${row.ticker}</strong>
          <div class="bar-track"><div class="bar-fill" style="width:${(row.value / maxVol) * 100}%"></div></div>
          <span>${formatPct(row.value)}</span>
        </div>
      `
    )
    .join("");
}

function drawMarket(rows) {
  document.querySelector("#marketGrid").innerHTML = rows
    .map(
      (row) => `
        <article class="market-card">
          <header><strong>${row.ticker}</strong><span>${formatMoney(row.latest)}</span></header>
          <div class="market-row"><span>1D</span><span class="${pctClass(row.oneDay)}">${formatPct(row.oneDay)}</span></div>
          <div class="market-row"><span>5D</span><span class="${pctClass(row.fiveDay)}">${formatPct(row.fiveDay)}</span></div>
          <div class="market-row"><span>1M</span><span class="${pctClass(row.oneMonth)}">${formatPct(row.oneMonth)}</span></div>
          <div class="market-row"><span>Realized vol</span><span>${formatPct(row.realizedVol)}</span></div>
          <div class="market-row"><span>Trend</span><strong>${row.trend}</strong></div>
        </article>
      `
    )
    .join("");
}

document.querySelectorAll(".nav-tab").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".nav-tab").forEach((node) => node.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((node) => node.classList.remove("active"));
    button.classList.add("active");
    document.querySelector(`#${button.dataset.tab}`).classList.add("active");
    if (activeResult) {
      requestAnimationFrame(() => renderDashboard(activeResult));
    }
  });
});

document.querySelectorAll("[data-preset]").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll("[data-preset]").forEach((node) => node.classList.remove("active"));
    button.classList.add("active");
    elements.tickers.value = presets[button.dataset.preset];
  });
});

document.querySelectorAll("[data-candle-window]").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll("[data-candle-window]").forEach((node) => node.classList.remove("active"));
    button.classList.add("active");
    candleWindow = Number(button.dataset.candleWindow);
    drawCandles();
  });
});

document.querySelector("#themeToggle").addEventListener("click", () => {
  const html = document.documentElement;
  html.dataset.theme = html.dataset.theme === "dark" ? "light" : "dark";
  if (activeResult) requestAnimationFrame(() => renderDashboard(activeResult));
});

elements.minWeight.addEventListener("input", () => {
  elements.minWeightValue.textContent = `${elements.minWeight.value}%`;
});

window.addEventListener("resize", () => {
  if (activeResult) requestAnimationFrame(() => renderDashboard(activeResult));
});

elements.runAnalysis.addEventListener("click", runAnalysis);
elements.endDate.value = todayIso();
setStatus("Ready");
