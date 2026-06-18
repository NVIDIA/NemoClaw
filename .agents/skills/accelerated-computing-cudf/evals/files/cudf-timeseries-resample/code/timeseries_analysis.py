# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Timeseries resampling and rolling statistics pipeline.

Reads minute-level sensor data, resamples to hourly and daily frequencies,
and computes rolling window statistics for anomaly detection thresholds.
"""

import numpy as np
import pandas as pd

from generate_data import generate


def load_data():
    generate()
    df = pd.read_csv("sensor_data.csv", parse_dates=["timestamp"])
    df = df.sort_values("timestamp")
    print(f"Loaded {len(df)} sensor readings from "
          f"{df['timestamp'].min()} to {df['timestamp'].max()}")
    return df


def resample_hourly(df):
    """Resample each sensor to hourly frequency."""
    hourly_frames = []
    for sensor_id, group in df.groupby("sensor_id"):
        ts = group.set_index("timestamp")
        hourly = ts[["temperature", "humidity", "pressure", "voltage"]].resample("h").agg(
            ["mean", "min", "max", "std"]
        )
        # Flatten multi-level columns
        hourly.columns = ["_".join(col) for col in hourly.columns]
        hourly["sensor_id"] = sensor_id
        hourly = hourly.reset_index()
        hourly_frames.append(hourly)

    result = pd.concat(hourly_frames, ignore_index=True)
    print(f"Hourly resampled: {len(result)} rows")
    return result


def resample_daily(df):
    """Resample all sensors to daily frequency with aggregation."""
    ts = df.set_index("timestamp")
    daily = ts.groupby("sensor_id").resample("D").agg({
        "temperature": ["mean", "min", "max"],
        "humidity": ["mean", "min", "max"],
        "pressure": "mean",
        "voltage": "mean",
    })
    daily.columns = ["_".join(col) for col in daily.columns]
    daily = daily.reset_index()
    print(f"Daily resampled: {len(daily)} rows")
    return daily


def compute_rolling_stats(hourly):
    """Compute rolling 24-hour statistics on the hourly data."""
    rolling_frames = []
    for sensor_id, group in hourly.groupby("sensor_id"):
        g = group.sort_values("timestamp").copy()
        g["temp_rolling_mean_24h"] = (
            g["temperature_mean"].rolling(window=24, min_periods=6).mean()
        )
        g["temp_rolling_std_24h"] = (
            g["temperature_mean"].rolling(window=24, min_periods=6).std()
        )
        g["humidity_rolling_mean_24h"] = (
            g["humidity_mean"].rolling(window=24, min_periods=6).mean()
        )
        g["pressure_expanding_mean"] = g["pressure_mean"].expanding(min_periods=1).mean()

        # Anomaly flag: temperature deviates more than 2 std from rolling mean
        g["temp_anomaly"] = (
            (g["temperature_mean"] - g["temp_rolling_mean_24h"]).abs()
            > 2 * g["temp_rolling_std_24h"]
        ).astype(int)

        rolling_frames.append(g)

    result = pd.concat(rolling_frames, ignore_index=True)
    anomaly_count = result["temp_anomaly"].sum()
    print(f"Rolling stats computed; {anomaly_count} temperature anomalies detected")
    return result


def compute_daily_change(daily):
    """Compute day-over-day changes using shift."""
    change_frames = []
    for sensor_id, group in daily.groupby("sensor_id"):
        g = group.sort_values("timestamp").copy()
        g["temp_change"] = g["temperature_mean"] - g["temperature_mean"].shift(1)
        g["humidity_change"] = g["humidity_mean"] - g["humidity_mean"].shift(1)
        g["temp_cummax"] = g["temperature_max"].cummax()
        g["temp_cummin"] = g["temperature_min"].cummin()
        change_frames.append(g)

    result = pd.concat(change_frames, ignore_index=True)
    print(f"Daily changes computed for {result['sensor_id'].nunique()} sensors")
    return result


def main():
    df = load_data()
    hourly = resample_hourly(df)
    daily = resample_daily(df)
    hourly_with_rolling = compute_rolling_stats(hourly)
    daily_with_changes = compute_daily_change(daily)

    print(f"\nHourly sample:\n{hourly_with_rolling.head(3).to_string(index=False)}")
    print(f"\nDaily sample:\n{daily_with_changes.head(3).to_string(index=False)}")


if __name__ == "__main__":
    main()
