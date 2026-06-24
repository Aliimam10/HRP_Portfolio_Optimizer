"""Hierarchical Risk Parity portfolio manager.

The script downloads market data, builds a constrained HRP allocation,
and runs a walk-forward backtest against SPY.
"""

from datetime import datetime

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import yfinance as yf
from pypfopt import HRPOpt, plotting
from scipy.cluster import hierarchy as sch


TICKERS = [
    "NVDA",  # High-growth semiconductor exposure
    "AAPL",  # Large-cap consumer technology
    "AMZN",  # Cloud and online retail
    "JPM",  # Quality banking exposure
    "COST",  # Defensive consumer compounder
    "UNH",  # Healthcare exposure
    "TLT",  # Long-duration Treasury hedge
]

START_DATE = "2010-01-01"
END_DATE = datetime.today().strftime("%Y-%m-%d")

MIN_WEIGHT = 0.08
TRAINING_WINDOW = 504
REBALANCE_FREQ = 63
BENCHMARK_TICKER = "SPY"

SCIPY_LINKAGE_METHODS = {
    "single",
    "complete",
    "average",
    "weighted",
    "centroid",
    "median",
    "ward",
}


def patch_scipy_linkage_methods():
    """Keep PyPortfolioOpt compatible with newer SciPy releases."""
    if not hasattr(sch, "_LINKAGE_METHODS"):
        sch._LINKAGE_METHODS = SCIPY_LINKAGE_METHODS


def fetch_data(tickers, start, end):
    print(f"--- Downloading data from {start} to {end} ---")

    data = yf.download(
        tickers,
        start=start,
        end=end,
        auto_adjust=True,
        progress=False,
    )["Close"]

    data = data.ffill().dropna()

    print(f"Data downloaded successfully. Shape: {data.shape}")
    return data


def process_returns(price_data):
    print("\n--- Calculating returns and trimming outliers ---")

    returns = price_data.pct_change().dropna()

    # Clip the most extreme daily moves so one bad print does not steer the model.
    lower_limit = returns.quantile(0.01)
    upper_limit = returns.quantile(0.99)
    clean_returns = returns.clip(lower=lower_limit, upper=upper_limit, axis=1)

    print("Outliers clipped at the 1st and 99th percentiles.")
    return clean_returns


def enforce_min_weights(weights_dict, min_weight=MIN_WEIGHT):
    """Apply a minimum position size and rescale the remaining weights."""
    weights = pd.Series(weights_dict, dtype=float)

    if min_weight * len(weights) > 1:
        raise ValueError("Minimum weight is too high for the number of assets.")

    weights[weights < min_weight] = min_weight

    fixed_total = weights[weights == min_weight].sum()
    flexible_assets = weights[weights > min_weight].index

    if len(flexible_assets) > 0:
        remaining_budget = 1.0 - fixed_total
        current_flexible_total = weights[flexible_assets].sum()
        weights[flexible_assets] *= remaining_budget / current_flexible_total

    return weights.to_dict()


def run_hrp_model(returns_data):
    print("\n--- Training HRP model ---")

    patch_scipy_linkage_methods()
    hrp = HRPOpt(returns=returns_data)
    raw_weights = hrp.optimize()
    final_weights = enforce_min_weights(raw_weights)

    print(f"Applied minimum weight constraint: {MIN_WEIGHT:.0%}")
    print("Optimization complete.")
    return hrp, final_weights


def get_hrp_weights(historical_data):
    """Calculate HRP weights from the available lookback window."""
    try:
        patch_scipy_linkage_methods()
        hrp = HRPOpt(returns=historical_data)
        weights = hrp.optimize()
        return enforce_min_weights(weights)
    except Exception:
        n_assets = historical_data.shape[1]
        return {ticker: 1.0 / n_assets for ticker in historical_data.columns}


def run_walk_forward(returns_data):
    print(f"\n--- Starting walk-forward backtest ({len(returns_data)} trading days) ---")

    portfolio_history = []
    rebalance_dates = range(TRAINING_WINDOW, len(returns_data), REBALANCE_FREQ)

    for rebalance_index in rebalance_dates:
        train_window = returns_data.iloc[
            rebalance_index - TRAINING_WINDOW : rebalance_index
        ]
        test_window = returns_data.iloc[
            rebalance_index : rebalance_index + REBALANCE_FREQ
        ]

        # The backtest only uses weights chosen before this test period begins.
        weights = pd.Series(get_hrp_weights(train_window))
        period_returns = (test_window * weights).sum(axis=1)
        portfolio_history.append(period_returns)

    full_curve = pd.concat(portfolio_history)

    print("Backtest complete.")
    return full_curve


