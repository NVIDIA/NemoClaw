# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Pandas nullable-value cleanup pipeline."""

from __future__ import annotations

import numpy as np
import pandas as pd


def build_frame() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "account": pd.Series([1, 2, None, 4, 5, None], dtype="Int64"),
            "region": pd.Series(["west", None, "east", "west", None, "east"], dtype="string"),
            "score": [0.8, np.nan, 0.3, 0.9, np.nan, 0.2],
            "tier": pd.Series(["gold", "silver", None, "gold", "bronze", None], dtype="string"),
        }
    )


def clean(frame: pd.DataFrame) -> pd.DataFrame:
    result = frame.copy()
    result["region"] = result["region"].fillna("unknown")
    result["tier"] = result["tier"].fillna("unassigned")
    result["score"] = result["score"].where(result["score"].notna(), result["score"].median())
    result["high_score"] = result["score"] >= 0.75
    grouped = (
        result.groupby("region", dropna=False)
        .agg(
            accounts=("account", "count"),
            avg_score=("score", "mean"),
            high_count=("high_score", "sum"),
        )
        .reset_index()
        .sort_values("region")
    )
    return grouped


def main() -> None:
    print(clean(build_frame()).to_string(index=False))


if __name__ == "__main__":
    main()
