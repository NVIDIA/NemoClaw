# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Generate synthetic stock trading data for window function analysis."""

import os
import numpy as np
import pandas as pd

SEED = 42
N_DAYS = 500
N_STOCKS = 50


def generate():
    if os.path.exists("stock_trades.csv"):
        return

    rng = np.random.default_rng(SEED)

    dates = pd.bdate_range(start="2022-01-03", periods=N_DAYS)
    tickers = [f"STK{i:03d}" for i in range(N_STOCKS)]

    rows = []
    for ticker in tickers:
        base_price = rng.uniform(10, 500)
        prices = [base_price]
        for _ in range(N_DAYS - 1):
            change = rng.normal(0, base_price * 0.02)
            prices.append(max(1.0, prices[-1] + change))

        for i, date in enumerate(dates):
            rows.append({
                "date": date,
                "ticker": ticker,
                "close": round(prices[i], 2),
                "volume": int(rng.integers(10_000, 5_000_000)),
                "high": round(prices[i] * (1 + rng.uniform(0, 0.03)), 2),
                "low": round(prices[i] * (1 - rng.uniform(0, 0.03)), 2),
            })

    df = pd.DataFrame(rows)
    df["trade_value"] = df["close"] * df["volume"]
    df.to_csv("stock_trades.csv", index=False)
    print(f"Generated {len(df)} stock trade rows -> stock_trades.csv")


if __name__ == "__main__":
    generate()
