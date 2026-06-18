# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Generate multiple parquet files simulating partitioned log data."""

import os
import numpy as np
import pandas as pd
from pathlib import Path

SEED = 42
N_PER_FILE = 10_000
N_FILES = 6


def generate():
    outdir = Path("raw_logs")
    if outdir.exists() and len(list(outdir.glob("*.parquet"))) == N_FILES:
        return

    outdir.mkdir(exist_ok=True)
    rng = np.random.default_rng(SEED)

    endpoints = ["/api/users", "/api/orders", "/api/products",
                 "/api/health", "/api/search", "/api/auth"]
    methods = ["GET", "POST", "PUT", "DELETE"]
    status_codes = [200, 201, 204, 301, 400, 401, 403, 404, 500, 502, 503]
    status_weights = [0.50, 0.10, 0.05, 0.02, 0.08, 0.05, 0.03, 0.07, 0.04, 0.03, 0.03]
    regions = ["us-east-1", "us-west-2", "eu-west-1", "ap-southeast-1"]

    for i in range(N_FILES):
        base_date = pd.Timestamp("2024-01-01") + pd.Timedelta(days=i * 5)
        timestamps = base_date + pd.to_timedelta(
            rng.integers(0, 5 * 86400, N_PER_FILE), unit="s"
        )

        df = pd.DataFrame({
            "timestamp": timestamps,
            "endpoint": rng.choice(endpoints, N_PER_FILE),
            "method": rng.choice(methods, N_PER_FILE, p=[0.6, 0.2, 0.1, 0.1]),
            "status_code": rng.choice(status_codes, N_PER_FILE, p=status_weights),
            "response_time_ms": np.round(rng.exponential(150, N_PER_FILE), 2),
            "bytes_sent": rng.integers(100, 50_000, N_PER_FILE),
            "user_id": rng.integers(1, 5_000, N_PER_FILE),
            "region": rng.choice(regions, N_PER_FILE),
            "is_cached": rng.choice([True, False], N_PER_FILE, p=[0.3, 0.7]),
        })

        fname = outdir / f"logs_batch_{i:03d}.parquet"
        df.to_parquet(fname, index=False)
        print(f"Wrote {fname} ({len(df)} rows)")

    print(f"Generated {N_FILES} parquet files in {outdir}/")


if __name__ == "__main__":
    generate()
