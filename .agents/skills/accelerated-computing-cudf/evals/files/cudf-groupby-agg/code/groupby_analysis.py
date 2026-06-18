# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Complex groupby aggregation and transform pipeline.

Performs department-level, multi-key groupby, named aggregation,
and transform-based feature engineering on employee data.
"""

import numpy as np
import pandas as pd

from generate_data import generate


def load_data():
    generate()
    df = pd.read_csv("employees.csv")
    print(f"Loaded {len(df)} employees")
    return df


def department_summary(df):
    """Basic department-level aggregation with multiple functions."""
    dept = df.groupby("department").agg(
        headcount=("employee_id", "count"),
        avg_salary=("salary", "mean"),
        median_salary=("salary", "median"),
        std_salary=("salary", "std"),
        total_bonus=("bonus", "sum"),
        avg_perf=("performance_score", "mean"),
        unique_levels=("level", "nunique"),
        unique_offices=("office", "nunique"),
        avg_tenure=("years_tenure", "mean"),
        total_projects=("projects_completed", "sum"),
    ).reset_index()
    dept = dept.sort_values("avg_salary", ascending=False)
    print(f"Department summary: {len(dept)} departments")
    return dept


def multi_key_aggregation(df):
    """Groupby on department + level with named aggregation."""
    result = df.groupby(["department", "level"]).agg(
        count=("employee_id", "count"),
        salary_mean=("salary", "mean"),
        salary_min=("salary", "min"),
        salary_max=("salary", "max"),
        salary_sum=("salary", "sum"),
        bonus_mean=("bonus", "mean"),
        perf_mean=("performance_score", "mean"),
        perf_std=("performance_score", "std"),
        tenure_mean=("years_tenure", "mean"),
        projects_sum=("projects_completed", "sum"),
    ).reset_index()
    result["salary_range"] = result["salary_max"] - result["salary_min"]
    print(f"Multi-key aggregation: {len(result)} groups")
    return result


def office_department_crosstab(df):
    """Three-key groupby: department + office + level."""
    cross = df.groupby(["department", "office", "level"]).agg(
        headcount=("employee_id", "count"),
        avg_salary=("salary", "mean"),
        total_training=("training_hours", "sum"),
    ).reset_index()
    print(f"Cross-tab: {len(cross)} groups")
    return cross


def add_transform_features(df):
    """Use groupby transform to add group-relative features."""
    # Department-level transforms
    df["dept_avg_salary"] = df.groupby("department")["salary"].transform("mean")
    df["dept_std_salary"] = df.groupby("department")["salary"].transform("std")
    df["salary_zscore"] = (df["salary"] - df["dept_avg_salary"]) / df["dept_std_salary"]

    # Level-level transforms
    df["level_avg_perf"] = df.groupby("level")["performance_score"].transform("mean")
    df["perf_vs_level"] = df["performance_score"] - df["level_avg_perf"]

    # Department rank by salary
    df["dept_salary_rank"] = df.groupby("department")["salary"].rank(
        method="dense", ascending=False
    )

    # Department + level cumulative count
    df["dept_level_count"] = df.groupby(["department", "level"]).cumcount() + 1

    # Percent of department total
    df["dept_salary_total"] = df.groupby("department")["salary"].transform("sum")
    df["salary_pct_of_dept"] = df["salary"] / df["dept_salary_total"]

    outlier_count = (df["salary_zscore"].abs() > 2).sum()
    print(f"Transform features added; {outlier_count} salary outliers (|z| > 2)")
    return df


def top_performers_per_dept(df):
    """Get top 5 performers per department using groupby + nlargest."""
    top = (
        df.groupby("department")
        .apply(lambda g: g.nlargest(5, "performance_score"))
        .reset_index(drop=True)
    )
    print(f"Top performers: {len(top)} rows")
    return top


def main():
    df = load_data()

    dept_summary = department_summary(df)
    multi_key = multi_key_aggregation(df)
    cross = office_department_crosstab(df)
    df_with_transforms = add_transform_features(df)
    top_perf = top_performers_per_dept(df)

    print(f"\nDepartment summary:\n{dept_summary.to_string(index=False)}")
    print(f"\nSample transformed rows:\n"
          f"{df_with_transforms[['department', 'level', 'salary', 'salary_zscore', 'perf_vs_level', 'dept_salary_rank']].head(10).to_string(index=False)}")


if __name__ == "__main__":
    main()
