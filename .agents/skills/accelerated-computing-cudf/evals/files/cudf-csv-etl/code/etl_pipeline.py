# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""CSV ETL pipeline: read, filter, compute, groupby, write parquet.

Reads sales.csv, filters to completed orders, adds computed columns
(revenue, discounted_revenue, age_group), runs a groupby aggregation
by region and product, and writes the summary to parquet.
"""

import numpy as np
import pandas as pd

from generate_data import generate


def load_data():
    generate()
    df = pd.read_csv("sales.csv")
    print(f"Loaded {len(df)} rows from sales.csv")
    return df


def filter_completed(df):
    """Keep only completed orders with quantity >= 2."""
    mask = (df["status"] == "completed") & (df["quantity"] >= 2)
    filtered = df[mask].copy()
    print(f"Filtered to {len(filtered)} completed orders")
    return filtered


def add_computed_columns(df):
    """Add revenue, discounted revenue, and age group columns."""
    df["revenue"] = df["quantity"] * df["unit_price"]
    df["discounted_revenue"] = df["revenue"] * (1 - df["discount_pct"])

    bins = [0, 25, 35, 50, 65, 100]
    labels = ["18-25", "26-35", "36-50", "51-65", "65+"]
    df["age_group"] = pd.cut(df["customer_age"], bins=bins, labels=labels)

    df["high_value"] = (df["discounted_revenue"] > 500).astype(int)
    print(f"Added computed columns; {df['high_value'].sum()} high-value orders")
    return df


def aggregate_by_region_product(df):
    """Groupby region + product, compute summary statistics."""
    summary = (
        df.groupby(["region", "product"])
        .agg(
            total_revenue=("revenue", "sum"),
            total_discounted=("discounted_revenue", "sum"),
            order_count=("order_id", "count"),
            avg_quantity=("quantity", "mean"),
            avg_unit_price=("unit_price", "mean"),
            high_value_count=("high_value", "sum"),
        )
        .reset_index()
    )
    summary["avg_discount_impact"] = (
        1 - summary["total_discounted"] / summary["total_revenue"]
    )
    summary = summary.sort_values("total_revenue", ascending=False)
    print(f"Aggregated into {len(summary)} region-product groups")
    return summary


def write_output(summary):
    """Write the summary to a parquet file."""
    summary.to_parquet("sales_summary.parquet", index=False)
    print("Wrote sales_summary.parquet")


def main():
    df = load_data()
    df = filter_completed(df)
    df = add_computed_columns(df)
    summary = aggregate_by_region_product(df)
    write_output(summary)

    print("\nTop 5 region-product combos by revenue:")
    print(summary.head(5).to_string(index=False))


if __name__ == "__main__":
    main()
