# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Parquet I/O pipeline: read multiple files, concatenate, filter, write partitioned.

Reads log data from multiple parquet files, concatenates them, applies
filters and transformations, then writes partitioned parquet output.
"""

import os
import numpy as np
import pandas as pd
from pathlib import Path

from generate_data import generate


def load_all_parquet(input_dir):
    """Read all parquet files from a directory and concatenate."""
    generate()
    parquet_files = sorted(Path(input_dir).glob("*.parquet"))
    print(f"Found {len(parquet_files)} parquet files in {input_dir}")

    frames = []
    for f in parquet_files:
        df = pd.read_parquet(f)
        df["source_file"] = f.stem
        frames.append(df)

    combined = pd.concat(frames, ignore_index=True)
    print(f"Combined: {len(combined)} rows, {combined.columns.tolist()}")
    return combined


def filter_and_transform(df):
    """Apply filters and add computed columns."""
    # Filter out health check endpoints
    df = df[df["endpoint"] != "/api/health"].copy()
    print(f"After filtering health checks: {len(df)} rows")

    # Categorize status codes
    df["status_category"] = pd.cut(
        df["status_code"],
        bins=[0, 199, 299, 399, 499, 599],
        labels=["1xx", "2xx", "3xx", "4xx", "5xx"],
    )

    # Performance buckets
    df["is_slow"] = (df["response_time_ms"] > 500).astype(int)
    df["perf_bucket"] = pd.cut(
        df["response_time_ms"],
        bins=[0, 50, 200, 500, 1000, float("inf")],
        labels=["fast", "normal", "slow", "very_slow", "timeout"],
    )

    # Extract hour from timestamp
    df["hour"] = df["timestamp"].dt.hour
    df["day_of_week"] = df["timestamp"].dt.dayofweek

    return df


def compute_summaries(df):
    """Compute endpoint and region summaries."""
    endpoint_summary = df.groupby("endpoint").agg(
        request_count=("user_id", "count"),
        unique_users=("user_id", "nunique"),
        avg_response_ms=("response_time_ms", "mean"),
        p95_response_ms=("response_time_ms", lambda x: x.quantile(0.95)),
        error_count=("is_slow", "sum"),
        total_bytes=("bytes_sent", "sum"),
    ).reset_index()

    region_summary = df.groupby("region").agg(
        request_count=("user_id", "count"),
        avg_response_ms=("response_time_ms", "mean"),
        cache_hit_rate=("is_cached", "mean"),
    ).reset_index()

    print(f"Endpoint summary:\n{endpoint_summary.to_string(index=False)}")
    print(f"\nRegion summary:\n{region_summary.to_string(index=False)}")

    return endpoint_summary, region_summary


def write_partitioned(df, output_dir):
    """Write partitioned parquet output by region."""
    output_path = Path(output_dir)
    if output_path.exists():
        import shutil
        shutil.rmtree(output_path)
    output_path.mkdir(parents=True)

    # Convert categoricals to string for parquet compatibility
    for col in df.select_dtypes(include=["category"]).columns:
        df[col] = df[col].astype(str)

    for region, group in df.groupby("region"):
        region_dir = output_path / f"region={region}"
        region_dir.mkdir(exist_ok=True)
        out_file = region_dir / "data.parquet"
        group.to_parquet(out_file, index=False)
        print(f"Wrote {out_file} ({len(group)} rows)")


def write_summaries(endpoint_summary, region_summary, output_dir):
    """Write summary tables as parquet."""
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)
    endpoint_summary.to_parquet(output_path / "endpoint_summary.parquet", index=False)
    region_summary.to_parquet(output_path / "region_summary.parquet", index=False)
    print(f"Wrote summary parquets to {output_path}")


def main():
    df = load_all_parquet("raw_logs")
    df = filter_and_transform(df)
    endpoint_summary, region_summary = compute_summaries(df)
    write_partitioned(df, "processed_logs")
    write_summaries(endpoint_summary, region_summary, "processed_logs/summaries")

    # Verify round-trip by reading back
    read_back = pd.read_parquet("processed_logs/summaries/endpoint_summary.parquet")
    print(f"\nRound-trip verification: {len(read_back)} endpoint summary rows read back")


if __name__ == "__main__":
    main()
