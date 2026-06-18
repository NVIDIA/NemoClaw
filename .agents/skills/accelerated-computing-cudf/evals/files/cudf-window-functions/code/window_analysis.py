# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Window function analysis on stock trading data.

Computes rankings, cumulative sums, rolling averages, expanding statistics,
and shift/lag features for each stock ticker.
"""

import numpy as np
import pandas as pd

from generate_data import generate


def load_data():
    generate()
    df = pd.read_csv("stock_trades.csv", parse_dates=["date"])
    df = df.sort_values(["ticker", "date"])
    print(f"Loaded {len(df)} trades for {df['ticker'].nunique()} tickers")
    return df


def add_rankings(df):
    """Rank stocks by close price and volume within each date."""
    df["price_rank_dense"] = df.groupby("date")["close"].rank(
        method="dense", ascending=False
    )
    df["price_rank_min"] = df.groupby("date")["close"].rank(
        method="min", ascending=False
    )
    df["volume_rank"] = df.groupby("date")["volume"].rank(
        method="average", ascending=False
    )
    df["price_pctrank"] = df.groupby("date")["close"].rank(pct=True)
    print(f"Rankings added; top stock on last day: "
          f"rank 1 = {df.loc[df['price_rank_dense'] == 1].tail(1)['ticker'].values}")
    return df


def add_cumulative(df):
    """Compute cumulative statistics per ticker."""
    df["cumsum_volume"] = df.groupby("ticker")["volume"].cumsum()
    df["cumsum_trade_value"] = df.groupby("ticker")["trade_value"].cumsum()
    df["cummax_close"] = df.groupby("ticker")["close"].cummax()
    df["cummin_close"] = df.groupby("ticker")["close"].cummin()
    df["cum_avg_close"] = df["cumsum_trade_value"] / df["cumsum_volume"]
    print("Cumulative stats added")
    return df


def add_rolling_stats(df):
    """Compute rolling window statistics per ticker."""
    rolling_frames = []
    for ticker, group in df.groupby("ticker"):
        g = group.sort_values("date").copy()

        # 5-day and 20-day rolling averages
        g["sma_5"] = g["close"].rolling(window=5, min_periods=1).mean()
        g["sma_20"] = g["close"].rolling(window=20, min_periods=5).mean()

        # Rolling standard deviation (volatility)
        g["volatility_20"] = g["close"].rolling(window=20, min_periods=5).std()

        # Rolling min/max (support/resistance levels)
        g["rolling_high_20"] = g["high"].rolling(window=20, min_periods=5).max()
        g["rolling_low_20"] = g["low"].rolling(window=20, min_periods=5).min()

        # Rolling sum of volume
        g["volume_sum_10"] = g["volume"].rolling(window=10, min_periods=1).sum()

        rolling_frames.append(g)

    result = pd.concat(rolling_frames, ignore_index=True)
    print("Rolling stats added (SMA-5, SMA-20, volatility, support/resistance)")
    return result


def add_expanding_stats(df):
    """Compute expanding window statistics per ticker."""
    expanding_frames = []
    for ticker, group in df.groupby("ticker"):
        g = group.sort_values("date").copy()

        g["expanding_mean"] = g["close"].expanding(min_periods=1).mean()
        g["expanding_std"] = g["close"].expanding(min_periods=2).std()
        g["expanding_max"] = g["close"].expanding(min_periods=1).max()
        g["expanding_min"] = g["close"].expanding(min_periods=1).min()

        expanding_frames.append(g)

    result = pd.concat(expanding_frames, ignore_index=True)
    print("Expanding stats added")
    return result


def add_shift_features(df):
    """Compute lag/lead features and returns."""
    shift_frames = []
    for ticker, group in df.groupby("ticker"):
        g = group.sort_values("date").copy()

        # Lag features
        g["prev_close"] = g["close"].shift(1)
        g["prev_close_5"] = g["close"].shift(5)

        # Daily return
        g["daily_return"] = (g["close"] - g["prev_close"]) / g["prev_close"]

        # 5-day return
        g["return_5d"] = (g["close"] - g["prev_close_5"]) / g["prev_close_5"]

        # Lead (next day close)
        g["next_close"] = g["close"].shift(-1)

        # Diff
        g["close_diff"] = g["close"].diff()
        g["volume_diff"] = g["volume"].diff()

        shift_frames.append(g)

    result = pd.concat(shift_frames, ignore_index=True)
    print("Shift/lag features added (returns, diffs, leads)")
    return result


def generate_signals(df):
    """Simple moving average crossover signals."""
    df["sma_cross"] = (df["sma_5"] > df["sma_20"]).astype(int)
    df["signal_change"] = df.groupby("ticker")["sma_cross"].diff().fillna(0).astype(int)
    buy_signals = (df["signal_change"] == 1).sum()
    sell_signals = (df["signal_change"] == -1).sum()
    print(f"Signals: {buy_signals} buys, {sell_signals} sells")
    return df


def main():
    df = load_data()
    df = add_rankings(df)
    df = add_cumulative(df)
    df = add_rolling_stats(df)
    df = add_expanding_stats(df)
    df = add_shift_features(df)
    df = generate_signals(df)

    print(f"\nFinal shape: {df.shape}")
    sample = df[df["ticker"] == "STK000"].tail(5)
    print(f"\nSample (STK000 last 5 days):\n"
          f"{sample[['date', 'close', 'sma_5', 'sma_20', 'daily_return', 'price_rank_dense']].to_string(index=False)}")


if __name__ == "__main__":
    main()
