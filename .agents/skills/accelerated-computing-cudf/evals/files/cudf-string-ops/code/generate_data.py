# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Generate synthetic messy text data for string operations."""

import os
import numpy as np
import pandas as pd

SEED = 42
N_ROWS = 30_000


def generate():
    if os.path.exists("raw_contacts.csv"):
        return

    rng = np.random.default_rng(SEED)

    first_names = ["Alice", "Bob", "  Charlie", "Diana ", " Eve", "FRANK",
                   "grace", " HANK ", "Ivy", "  jack"]
    last_names = ["Smith", " JONES", "Williams ", "  BROWN", "davis",
                  " Miller", "WILSON ", "moore", " Taylor", "Anderson"]
    domains = ["gmail.com", "yahoo.com", "outlook.com", "company.org", "example.net"]

    phones_raw = []
    emails_raw = []
    addresses_raw = []

    for _ in range(N_ROWS):
        # messy phone: mix of formats
        area = rng.integers(200, 999)
        mid = rng.integers(100, 999)
        last4 = rng.integers(1000, 9999)
        fmt = rng.choice(["paren", "dash", "dot", "plain", "intl"])
        if fmt == "paren":
            phones_raw.append(f"({area}) {mid}-{last4}")
        elif fmt == "dash":
            phones_raw.append(f"{area}-{mid}-{last4}")
        elif fmt == "dot":
            phones_raw.append(f"{area}.{mid}.{last4}")
        elif fmt == "plain":
            phones_raw.append(f"{area}{mid}{last4}")
        else:
            phones_raw.append(f"+1-{area}-{mid}-{last4}")

        fn = rng.choice(first_names)
        ln = rng.choice(last_names)
        dom = rng.choice(domains)
        emails_raw.append(f"  {fn.strip().lower()}.{ln.strip().lower()}@{dom}  ")

        num = rng.integers(1, 9999)
        street = rng.choice(["Main St", "Oak Ave", "1st Blvd", "Elm Dr", "Pine Ln"])
        state = rng.choice(["CA", "NY", "TX", "FL", "WA", "IL"])
        zipcode = rng.integers(10000, 99999)
        addresses_raw.append(f" {num} {street}, {state} {zipcode} ")

    df = pd.DataFrame({
        "first_name": rng.choice(first_names, N_ROWS),
        "last_name": rng.choice(last_names, N_ROWS),
        "email": emails_raw,
        "phone": phones_raw,
        "address": addresses_raw,
        "notes": rng.choice([
            "VIP customer - priority support",
            "CALLED 2024-01-15: billing issue",
            "Ref#12345 - pending review",
            "  no notes  ",
            "email BOUNCED on 2024-03-01",
            "Discount: 20% off next order",
            "REF#99887 follow-up required",
            "",
        ], N_ROWS),
    })

    df.to_csv("raw_contacts.csv", index=False)
    print(f"Generated {len(df)} messy contact rows -> raw_contacts.csv")


if __name__ == "__main__":
    generate()
