"""Local web dashboard for the HRP portfolio manager."""

import argparse
import json
import math
import os
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

import numpy as np
import pandas as pd
import yfinance as yf

os.environ.setdefault("MPLCONFIGDIR", os.path.join(tempfile.gettempdir(), "hrp_matplotlib"))

from HRP_Portfolio_Manager import (  # noqa: E402
    BENCHMARK_TICKER,
    END_DATE,
    MIN_WEIGHT,
    REBALANCE_FREQ,
    START_DATE,
    TICKERS,
    TRAINING_WINDOW,
    enforce_min_weights,
    max_drawdown,
    patch_scipy_linkage_methods,
)
from pypfopt import HRPOpt  # noqa: E402


BASE_DIR = Path(__file__).resolve().parent
FRONTEND_DIR = BASE_DIR / "frontend"
TRADING_DAYS = 252
EVENTS = [
    ("COVID Crash", "2020-02-19", "2020-03-23"),
    ("Post-COVID Rally", "2020-03-23", "2020-08-01"),
    ("2022 Inflation Bear", "2022-01-01", "2022-10-12"),
    ("AI Boom", "2023-01-01", "2023-07-31"),
]


def clean_tickers(raw_tickers):
    if isinstance(raw_tickers, str):
        raw_tickers = raw_tickers.replace("\n", ",").split(",")

    tickers = []
    for ticker in raw_tickers:
        ticker = ticker.strip().upper()
        if ticker and ticker not in tickers:
            tickers.append(ticker)

    return tickers


def safe_float(value):
    if value is None:
        return None

    value = float(value)
    if math.isnan(value) or math.isinf(value):
        return None
    return value


def series_to_points(series):
    return [
        {"date": index.strftime("%Y-%m-%d"), "value": safe_float(value)}
        for index, value in series.dropna().items()
    ]


def frame_from_download(data, tickers):
    if data.empty:
        return pd.DataFrame(columns=tickers)

    if isinstance(data.columns, pd.MultiIndex):
        if "Close" in data.columns.get_level_values(0):
            prices = data["Close"]
        elif "Adj Close" in data.columns.get_level_values(0):
            prices = data["Adj Close"]
        else:
            prices = data.xs(data.columns.levels[0][0], axis=1, level=0)
    elif "Close" in data.columns:
        prices = data[["Close"]]
        prices.columns = tickers[:1]
    else:
        prices = data.copy()

    if isinstance(prices, pd.Series):
        prices = prices.to_frame(tickers[0])

    prices = prices.reindex(columns=[ticker for ticker in tickers if ticker in prices.columns])
    return prices.ffill().dropna(how="all")


def field_from_download(data, tickers, field_name):
    if data.empty:
        return pd.DataFrame(columns=tickers)

    if isinstance(data.columns, pd.MultiIndex):
        first_level = data.columns.get_level_values(0)
        second_level = data.columns.get_level_values(1)

        if field_name in first_level:
            frame = data[field_name]
        elif field_name in second_level:
            frame = data.xs(field_name, axis=1, level=1)
        else:
            return pd.DataFrame(columns=tickers)
    elif field_name in data.columns:
        frame = data[[field_name]].copy()
        frame.columns = tickers[:1]
    else:
        return pd.DataFrame(columns=tickers)

    if isinstance(frame, pd.Series):
        frame = frame.to_frame(tickers[0])

    frame = frame.reindex(columns=[ticker for ticker in tickers if ticker in frame.columns])
    return frame.ffill().dropna(how="all")


def download_prices(tickers, benchmark, start_date, end_date):
    download_list = clean_tickers([*tickers, benchmark])
    raw_data = yf.download(
        download_list,
        start=start_date,
        end=end_date,
        auto_adjust=True,
        progress=False,
        group_by="column",
    )

    prices = frame_from_download(raw_data, download_list)
    asset_prices = prices.reindex(columns=tickers).dropna()

    if benchmark in prices.columns:
        benchmark_prices = prices[benchmark].dropna()
    else:
        benchmark_prices = pd.Series(dtype=float)

    ohlc = {
        "open": field_from_download(raw_data, download_list, "Open").reindex(columns=tickers),
        "high": field_from_download(raw_data, download_list, "High").reindex(columns=tickers),
        "low": field_from_download(raw_data, download_list, "Low").reindex(columns=tickers),
        "close": field_from_download(raw_data, download_list, "Close").reindex(columns=tickers),
    }

    return asset_prices, benchmark_prices, ohlc


