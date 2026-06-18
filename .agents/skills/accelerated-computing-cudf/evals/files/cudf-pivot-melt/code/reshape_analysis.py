# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Pivot, melt, stack/unstack, and cross-tabulation on retail data.

Demonstrates various DataFrame reshape operations for sales analysis.
"""

import numpy as np
import pandas as pd

from generate_data import generate


def load_data():
    generate()
    df = pd.read_csv("retail_sales.csv")
    print(f"Loaded {len(df)} retail sales rows")
    return df


def pivot_revenue_by_product_quarter(df):
    """Pivot table: average revenue by product and quarter."""
    pivot = pd.pivot_table(
        df,
        values="revenue",
        index="product",
        columns="quarter",
        aggfunc="mean",
        fill_value=0,
    )
    pivot = pivot.round(2)
    print(f"Revenue pivot (product x quarter):\n{pivot}")
    return pivot


def pivot_multi_agg(df):
    """Pivot table with multiple aggregation functions."""
    pivot = pd.pivot_table(
        df,
        values=["revenue", "units_sold"],
        index=["store"],
        columns=["year"],
        aggfunc={"revenue": ["sum", "mean"], "units_sold": "sum"},
        fill_value=0,
    )
    print(f"Multi-agg pivot shape: {pivot.shape}")
    print(f"Columns: {pivot.columns.tolist()[:8]}...")
    return pivot


def melt_pivot_back(pivot_df):
    """Melt a pivoted DataFrame back to long format."""
    # Reset index to make product a column
    flat = pivot_df.reset_index()
    melted = pd.melt(
        flat,
        id_vars=["product"],
        var_name="quarter",
        value_name="avg_revenue",
    )
    melted = melted.sort_values(["product", "quarter"])
    print(f"Melted back to long format: {len(melted)} rows")
    return melted


def stack_unstack_demo(df):
    """Demonstrate stack and unstack operations."""
    # Create a multi-index aggregation
    agg = df.groupby(["store", "product"]).agg(
        total_revenue=("revenue", "sum"),
        total_units=("units_sold", "sum"),
    )

    # Unstack product to columns
    unstacked = agg["total_revenue"].unstack(fill_value=0)
    print(f"Unstacked shape: {unstacked.shape}")

    # Stack it back
    stacked = unstacked.stack()
    stacked.name = "total_revenue"
    stacked = stacked.reset_index()
    print(f"Re-stacked: {len(stacked)} rows")

    return unstacked, stacked


def crosstab_analysis(df):
    """Cross-tabulation of channel vs product."""
    # Count cross-tab
    ct_count = pd.crosstab(
        df["channel"],
        df["product"],
        margins=True,
        margins_name="Total",
    )
    print(f"Count crosstab:\n{ct_count}")

    # Value cross-tab (average satisfaction)
    ct_sat = pd.crosstab(
        df["channel"],
        df["product"],
        values=df["customer_satisfaction"],
        aggfunc="mean",
    ).round(2)
    print(f"\nSatisfaction crosstab:\n{ct_sat}")

    # Normalized cross-tab
    ct_norm = pd.crosstab(
        df["channel"],
        df["product"],
        normalize="index",
    ).round(4)
    print(f"\nNormalized crosstab:\n{ct_norm}")

    return ct_count, ct_sat, ct_norm


def year_over_year_pivot(df):
    """Pivot to compare year-over-year performance by store."""
    yearly = df.groupby(["store", "year"]).agg(
        revenue=("revenue", "sum"),
        units=("units_sold", "sum"),
        avg_profit=("profit", "mean"),
    ).reset_index()

    # Pivot years to columns for side-by-side comparison
    yoy = yearly.pivot_table(
        index="store",
        columns="year",
        values="revenue",
        aggfunc="sum",
        fill_value=0,
    )
    yoy.columns = [f"revenue_{y}" for y in yoy.columns]
    yoy = yoy.reset_index()

    # Compute growth rates
    if "revenue_2023" in yoy.columns and "revenue_2022" in yoy.columns:
        yoy["growth_22_23"] = (
            (yoy["revenue_2023"] - yoy["revenue_2022"]) / yoy["revenue_2022"]
        ).round(4)
    if "revenue_2024" in yoy.columns and "revenue_2023" in yoy.columns:
        yoy["growth_23_24"] = (
            (yoy["revenue_2024"] - yoy["revenue_2023"]) / yoy["revenue_2023"]
        ).round(4)

    print(f"Year-over-year:\n{yoy.head().to_string(index=False)}")
    return yoy


def main():
    df = load_data()

    # Pivot operations
    revenue_pivot = pivot_revenue_by_product_quarter(df)
    multi_pivot = pivot_multi_agg(df)

    # Melt
    melted = melt_pivot_back(revenue_pivot)

    # Stack / Unstack
    unstacked, stacked = stack_unstack_demo(df)

    # Cross-tabulation
    ct_count, ct_sat, ct_norm = crosstab_analysis(df)

    # Year-over-year pivot
    yoy = year_over_year_pivot(df)

    print(f"\nAll reshape operations completed successfully.")


if __name__ == "__main__":
    main()