def get_close_prices(ticker, start, end):
    data = yf.download(ticker, start=start, end=end, auto_adjust=True, progress=False)

    if isinstance(data, pd.DataFrame):
        if "Close" in data.columns:
            data = data["Close"]
        elif "Adj Close" in data.columns:
            data = data["Adj Close"]

        if isinstance(data, pd.DataFrame):
            data = data.iloc[:, 0]

    return data


def to_scalar(value):
    return value.item() if hasattr(value, "item") else value


def max_drawdown(series):
    rolling_peak = series.cummax()
    drawdown = (series - rolling_peak) / rolling_peak
    return drawdown.min()


def generate_standard_report(strategy_returns, benchmark_ticker=BENCHMARK_TICKER):
    print(f"\n--- Fetching benchmark ({benchmark_ticker}) ---")

    start = strategy_returns.index[0]
    end = strategy_returns.index[-1]
    benchmark_prices = get_close_prices(benchmark_ticker, start, end)
    benchmark_returns = benchmark_prices.pct_change().dropna()

    common_index = strategy_returns.index.intersection(benchmark_returns.index)
    strategy = strategy_returns.loc[common_index]
    benchmark = benchmark_returns.loc[common_index]

    cumulative_strategy = (1 + strategy).cumprod()
    cumulative_benchmark = (1 + benchmark).cumprod()

    sharpe_strategy = (strategy.mean() / strategy.std()) * np.sqrt(252)
    sharpe_benchmark = (benchmark.mean() / benchmark.std()) * np.sqrt(252)

    mdd_strategy = max_drawdown(cumulative_strategy)
    mdd_benchmark = max_drawdown(cumulative_benchmark)

    print("\n====== Standard Performance Report ======")
    print(f"{'Metric':<20} | {'HRP Strategy':<15} | {'S&P 500 (SPY)':<15}")
    print("-" * 55)
    print(
        f"{'Total Return':<20} | "
        f"{(to_scalar(cumulative_strategy.iloc[-1]) - 1) * 100:.2f}% | "
        f"{(to_scalar(cumulative_benchmark.iloc[-1]) - 1) * 100:.2f}%"
    )
    print(
        f"{'Max Drawdown':<20} | "
        f"{to_scalar(mdd_strategy) * 100:.2f}% | "
        f"{to_scalar(mdd_benchmark) * 100:.2f}%"
    )
    print(
        f"{'Sharpe Ratio':<20} | "
        f"{to_scalar(sharpe_strategy):.2f}   | "
        f"{to_scalar(sharpe_benchmark):.2f}"
    )

    plt.figure(figsize=(12, 6))
    plt.plot(
        cumulative_strategy,
        label="HRP Barbell Portfolio",
        color="#2ecc71",
        linewidth=2,
    )
    plt.plot(
        cumulative_benchmark,
        label="S&P 500",
        color="gray",
        linestyle="--",
        alpha=0.6,
    )
    plt.title("HRP vs S&P 500: Wealth Preservation Test", fontsize=14)
    plt.ylabel("Growth of $1 Investment")
    plt.legend()
    plt.grid(True, alpha=0.3)
    plt.show()

    return strategy, benchmark


def analyze_defensive_metrics(strategy_returns, benchmark_returns):
    print("\n====== Defensive Metrics ======")

    up_market = benchmark_returns[benchmark_returns > 0]
    strategy_up = strategy_returns[benchmark_returns > 0]
    upside_capture = strategy_up.mean() / up_market.mean()

    down_market = benchmark_returns[benchmark_returns < 0]
    strategy_down = strategy_returns[benchmark_returns < 0]
    downside_capture = strategy_down.mean() / down_market.mean()

    win_rate = (strategy_returns > 0).sum() / len(strategy_returns)

    print(f"Upside Capture:   {to_scalar(upside_capture) * 100:.2f}%")
    print(f"Downside Capture: {to_scalar(downside_capture) * 100:.2f}%")
    print(f"Win Rate (Days):  {to_scalar(win_rate) * 100:.2f}%")
    print("-" * 50)

    if to_scalar(downside_capture) < 0.6:
        print("Success: the portfolio avoided a large share of market losses.")
    else:
        print("Note: downside protection is close to average.")