def candle_payload(ohlc, tickers, lookback=180):
    candles = {}

    for ticker in tickers:
        if ticker not in ohlc["close"]:
            candles[ticker] = []
            continue

        ticker_frame = pd.DataFrame(
            {
                "open": ohlc["open"][ticker],
                "high": ohlc["high"][ticker],
                "low": ohlc["low"][ticker],
                "close": ohlc["close"][ticker],
            }
        ).dropna()

        ticker_frame = ticker_frame[
            (ticker_frame["open"] > 0)
            & (ticker_frame["high"] > 0)
            & (ticker_frame["low"] > 0)
            & (ticker_frame["close"] > 0)
            & (ticker_frame["high"] >= ticker_frame[["open", "close", "low"]].max(axis=1))
            & (ticker_frame["low"] <= ticker_frame[["open", "close", "high"]].min(axis=1))
            & ((ticker_frame["high"] / ticker_frame["low"]) < 1.45)
        ]

        ticker_frame = ticker_frame.tail(lookback)
        candles[ticker] = [
            {
                "date": index.strftime("%Y-%m-%d"),
                "open": safe_float(row["open"]),
                "high": safe_float(row["high"]),
                "low": safe_float(row["low"]),
                "close": safe_float(row["close"]),
            }
            for index, row in ticker_frame.iterrows()
        ]

    return candles


def process_returns(price_data):
    returns = price_data.pct_change().dropna()
    lower_limit = returns.quantile(0.01)
    upper_limit = returns.quantile(0.99)
    return returns.clip(lower=lower_limit, upper=upper_limit, axis=1)


def hrp_weights(returns_data, min_weight, linkage_method):
    patch_scipy_linkage_methods()
    hrp = HRPOpt(returns=returns_data)
    raw_weights = hrp.optimize(linkage_method=linkage_method)
    weights = enforce_min_weights(raw_weights, min_weight=min_weight)
    return hrp, weights


def walk_forward(returns_data, training_window, rebalance_freq, min_weight, linkage_method):
    portfolio_history = []

    for rebalance_index in range(training_window, len(returns_data), rebalance_freq):
        train_window = returns_data.iloc[
            rebalance_index - training_window : rebalance_index
        ]
        test_window = returns_data.iloc[rebalance_index : rebalance_index + rebalance_freq]

        try:
            _, weights = hrp_weights(train_window, min_weight, linkage_method)
        except Exception:
            n_assets = train_window.shape[1]
            weights = {ticker: 1.0 / n_assets for ticker in train_window.columns}

        period_returns = (test_window * pd.Series(weights)).sum(axis=1)
        portfolio_history.append(period_returns)

    if not portfolio_history:
        return pd.Series(dtype=float)

    return pd.concat(portfolio_history)


def calculate_capture(strategy_returns, benchmark_returns):
    up_market = benchmark_returns[benchmark_returns > 0]
    down_market = benchmark_returns[benchmark_returns < 0]

    upside = strategy_returns[benchmark_returns > 0].mean() / up_market.mean()
    downside = strategy_returns[benchmark_returns < 0].mean() / down_market.mean()
    return safe_float(upside), safe_float(downside)


def performance_metrics(returns):
    if returns.empty:
        return {
            "totalReturn": None,
            "annualizedReturn": None,
            "annualizedVolatility": None,
            "sharpe": None,
            "maxDrawdown": None,
            "winRate": None,
        }

    cumulative = (1 + returns).cumprod()
    total_return = cumulative.iloc[-1] - 1
    years = max(len(returns) / TRADING_DAYS, 1 / TRADING_DAYS)
    annual_return = (1 + total_return) ** (1 / years) - 1
    annual_volatility = returns.std() * np.sqrt(TRADING_DAYS)
    sharpe = returns.mean() / returns.std() * np.sqrt(TRADING_DAYS)

    return {
        "totalReturn": safe_float(total_return),
        "annualizedReturn": safe_float(annual_return),
        "annualizedVolatility": safe_float(annual_volatility),
        "sharpe": safe_float(sharpe),
        "maxDrawdown": safe_float(max_drawdown(cumulative)),
        "winRate": safe_float((returns > 0).sum() / len(returns)),
    }


