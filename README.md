# HRP Portfolio Manager

A Python-based portfolio analysis project that builds a constrained Hierarchical Risk Parity (HRP) allocation, tests it through a walk-forward backtest, and exposes the same workflow through a local financial dashboard.

The project is built around a barbell-style portfolio: a mix of high-growth equities, stable defensive names, and a Treasury hedge. It is designed to show how correlation-aware portfolio construction can reduce concentration risk and improve downside behavior compared with a broad equity benchmark.

This is an educational and research tool. It is not financial advice and should not be used as a standalone trading or investment system.

## Project Purpose

The main goal is to compare a traditional benchmark-led equity exposure with a portfolio that allocates capital using Hierarchical Risk Parity.

Instead of optimizing only for expected return, HRP focuses on the structure of risk:

- It calculates asset returns from historical market data.
- It estimates relationships between assets using correlation.
- It clusters assets that behave similarly.
- It allocates capital across those clusters to avoid overloading one source of risk.
- It applies a minimum-weight constraint so every selected asset keeps a meaningful allocation.
- It backtests the allocation with a walk-forward process to avoid using future data.

The result is a portfolio manager that answers practical questions such as:

- Which assets dominate the allocation?
- How diversified is the portfolio after HRP clustering?
- How does the strategy behave during market stress?
- Does it reduce drawdown compared with the benchmark?
- Which assets are currently trending or showing higher volatility?

## Repository Structure

```text
.
├── HRP_Portfolio_Manager.py      # Core HRP model, backtest, reports, and matplotlib plots
├── dashboard_server.py           # Local API server for the browser dashboard
├── frontend/
│   ├── index.html                # Dashboard markup
│   ├── styles.css                # Financial terminal-style UI
│   └── app.js                    # Dashboard interactions and canvas charts
├── requirements.txt              # Python dependencies
└── portfolio-optimizer.html      # Design reference file, not the active frontend
```

## Core Backend: `HRP_Portfolio_Manager.py`

This file contains the original portfolio engine.

### Main Configuration

```python
TICKERS = ["NVDA", "AAPL", "AMZN", "JPM", "COST", "UNH", "TLT"]
START_DATE = "2010-01-01"
END_DATE = datetime.today().strftime("%Y-%m-%d")
MIN_WEIGHT = 0.08
TRAINING_WINDOW = 504
REBALANCE_FREQ = 63
BENCHMARK_TICKER = "SPY"
```

The default portfolio uses:

- Growth exposure: `NVDA`, `AAPL`, `AMZN`
- Stability/value exposure: `JPM`, `COST`, `UNH`
- Hedge exposure: `TLT`
- Benchmark: `SPY`

The training window is 504 trading days, roughly two years. The rebalance frequency is 63 trading days, roughly one quarter.

### Data Collection

The `fetch_data()` function downloads adjusted close prices from Yahoo Finance using `yfinance`.

It then:

- Forward-fills missing prices caused by holidays or market closures.
- Drops remaining incomplete rows.
- Returns a clean price DataFrame.

### Return Processing

The `process_returns()` function converts prices into daily percentage returns.

It also clips returns at the 1st and 99th percentiles. This reduces the impact of extreme one-day prints or data issues that could distort the covariance and correlation estimates.

### HRP Optimization

The `run_hrp_model()` function uses `PyPortfolioOpt`'s `HRPOpt` class.

The process is:

1. Build an HRP optimizer from return data.
2. Run the HRP allocation.
3. Apply a minimum weight floor.
4. Return the HRP model object and final weights.

The project includes a small SciPy compatibility patch:

```python
patch_scipy_linkage_methods()
```

This keeps `PyPortfolioOpt` working with newer SciPy versions where an older private linkage-method attribute may not exist.

### Minimum Weight Constraint

The `enforce_min_weights()` function ensures every asset receives at least `MIN_WEIGHT`.

For example, with `MIN_WEIGHT = 0.08`, every asset must have at least 8% of the portfolio. Assets above the floor are rescaled proportionally so total portfolio weight still equals 100%.

This makes the allocation more practical for a small portfolio because HRP can otherwise assign very low weights to some assets.

### Walk-Forward Backtest

The `run_walk_forward()` function tests the model without lookahead bias.

For each rebalance point:

1. Use only past data from the training window.
2. Calculate HRP weights.
3. Apply those weights to the next test period.
4. Store the realized portfolio returns.
5. Move forward by the rebalance interval.

This is more realistic than optimizing once on the full dataset because the model only sees information that would have been available at the time.

### Reports and Metrics

The script calculates:

- Total return
- Sharpe ratio
- Maximum drawdown
- Upside capture
- Downside capture
- Daily win rate
- Event-window performance
- Best monthly outperformance

It also plots:

- HRP dendrogram
- Final allocation
- Strategy vs benchmark equity curve

## Local Dashboard: `dashboard_server.py` and `frontend/`

The dashboard turns the backend into an interactive local web app.

It does not use Streamlit, Flask, React, or a separate JavaScript build system. It uses Python's built-in HTTP server and serves a static frontend from the `frontend/` directory.

### Dashboard Architecture

```text
Browser UI
   |
   | POST /api/analyze
   v
dashboard_server.py
   |
   | imports shared HRP logic
   v
HRP_Portfolio_Manager.py
   |
   | yfinance market data
   v
Yahoo Finance
```

### API Endpoints

`GET /`

Serves the dashboard.

`GET /api/health`

Returns:

```json
{"ok": true}
```

`POST /api/analyze`

Runs the portfolio workflow and returns JSON containing:

- Configuration used for the run
- Final HRP weights
- Strategy and benchmark metrics
- Equity curve
- Drawdown curve
- Correlation matrix
- Volatility ranking
- Market tape data
- OHLC candle data
- Event-window returns
- Best relative months

