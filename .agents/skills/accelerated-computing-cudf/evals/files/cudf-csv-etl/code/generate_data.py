# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Generate a synthetic sales CSV for the ETL pipeline."""

import os
import numpy as np
import pandas as pd

SEED = 42
N_ROWS = 50_000


def generate():
    if os.path.exists("sales.csv"):
        return

    rng = np.random.default_rng(SEED)

    regions = ["North", "South", "East", "West"]
    products = ["Widget", "Gadget", "Doohickey", "Thingamajig", "Whatchamacallit"]
    statuses = ["completed", "pending", "returned", "cancelled"]

    df = pd.DataFrame({
        "order_id": range(N_ROWS),
        "region": rng.choice(regions, N_ROWS),
        "product": rng.choice(products, N_ROWS),
        "quantity": rng.integers(1, 50, N_ROWS),
        "unit_price": np.round(rng.uniform(5.0, 500.0, N_ROWS), 2),
        "discount_pct": np.round(rng.uniform(0.0, 0.3, N_ROWS), 3),
        "status": rng.choice(statuses, N_ROWS, p=[0.7, 0.1, 0.1, 0.1]),
        "customer_age": rng.integers(18, 80, N_ROWS),
    })

    df.to_csv("sales.csv", index=False)
    print(f"Generated {len(df)} rows -> sales.csv")


if __name__ == "__main__":
    generate()
