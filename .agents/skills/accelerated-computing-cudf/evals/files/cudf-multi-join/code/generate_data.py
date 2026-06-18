# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Generate three related CSVs: orders, customers, products."""

import os
import numpy as np
import pandas as pd

SEED = 42
N_CUSTOMERS = 3_000
N_PRODUCTS = 200
N_ORDERS = 80_000


def generate():
    if os.path.exists("orders.csv"):
        return

    rng = np.random.default_rng(SEED)

    # --- customers ---
    tiers = ["bronze", "silver", "gold", "platinum"]
    customers = pd.DataFrame({
        "customer_id": range(N_CUSTOMERS),
        "customer_name": [f"Cust_{i:05d}" for i in range(N_CUSTOMERS)],
        "tier": rng.choice(tiers, N_CUSTOMERS, p=[0.4, 0.3, 0.2, 0.1]),
        "country": rng.choice(["US", "UK", "DE", "JP", "BR", "IN"], N_CUSTOMERS),
        "credit_limit": np.round(rng.uniform(500, 50_000, N_CUSTOMERS), 2),
    })

    # --- products ---
    categories = ["electronics", "clothing", "food", "tools", "toys"]
    products = pd.DataFrame({
        "product_id": range(N_PRODUCTS),
        "product_name": [f"Prod_{i:04d}" for i in range(N_PRODUCTS)],
        "category": rng.choice(categories, N_PRODUCTS),
        "base_price": np.round(rng.uniform(2.0, 800.0, N_PRODUCTS), 2),
        "weight_kg": np.round(rng.uniform(0.1, 30.0, N_PRODUCTS), 2),
    })

    # --- orders (some customer_ids intentionally out of range to test left join) ---
    orders = pd.DataFrame({
        "order_id": range(N_ORDERS),
        "customer_id": rng.integers(0, N_CUSTOMERS + 200, N_ORDERS),
        "product_id": rng.integers(0, N_PRODUCTS, N_ORDERS),
        "quantity": rng.integers(1, 20, N_ORDERS),
        "order_total": np.round(rng.uniform(5.0, 2000.0, N_ORDERS), 2),
        "channel": rng.choice(["web", "mobile", "store", "phone"], N_ORDERS),
    })

    customers.to_csv("customers.csv", index=False)
    products.to_csv("products.csv", index=False)
    orders.to_csv("orders.csv", index=False)
    print(f"Generated {N_CUSTOMERS} customers, {N_PRODUCTS} products, {N_ORDERS} orders")


if __name__ == "__main__":
    generate()