def show_top_wins(strategy_returns, benchmark_returns):
    print("\n====== Event Check ======")

    common_index = strategy_returns.index.intersection(benchmark_returns.index)
    strategy = strategy_returns.loc[common_index]
    benchmark = benchmark_returns.loc[common_index]

    events = [
        ("COVID Crash", "2020-02-19", "2020-03-23"),
        ("Post-COVID Rally", "2020-03-23", "2020-08-01"),
        ("2022 Inflation Bear", "2022-01-01", "2022-10-12"),
        ("AI Boom (Nvidia)", "2023-01-01", "2023-07-31"),
    ]

    print(f"{'Event':<20} | {'HRP Return':<12} | {'S&P 500':<12}")
    print("-" * 65)

    for name, start_date, end_date in events:
        strategy_period = strategy.loc[start_date:end_date]
        benchmark_period = benchmark.loc[start_date:end_date]

        if strategy_period.empty or benchmark_period.empty:
            print(f"{name:<20} |   N/A        |   N/A")
            continue

        strategy_total = (1 + strategy_period).prod() - 1
        benchmark_total = (1 + benchmark_period).prod() - 1

        print(
            f"{name:<20} | "
            f"{to_scalar(strategy_total) * 100:6.2f}%      | "
            f"{to_scalar(benchmark_total) * 100:6.2f}%"
        )

    print("-" * 65)

    strategy_monthly = strategy.resample("ME").apply(lambda x: (1 + x).prod() - 1)
    benchmark_monthly = benchmark.resample("ME").apply(lambda x: (1 + x).prod() - 1)
    monthly_difference = strategy_monthly - benchmark_monthly

    best_month = monthly_difference.idxmax()
    best_value = monthly_difference.max()

    print(f"\nBest single month: {best_month.strftime('%B %Y')}")
    print(f"HRP beat the benchmark by {to_scalar(best_value) * 100:.2f}% that month.")


def plot_cluster_tree(hrp_instance):
    plt.figure(figsize=(12, 6))
    plt.title("HRP Dendrogram (Blue Chip Clustering)", fontsize=14)
    plt.xlabel("Assets")
    plt.ylabel("Distance (Correlation)")
    plotting.plot_dendrogram(hrp_instance, show_tickers=True)
    plt.show()


def plot_allocation(weights_dict):
    weights = pd.Series(weights_dict).sort_values(ascending=True)

    # Gray marks assets pinned to the floor; blue marks positions with more room.
    colors = [
        "#4c72b0" if weight > MIN_WEIGHT + 0.001 else "#A9A9A9"
        for weight in weights
    ]

    plt.figure(figsize=(10, 6))
    weights.plot(kind="barh", color=colors)
    plt.title(f"Final Constrained Portfolio (Min {MIN_WEIGHT:.0%})", fontsize=14)
    plt.xlabel("Weight")
    plt.grid(axis="x", linestyle="--", alpha=0.5)

    for index, value in enumerate(weights):
        plt.text(value, index, f" {value * 100:.1f}%", va="center")

    plt.show()


def print_data_checks(clean_returns):
    print("\n--- Data Check: Last 5 Days ---")
    print(clean_returns.tail())

    print("\n--- Volatility Ranking ---")
    print(clean_returns.std().sort_values(ascending=False))


def print_portfolio_weights(weights):
    print("\n--- Final Portfolio Weights ---")
    for ticker, weight in weights.items():
        print(f"{ticker}: {weight * 100:.2f}%")


def main():
    prices = fetch_data(TICKERS, START_DATE, END_DATE)
    clean_returns = process_returns(prices)
    print_data_checks(clean_returns)

    hrp_model, optimal_weights = run_hrp_model(clean_returns)
    print_portfolio_weights(optimal_weights)
    plot_cluster_tree(hrp_model)
    plot_allocation(optimal_weights)

    strategy_curve = run_walk_forward(clean_returns)
    strategy_returns, benchmark_returns = generate_standard_report(strategy_curve)
    analyze_defensive_metrics(strategy_returns, benchmark_returns)
    show_top_wins(strategy_returns, benchmark_returns)


if __name__ == "__main__":
    main()
