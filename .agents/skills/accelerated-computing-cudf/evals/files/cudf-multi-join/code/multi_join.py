# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Three-table join pipeline with aggregation.

Joins orders with customers (left join) and products (inner join),
then computes per-customer and per-category summaries.
"""

import numpy as np
import pandas as pd

from generate_data import generate


def load_tables():
    generate()
    orders = pd.read_csv("orders.csv")
    customers = pd.read_csv("customers.csv")
    products = pd.read_csv("products.csv")
    print(f"Loaded orders={len(orders)}, customers={len(customers)}, products={len(products)}")
    return orders, customers, products


def join_tables(orders, customers, products):
    """Left-join orders->customers, then inner-join with products."""
    # Left join: keep all orders even if customer_id is missing
    merged = orders.merge(customers, on="customer_id", how="left")
    print(f"After left join with customers: {len(merged)} rows, "
          f"{merged['customer_name'].isna().sum()} unmatched customers")

    # Inner join: drop orders whose product_id doesn't match
    merged = merged.merge(products, on="product_id", how="inner")
    print(f"After inner join with products: {len(merged)} rows")

    # Computed columns
    merged["line_total"] = merged["quantity"] * merged["base_price"]
    merged["total_weight"] = merged["quantity"] * merged["weight_kg"]
    merged["over_credit"] = (merged["order_total"] > merged["credit_limit"]).fillna(False)

    return merged


def customer_summary(merged):
    """Per-customer aggregation."""
    cust = (
        merged.groupby("customer_id")
        .agg(
            num_orders=("order_id", "count"),
            total_spent=("order_total", "sum"),
            avg_order=("order_total", "mean"),
            unique_products=("product_id", "nunique"),
            total_weight=("total_weight", "sum"),
            times_over_credit=("over_credit", "sum"),
            tier=("tier", "first"),
            country=("country", "first"),
        )
        .reset_index()
        .sort_values("total_spent", ascending=False)
    )
    print(f"Customer summary: {len(cust)} customers")
    return cust


def category_summary(merged):
    """Per-category aggregation."""
    cat = (
        merged.groupby("category")
        .agg(
            num_orders=("order_id", "count"),
            total_revenue=("line_total", "sum"),
            avg_quantity=("quantity", "mean"),
            unique_customers=("customer_id", "nunique"),
            avg_weight=("total_weight", "mean"),
        )
        .reset_index()
        .sort_values("total_revenue", ascending=False)
    )
    print(f"Category summary: {len(cat)} categories")
    return cat


def tier_channel_summary(merged):
    """Cross-tabulation of tier x channel."""
    cross = (
        merged.groupby(["tier", "channel"])
        .agg(
            order_count=("order_id", "count"),
            revenue=("line_total", "sum"),
        )
        .reset_index()
    )
    # Pivot to wide format
    pivot = cross.pivot_table(
        index="tier", columns="channel", values="revenue",
        aggfunc="sum", fill_value=0,
    )
    print(f"Tier-channel pivot:\n{pivot}")
    return cross


def main():
    orders, customers, products = load_tables()
    merged = join_tables(orders, customers, products)

    cust_summary = customer_summary(merged)
    cat_summary = category_summary(merged)
    tier_ch = tier_channel_summary(merged)

    print(f"\nTop 5 customers by spend:\n{cust_summary.head(5).to_string(index=False)}")
    print(f"\nCategory breakdown:\n{cat_summary.to_string(index=False)}")


if __name__ == "__main__":
    main()