def ticker_summary(prices, returns):
    rows = []

    for ticker in prices.columns:
        series = prices[ticker].dropna()
        ticker_returns = returns[ticker].dropna() if ticker in returns else pd.Series(dtype=float)

        if len(series) < 2:
            continue

        latest = series.iloc[-1]
        previous = series.iloc[-2]
        five_day_base = series.iloc[-6] if len(series) >= 6 else series.iloc[0]
        month_base = series.iloc[-22] if len(series) >= 22 else series.iloc[0]
        momentum_20d = latest / month_base - 1
        realized_vol = ticker_returns.tail(63).std() * np.sqrt(TRADING_DAYS)

        if momentum_20d > 0.05:
            trend = "Strong uptrend"
        elif momentum_20d > 0:
            trend = "Positive"
        elif momentum_20d < -0.05:
            trend = "Under pressure"
        else:
            trend = "Flat"

        rows.append(
            {
                "ticker": ticker,
                "latest": safe_float(latest),
                "date": series.index[-1].strftime("%Y-%m-%d"),
                "oneDay": safe_float(latest / previous - 1),
                "fiveDay": safe_float(latest / five_day_base - 1),
                "oneMonth": safe_float(momentum_20d),
                "realizedVol": safe_float(realized_vol),
                "trend": trend,
            }
        )

    return rows


def drawdown_series(cumulative_returns):
    rolling_peak = cumulative_returns.cummax()
    return (cumulative_returns - rolling_peak) / rolling_peak


def event_returns(strategy_returns, benchmark_returns):
    rows = []

    for name, start_date, end_date in EVENTS:
        strategy_period = strategy_returns.loc[start_date:end_date]
        benchmark_period = benchmark_returns.loc[start_date:end_date]

        if strategy_period.empty or benchmark_period.empty:
            rows.append({"name": name, "strategy": None, "benchmark": None, "spread": None})
            continue

        strategy_total = (1 + strategy_period).prod() - 1
        benchmark_total = (1 + benchmark_period).prod() - 1
        rows.append(
            {
                "name": name,
                "strategy": safe_float(strategy_total),
                "benchmark": safe_float(benchmark_total),
                "spread": safe_float(strategy_total - benchmark_total),
            }
        )

    return rows


def monthly_outperformance(strategy_returns, benchmark_returns):
    strategy_monthly = strategy_returns.resample("ME").apply(lambda x: (1 + x).prod() - 1)
    benchmark_monthly = benchmark_returns.resample("ME").apply(lambda x: (1 + x).prod() - 1)
    difference = (strategy_monthly - benchmark_monthly).dropna().sort_values(ascending=False)

    return [
        {
            "month": index.strftime("%B %Y"),
            "spread": safe_float(value),
        }
        for index, value in difference.head(6).items()
    ]


