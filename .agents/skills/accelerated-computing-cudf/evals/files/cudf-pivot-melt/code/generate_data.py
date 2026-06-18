# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Generate synthetic retail sales data for pivot/melt operations."""

import os
import numpy as np
import pandas as pd

SEED = 42
N_ROWS = 60_000


def generate():
    if os.path.exists("retail_sales.csv"):
        return

    rng = np.random.default_rng(SEED)

    stores = [f"Store_{i:02d}" for i in range(1, 16)]
    products = ["Laptop", "Phone", "Tablet", "Headphones", "Charger",
                "Case", "Cable", "Monitor", "Keyboard", "Mouse"]
    quarters = ["Q1", "Q2", "Q3", "Q4"]
    years = [2022, 2023, 2024]
    channels = ["online", "in-store", "phone"]

    df = pd.DataFrame({
        "transaction_id": range(N_ROWS),
        "store": rng.choice(stores, N_ROWS),
        "product": rng.choice(products, N_ROWS),
        "year": rng.choice(years, N_ROWS),
        "quarter": rng.choice(quarters, N_ROWS),
        "channel": rng.choice(channels, N_ROWS, p=[0.5, 0.35, 0.15]),
        "units_sold": rng.integers(1, 20, N_ROWS),
        "revenue": np.round(rng.uniform(10, 2000, N_ROWS), 2),
        "cost": np.round(rng.uniform(5, 1500, N_ROWS), 2),
        "customer_satisfaction": rng.integers(1, 6, N_ROWS),
    })

    df["profit"] = df["revenue"] - df["cost"]

    df.to_csv("retail_sales.csv", index=False)
    print(f"Generated {len(df)} retail sales rows -> retail_sales.csv")


if __name__ == "__main__":
    generate()
