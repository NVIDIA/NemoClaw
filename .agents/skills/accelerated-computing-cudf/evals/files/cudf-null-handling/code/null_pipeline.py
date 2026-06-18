# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Null handling pipeline: detect, fill, drop, interpolate, and report.

Demonstrates various pandas null-handling strategies on messy weather data.
"""

import numpy as np
import pandas as pd

from generate_data import generate


def load_data():
    generate()
    df = pd.read_csv("messy_data.csv")
    print(f"Loaded {len(df)} rows")
    print(f"Null counts:\n{df.isnull().sum()}")
    return df


def analyze_nulls(df):
    """Build a null analysis report."""
    null_counts = df.isnull().sum()
    null_pcts = df.isnull().mean() * 100
    report = pd.DataFrame({
        "null_count": null_counts,
        "null_pct": null_pcts.round(2),
        "dtype": df.dtypes,
    })

    # Per-group null rates
    group_nulls = df.groupby("group").apply(
        lambda g: g.isnull().sum()
    ).reset_index()
    print(f"Null report:\n{report}")
    return report, group_nulls


def fill_with_strategies(df):
    """Apply different fill strategies to different columns."""
    filled = df.copy()

    # Scalar fill
    filled["uv_index"] = filled["uv_index"].fillna(0)

    # Dict fill (different values per column)
    filled = filled.fillna({
        "air_quality": "unknown",
        "visibility": filled["visibility"].median(),
    })

    # Forward fill for block-missing wind data
    filled["wind_speed"] = filled["wind_speed"].ffill()
    # Backward fill for any remaining at the start
    filled["wind_speed"] = filled["wind_speed"].bfill()

    # Group-specific mean fill for temperature
    group_means = df.groupby("group")["temperature"].transform("mean")
    filled["temperature"] = filled["temperature"].fillna(group_means)

    # Conditional fill: humidity depends on air_quality
    quality_median = df.groupby("air_quality")["humidity"].median()
    for quality, median_val in quality_median.items():
        mask = filled["humidity"].isna() & (filled["air_quality"] == quality)
        filled.loc[mask, "humidity"] = median_val
    # Fill remaining humidity nulls with global median
    filled["humidity"] = filled["humidity"].fillna(filled["humidity"].median())

    print(f"After fills, remaining nulls:\n{filled.isnull().sum()}")
    return filled


def interpolate_pressure(df):
    """Interpolate pressure readings within each station."""
    interp_frames = []
    for station, group in df.groupby("station_code"):
        g = group.copy()
        g["pressure"] = g["pressure"].interpolate(method="linear", limit=10)
        g["pressure"] = g["pressure"].bfill().ffill()
        interp_frames.append(g)
    result = pd.concat(interp_frames, ignore_index=True)
    remaining = result["pressure"].isna().sum()
    print(f"After interpolation, {remaining} pressure nulls remain")
    return result


def dropna_analysis(df):
    """Demonstrate dropna with various parameters."""
    # Drop rows where all numeric columns are null
    numeric_cols = df.select_dtypes(include=[np.number]).columns.tolist()
    dropped_all = df.dropna(subset=numeric_cols, how="all")
    print(f"dropna(how='all') on numeric: {len(df)} -> {len(dropped_all)}")

    # Drop rows where more than 3 columns are null
    dropped_thresh = df.dropna(thresh=len(df.columns) - 3)
    print(f"dropna(thresh={len(df.columns) - 3}): {len(df)} -> {len(dropped_thresh)}")

    # Drop rows with any null in key columns
    key_cols = ["temperature", "humidity", "pressure"]
    dropped_subset = df.dropna(subset=key_cols)
    print(f"dropna(subset={key_cols}): {len(df)} -> {len(dropped_subset)}")

    return dropped_subset


def create_null_indicators(df):
    """Create boolean indicator columns for null patterns."""
    indicator_cols = ["temperature", "humidity", "pressure", "wind_speed", "uv_index"]

    for col in indicator_cols:
        df[f"{col}_missing"] = df[col].isna().astype(int)

    df["total_missing"] = df[[f"{c}_missing" for c in indicator_cols]].sum(axis=1)
    df["has_any_missing"] = (df["total_missing"] > 0).astype(int)

    # Null pattern string
    df["null_pattern"] = ""
    for col in indicator_cols:
        df["null_pattern"] = df["null_pattern"] + df[f"{col}_missing"].astype(str)

    pattern_counts = df["null_pattern"].value_counts().head(10)
    print(f"\nTop null patterns:\n{pattern_counts}")

    return df


def main():
    df = load_data()
    report, group_nulls = analyze_nulls(df)
    df_with_indicators = create_null_indicators(df)
    dropped = dropna_analysis(df)
    filled = fill_with_strategies(df)
    result = interpolate_pressure(filled)

    print(f"\nFinal null check:\n{result.isnull().sum()}")
    print(f"\nSample rows:\n{result.head(5).to_string(index=False)}")


if __name__ == "__main__":
    main()
