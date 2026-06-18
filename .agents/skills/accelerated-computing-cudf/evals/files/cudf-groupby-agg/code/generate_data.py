# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Generate synthetic employee performance data."""

import os
import numpy as np
import pandas as pd

SEED = 42
N_EMPLOYEES = 50_000


def generate():
    if os.path.exists("employees.csv"):
        return

    rng = np.random.default_rng(SEED)

    departments = ["Engineering", "Sales", "Marketing", "Finance", "HR", "Operations"]
    levels = ["Junior", "Mid", "Senior", "Lead", "Principal"]
    offices = ["NYC", "SF", "London", "Berlin", "Tokyo", "Sydney"]

    df = pd.DataFrame({
        "employee_id": range(N_EMPLOYEES),
        "department": rng.choice(departments, N_EMPLOYEES),
        "level": rng.choice(levels, N_EMPLOYEES, p=[0.3, 0.3, 0.2, 0.12, 0.08]),
        "office": rng.choice(offices, N_EMPLOYEES),
        "salary": np.round(rng.normal(85_000, 25_000, N_EMPLOYEES).clip(30_000, 300_000), 2),
        "bonus": np.round(rng.exponential(5_000, N_EMPLOYEES), 2),
        "performance_score": np.round(rng.normal(3.5, 0.8, N_EMPLOYEES).clip(1.0, 5.0), 2),
        "years_tenure": rng.integers(0, 25, N_EMPLOYEES),
        "projects_completed": rng.integers(0, 50, N_EMPLOYEES),
        "training_hours": np.round(rng.exponential(20, N_EMPLOYEES), 1),
    })

    df.to_csv("employees.csv", index=False)
    print(f"Generated {len(df)} employee records -> employees.csv")


if __name__ == "__main__":
    generate()
