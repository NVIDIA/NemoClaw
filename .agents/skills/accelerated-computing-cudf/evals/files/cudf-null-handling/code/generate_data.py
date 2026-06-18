# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Generate synthetic data with intentional null patterns."""

import os
import numpy as np
import pandas as pd

SEED = 42
N_ROWS = 40_000


def generate():
    if os.path.exists("messy_data.csv"):
        return

    rng = np.random.default_rng(SEED)

    df = pd.DataFrame({
        "id": range(N_ROWS),
        "group": rng.choice(["A", "B", "C", "D"], N_ROWS),
        "temperature": rng.normal(22.0, 3.0, N_ROWS),
        "humidity": rng.uniform(20, 90, N_ROWS),
        "pressure": rng.normal(1013, 5, N_ROWS),
        "wind_speed": rng.exponential(10, N_ROWS),
        "visibility": rng.uniform(1, 30, N_ROWS),
        "uv_index": rng.integers(0, 12, N_ROWS).astype(float),
        "air_quality": rng.choice(["good", "moderate", "poor", "hazardous"], N_ROWS),
        "station_code": rng.choice(["ST01", "ST02", "ST03", "ST04", "ST05"], N_ROWS),
    })

    # Introduce nulls with different patterns
    # Random scattered nulls (~15% each)
    for col in ["temperature", "humidity", "pressure"]:
        mask = rng.random(N_ROWS) < 0.15
        df.loc[mask, col] = np.nan

    # Block nulls (sensor offline for stretches)
    for start in [5000, 15000, 28000]:
        df.loc[start:start + 500, "wind_speed"] = np.nan
        df.loc[start:start + 300, "visibility"] = np.nan

    # Correlated nulls (uv_index missing when visibility is low)
    low_vis = df["visibility"] < 5
    df.loc[low_vis & (rng.random(N_ROWS) < 0.7), "uv_index"] = np.nan

    # String column nulls
    str_mask = rng.random(N_ROWS) < 0.10
    df.loc[str_mask, "air_quality"] = np.nan

    df["temperature"] = df["temperature"].round(2)
    df["humidity"] = df["humidity"].round(1)
    df["pressure"] = df["pressure"].round(1)
    df["wind_speed"] = df["wind_speed"].round(2)
    df["visibility"] = df["visibility"].round(1)

    df.to_csv("messy_data.csv", index=False)
    null_pcts = df.isnull().mean() * 100
    print(f"Generated {len(df)} rows with null percentages:\n{null_pcts.to_string()}")


if __name__ == "__main__":
    generate()
