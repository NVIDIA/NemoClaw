# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Generate synthetic sensor data with minute-level timestamps."""

import os
import numpy as np
import pandas as pd

SEED = 42
N_MINUTES = 60_000  # ~41 days of minute-level data


def generate():
    if os.path.exists("sensor_data.csv"):
        return

    rng = np.random.default_rng(SEED)

    timestamps = pd.date_range(
        start="2024-01-01", periods=N_MINUTES, freq="min"
    )

    # Simulate three sensors with seasonal patterns and noise
    hour_of_day = timestamps.hour + timestamps.minute / 60.0
    day_cycle = np.sin(2 * np.pi * hour_of_day / 24.0)

    df = pd.DataFrame({
        "timestamp": timestamps,
        "sensor_id": rng.choice(["S1", "S2", "S3"], N_MINUTES),
        "temperature": 20.0 + 5.0 * day_cycle + rng.normal(0, 0.5, N_MINUTES),
        "humidity": 60.0 - 10.0 * day_cycle + rng.normal(0, 2.0, N_MINUTES),
        "pressure": 1013.0 + rng.normal(0, 3.0, N_MINUTES),
        "voltage": 3.3 + rng.normal(0, 0.05, N_MINUTES),
    })

    df["temperature"] = np.round(df["temperature"], 2)
    df["humidity"] = np.clip(np.round(df["humidity"], 1), 0, 100)
    df["pressure"] = np.round(df["pressure"], 1)
    df["voltage"] = np.round(df["voltage"], 3)

    df.to_csv("sensor_data.csv", index=False)
    print(f"Generated {len(df)} sensor readings -> sensor_data.csv")


if __name__ == "__main__":
    generate()
