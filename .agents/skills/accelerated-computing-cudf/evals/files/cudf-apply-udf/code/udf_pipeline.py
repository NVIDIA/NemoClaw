# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""UDF-heavy processing pipeline on insurance claims data.

Uses apply(), applymap(), and custom functions for row-wise and
element-wise transformations on a pandas DataFrame.
"""

import numpy as np
import pandas as pd

from generate_data import generate


def load_data():
    generate()
    df = pd.read_csv("claims.csv")
    print(f"Loaded {len(df)} claims")
    return df


# --- Row-wise UDFs used with apply(axis=1) ---

def calculate_risk_score(row):
    """Complex row-wise risk scoring function."""
    base_score = 50

    # Age factor
    if row["age"] < 25:
        base_score += 15
    elif row["age"] > 65:
        base_score += 10
    else:
        base_score -= 5

    # Claims history
    base_score += row["num_prior_claims"] * 8

    # Credit score factor
    if row["credit_score"] >= 750:
        base_score -= 20
    elif row["credit_score"] >= 650:
        base_score -= 10
    elif row["credit_score"] < 550:
        base_score += 15

    # Risk level multiplier
    if row["risk_level"] == "high":
        base_score *= 1.5
    elif row["risk_level"] == "medium":
        base_score *= 1.2

    # Loyalty discount
    if row["years_as_customer"] > 10:
        base_score *= 0.85
    elif row["years_as_customer"] > 5:
        base_score *= 0.92

    return round(base_score, 2)


def calculate_payout(row):
    """Calculate adjusted payout amount based on multiple conditions."""
    amount = row["claim_amount"]
    deductible = row["deductible"]

    net = max(0, amount - deductible)

    # Cap by policy type
    caps = {"auto": 50_000, "home": 200_000, "health": 100_000,
            "life": 500_000, "travel": 10_000}
    cap = caps.get(row["policy_type"], 50_000)
    net = min(net, cap)

    # Loyalty bonus: extra 5% for long-term customers
    if row["years_as_customer"] > 15:
        net *= 1.05

    # High-risk penalty: reduce by 10%
    if row["risk_level"] == "high" and row["num_prior_claims"] > 5:
        net *= 0.90

    return round(net, 2)


def classify_claim_tier(row):
    """Classify claim into processing tier based on multiple factors."""
    amount = row["claim_amount"]
    risk = row["risk_level"]
    priors = row["num_prior_claims"]

    if amount > 20_000 or (risk == "high" and priors > 3):
        return "tier_3_manual"
    elif amount > 5_000 or (risk == "medium" and priors > 2):
        return "tier_2_review"
    else:
        return "tier_1_auto"


# --- Column-wise UDFs ---

def normalize_score(series):
    """Min-max normalize a numeric series."""
    return (series - series.min()) / (series.max() - series.min())


def winsorize(series, lower=0.05, upper=0.95):
    """Clip values at the given percentiles."""
    lo = series.quantile(lower)
    hi = series.quantile(upper)
    return series.clip(lo, hi)


# --- Element-wise UDF ---

def format_currency(val):
    """Format a numeric value as currency string."""
    if pd.isna(val):
        return "$0.00"
    return f"${val:,.2f}"


def credit_bucket(val):
    """Bucket a credit score into a category."""
    if val >= 750:
        return "excellent"
    elif val >= 700:
        return "good"
    elif val >= 650:
        return "fair"
    elif val >= 550:
        return "poor"
    else:
        return "very_poor"


def process_claims(df):
    """Apply all UDFs to the claims DataFrame."""

    # Row-wise apply (the expensive operations)
    print("Computing risk scores (row-wise apply)...")
    df["risk_score"] = df.apply(calculate_risk_score, axis=1)

    print("Computing payouts (row-wise apply)...")
    df["payout"] = df.apply(calculate_payout, axis=1)

    print("Classifying claims (row-wise apply)...")
    df["claim_tier"] = df.apply(classify_claim_tier, axis=1)

    # Column-wise UDFs
    print("Normalizing and winsorizing...")
    df["risk_score_norm"] = normalize_score(df["risk_score"])
    df["claim_amount_winsorized"] = winsorize(df["claim_amount"])
    df["premium_norm"] = normalize_score(df["premium_monthly"])

    # Element-wise apply (applymap-style via apply on columns)
    print("Formatting and bucketing...")
    df["credit_bucket"] = df["credit_score"].apply(credit_bucket)
    df["payout_formatted"] = df["payout"].apply(format_currency)

    # Element-wise on multiple numeric columns
    numeric_cols = ["claim_amount", "deductible", "premium_monthly", "property_value"]
    formatted = df[numeric_cols].applymap(format_currency)
    for col in numeric_cols:
        df[f"{col}_fmt"] = formatted[col]

    return df


def summarize(df):
    """Summarize processed claims."""
    print(f"\nProcessed {len(df)} claims")
    print(f"Risk score stats: mean={df['risk_score'].mean():.1f}, "
          f"std={df['risk_score'].std():.1f}")
    print(f"Total payouts: ${df['payout'].sum():,.2f}")

    tier_counts = df["claim_tier"].value_counts()
    print(f"\nClaim tiers:\n{tier_counts}")

    credit_dist = df["credit_bucket"].value_counts()
    print(f"\nCredit distribution:\n{credit_dist}")

    by_type = df.groupby("policy_type").agg(
        avg_risk=("risk_score", "mean"),
        total_payout=("payout", "sum"),
        claim_count=("claim_id", "count"),
    ).round(2)
    print(f"\nBy policy type:\n{by_type}")


def main():
    df = load_data()
    df = process_claims(df)
    summarize(df)


if __name__ == "__main__":
    main()
