# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Generate synthetic insurance claims data for UDF processing."""

import os
import numpy as np
import pandas as pd

SEED = 42
N_ROWS = 40_000


def generate():
    if os.path.exists("claims.csv"):
        return

    rng = np.random.default_rng(SEED)

    policy_types = ["auto", "home", "health", "life", "travel"]
    risk_levels = ["low", "medium", "high"]
    regions = ["northeast", "southeast", "midwest", "west", "pacific"]

    df = pd.DataFrame({
        "claim_id": range(N_ROWS),
        "policy_type": rng.choice(policy_types, N_ROWS),
        "risk_level": rng.choice(risk_levels, N_ROWS, p=[0.5, 0.35, 0.15]),
        "region": rng.choice(regions, N_ROWS),
        "age": rng.integers(18, 85, N_ROWS),
        "claim_amount": np.round(rng.exponential(5000, N_ROWS), 2),
        "deductible": np.round(rng.choice([250, 500, 1000, 2000, 5000], N_ROWS).astype(float), 2),
        "premium_monthly": np.round(rng.uniform(50, 800, N_ROWS), 2),
        "years_as_customer": rng.integers(0, 30, N_ROWS),
        "num_prior_claims": rng.integers(0, 10, N_ROWS),
        "credit_score": rng.integers(300, 850, N_ROWS),
        "property_value": np.round(rng.uniform(50_000, 1_000_000, N_ROWS), 2),
    })

    df.to_csv("claims.csv", index=False)
    print(f"Generated {len(df)} insurance claims -> claims.csv")


if __name__ == "__main__":
    generate()