def analyze_portfolio(payload):
    tickers = clean_tickers(payload.get("tickers", TICKERS))
    benchmark = clean_tickers([payload.get("benchmark", BENCHMARK_TICKER)])[0]
    start_date = payload.get("startDate") or START_DATE
    end_date = payload.get("endDate") or END_DATE
    min_weight = float(payload.get("minWeight", MIN_WEIGHT))
    training_window = int(payload.get("trainingWindow", TRAINING_WINDOW))
    rebalance_freq = int(payload.get("rebalanceFreq", REBALANCE_FREQ))
    linkage_method = payload.get("linkageMethod", "single")

    if len(tickers) < 2:
        raise ValueError("Select at least two assets for HRP clustering.")

    if min_weight * len(tickers) > 1:
        raise ValueError("The minimum weight is too high for the number of assets.")

    prices, benchmark_prices, ohlc = download_prices(
        tickers,
        benchmark,
        start_date,
        end_date,
    )

    if prices.empty or len(prices) < max(training_window + rebalance_freq, 100):
        raise ValueError("Not enough price history returned. Check the tickers or date range.")

    if benchmark_prices.empty:
        raise ValueError(f"No benchmark data returned for {benchmark}.")

    returns = process_returns(prices)
    hrp_model, weights = hrp_weights(returns, min_weight, linkage_method)
    strategy_returns = walk_forward(
        returns,
        training_window,
        rebalance_freq,
        min_weight,
        linkage_method,
    )

    benchmark_returns = benchmark_prices.pct_change().dropna()
    common_index = strategy_returns.index.intersection(benchmark_returns.index)
    strategy_returns = strategy_returns.loc[common_index]
    benchmark_returns = benchmark_returns.loc[common_index]

    if strategy_returns.empty:
        raise ValueError("The backtest window did not overlap with the benchmark.")

    strategy_cumulative = (1 + strategy_returns).cumprod()
    benchmark_cumulative = (1 + benchmark_returns).cumprod()
    upside_capture, downside_capture = calculate_capture(strategy_returns, benchmark_returns)

    weights_rows = [
        {
            "ticker": ticker,
            "weight": safe_float(weight),
            "floor": bool(weight <= min_weight + 0.001),
        }
        for ticker, weight in sorted(weights.items(), key=lambda item: item[1], reverse=True)
    ]

    latest_date = prices.dropna(how="all").index[-1].strftime("%Y-%m-%d")
    correlation = returns.corr().round(3)
    allocation_entropy = -sum(weight * math.log(weight) for weight in weights.values())
    effective_positions = math.exp(allocation_entropy)

    return {
        "config": {
            "tickers": tickers,
            "benchmark": benchmark,
            "startDate": start_date,
            "endDate": end_date,
            "latestDate": latest_date,
            "minWeight": min_weight,
            "trainingWindow": training_window,
            "rebalanceFreq": rebalance_freq,
            "linkageMethod": linkage_method,
        },
        "weights": weights_rows,
        "metrics": {
            "strategy": performance_metrics(strategy_returns),
            "benchmark": performance_metrics(benchmark_returns),
            "upsideCapture": upside_capture,
            "downsideCapture": downside_capture,
            "effectivePositions": safe_float(effective_positions),
            "largestWeight": safe_float(max(weights.values())),
            "smallestWeight": safe_float(min(weights.values())),
        },
        "series": {
            "equity": [
                {
                    "date": index.strftime("%Y-%m-%d"),
                    "strategy": safe_float(strategy_cumulative.loc[index]),
                    "benchmark": safe_float(benchmark_cumulative.loc[index]),
                }
                for index in common_index
            ],
            "drawdown": [
                {
                    "date": index.strftime("%Y-%m-%d"),
                    "strategy": safe_float(drawdown_series(strategy_cumulative).loc[index]),
                    "benchmark": safe_float(drawdown_series(benchmark_cumulative).loc[index]),
                }
                for index in common_index
            ],
        },
        "risk": {
            "correlation": {
                "tickers": list(correlation.index),
                "values": correlation.values.tolist(),
            },
            "volatility": [
                {"ticker": ticker, "value": safe_float(value)}
                for ticker, value in returns.std().sort_values(ascending=False).items()
            ],
        },
        "market": ticker_summary(prices, returns),
        "candles": candle_payload(ohlc, tickers),
        "events": event_returns(strategy_returns, benchmark_returns),
        "monthlyLeaders": monthly_outperformance(strategy_returns, benchmark_returns),
        "clusterCount": int(len(hrp_model.clusters)) if hrp_model.clusters is not None else 0,
    }


class DashboardHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)

        if path == "/api/health":
            self.send_json({"ok": True})
            return

        if path == "/":
            path = "/index.html"

        file_path = (FRONTEND_DIR / path.lstrip("/")).resolve()

        if not str(file_path).startswith(str(FRONTEND_DIR.resolve())):
            self.send_error(403)
            return

        if not file_path.exists() or not file_path.is_file():
            self.send_error(404)
            return

        content_type = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
        }.get(file_path.suffix, "application/octet-stream")

        body = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if urlparse(self.path).path != "/api/analyze":
            self.send_error(404)
            return

        try:
            content_length = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(content_length) or b"{}")
            result = analyze_portfolio(payload)
            self.send_json({"ok": True, "result": result})
        except Exception as error:
            self.send_json({"ok": False, "error": str(error)}, status=400)

    def log_message(self, format, *args):
        return

    def send_json(self, payload, status=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    parser = argparse.ArgumentParser(description="Run the HRP portfolio dashboard.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=8765, type=int)
    args = parser.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), DashboardHandler)
    print(f"Dashboard running at http://{args.host}:{args.port}")
    print("Press Ctrl+C to stop.")
    server.serve_forever()


if __name__ == "__main__":
    main()