### Dashboard Features

The dashboard includes:

- Dark financial terminal-style interface
- Light/dark mode toggle
- Ticker universe input
- Presets for core, defensive, and growth portfolios
- Date range controls
- Benchmark input
- HRP clustering method selector
- Minimum-weight slider
- Training-window and rebalance-frequency controls
- Run-state pipeline indicator
- KPI row for total return, benchmark return, max drawdown, Sharpe ratio, and downside capture
- Candlestick chart with range buttons
- Symbol selector for OHLC candles
- Allocation ring chart
- Strategy vs benchmark equity curve
- Drawdown chart
- Holdings matrix
- Correlation heatmap
- Volatility ranking
- Event-window performance
- Market monitor cards

### Candlestick Chart

The dashboard uses Yahoo Finance OHLC data for candle rendering.

The backend filters obviously invalid candle rows, including:

- Non-positive prices
- High values below open/close/low
- Low values above open/close/high
- Extreme high-to-low ranges that are likely bad data

The frontend also applies a second layer of cleaning and uses a visible-window price range so one bad or distant candle does not destroy the chart scale.

## Installation

Create and activate a virtual environment from the project directory.

```bash
python3 -m venv venv
source venv/bin/activate
```

Install dependencies:

```bash
python -m pip install --upgrade pip setuptools wheel
python -m pip install -r requirements.txt
```

Important package-name detail:

```text
Install name: pyportfolioopt
Import name:  pypfopt
```

So this is correct:

```bash
python -m pip install pyportfolioopt
```

and this is also correct in Python:

```python
from pypfopt import HRPOpt
```

But this will fail:

```bash
pip install pypfopt
```

## Running the Command-Line Model

From the project directory:

```bash
python HRP_Portfolio_Manager.py
```

The script will:

1. Download price data.
2. Clean returns.
3. Print recent return data and volatility ranking.
4. Run the HRP model.
5. Plot the dendrogram and allocation.
6. Run the walk-forward backtest.
7. Compare the strategy against `SPY`.
8. Print defensive and event-window metrics.

If you are using a virtual environment, make sure the Python interpreter comes from that environment:

```bash
which python
```

Expected path:

```text
.../HRP_Portfolio_Manager/venv/bin/python
```

## Running the Dashboard

Start the local server:

```bash
./venv/bin/python dashboard_server.py --host 127.0.0.1 --port 8765
```

Then open:

```text
http://127.0.0.1:8765
```

Stop the server with:

```text
Ctrl+C
```

If browser changes do not show immediately, hard refresh:

```text
Cmd+Shift+R
```

## Feasibility and Use Cases

This project is feasible as a research dashboard, teaching tool, and portfolio analytics prototype.

Good use cases:

- Learning HRP portfolio construction
- Comparing risk-balanced allocation against a benchmark
- Exploring correlation and diversification effects
- Studying drawdowns across market events
- Testing different ticker universes
- Demonstrating walk-forward backtesting
- Building a portfolio analytics project for academic or personal research

Less suitable use cases:

- Live trading execution
- Intraday strategy development
- Professional risk reporting without validation
- Portfolio recommendations without further due diligence
- Production use without data-quality controls, logging, and testing

## Current Limitations

The model has several practical limitations:

- Yahoo Finance data can be delayed, revised, missing, or temporarily unavailable.
- Historical correlations are unstable and may not hold in future regimes.
- HRP does not forecast returns.
- The minimum-weight constraint is manually imposed after HRP optimization.
- Transaction costs, taxes, slippage, and liquidity are not modeled.
- The backtest assumes daily close-to-close returns.
- The dashboard is local-only and not built for multi-user deployment.
- Event windows are hard-coded.
- The default portfolio is US equity-heavy with one Treasury ETF hedge.

## Troubleshooting

### `ModuleNotFoundError: No module named 'pypfopt'`

You are probably running the script with the wrong Python interpreter.

Check:

```bash
which python
python -c "from pypfopt import HRPOpt; print('works')"
```

Run with the venv explicitly:

```bash
./venv/bin/python HRP_Portfolio_Manager.py
```

### `No matching distribution found for pypfopt`

Install the package by its PyPI name:

```bash
python -m pip install pyportfolioopt
```

Do not install `pypfopt`; that is the import name, not the package name.

### Yahoo Finance download errors

If `yfinance` cannot download data:

- Check internet connectivity.
- Try again later.
- Reduce the ticker list.
- Confirm tickers are valid.
- Check whether Yahoo Finance is rate-limiting requests.

### Dashboard starts but page looks stale

Hard refresh the browser:

```text
Cmd+Shift+R
```

### Matplotlib font-cache warning

The dashboard server sets `MPLCONFIGDIR` to a temporary writable directory to avoid common local permission warnings. If running the command-line script directly still prints a Matplotlib cache warning, it is usually harmless.

## Possible Extensions

Useful next improvements:

- Add transaction costs to the backtest.
- Add turnover tracking.
- Add export to CSV or PDF.
- Add configurable event windows.
- Add sector or asset-class grouping.
- Add rolling Sharpe and rolling volatility charts.
- Add benchmark selection presets.
- Add portfolio upload from CSV.
- Add unit tests for return processing and weight constraints.
- Add a persistent cache for downloaded market data.

## Summary

`HRP_Portfolio_Manager.py` provides the portfolio logic: data download, return cleaning, HRP allocation, constrained weights, walk-forward testing, and performance reporting.

`dashboard_server.py` and `frontend/` turn that logic into an interactive local dashboard with market data, candlesticks, allocation charts, risk metrics, and benchmark comparison.

Together, the project demonstrates how a correlation-aware portfolio construction method can be researched, visualized, and tested in a practical Python workflow.
