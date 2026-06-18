# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Text cleaning pipeline using pandas string operations.

Reads messy contact data and applies a series of string transformations:
lowercase, strip whitespace, regex extraction, contains checks, and replacements.
"""

import pandas as pd

from generate_data import generate


def load_data():
    generate()
    df = pd.read_csv("raw_contacts.csv")
    df["notes"] = df["notes"].fillna("")
    print(f"Loaded {len(df)} raw contacts")
    return df


def clean_names(df):
    """Normalize first and last names."""
    df["first_name"] = df["first_name"].str.strip().str.lower().str.title()
    df["last_name"] = df["last_name"].str.strip().str.lower().str.title()
    df["full_name"] = df["first_name"] + " " + df["last_name"]
    return df


def clean_emails(df):
    """Strip and lowercase emails, extract domain."""
    df["email"] = df["email"].str.strip().str.lower()
    df["email_domain"] = df["email"].str.extract(r"@([a-z0-9\.\-]+)$", expand=False)
    df["is_company_email"] = df["email_domain"].str.contains(
        r"\.(org|net)$", regex=True
    ).astype(int)
    return df


def normalize_phones(df):
    """Extract digits from phone numbers into a standard 10-digit format."""
    digits = df["phone"].str.replace(r"[^\d]", "", regex=True)
    # Remove leading '1' for 11-digit US numbers
    digits = digits.str.replace(r"^1(\d{10})$", r"\1", regex=True)
    df["phone_clean"] = (
        "(" + digits.str[:3] + ") " + digits.str[3:6] + "-" + digits.str[6:10]
    )
    return df


def parse_addresses(df):
    """Extract state and zip from address strings."""
    df["address"] = df["address"].str.strip()
    df["state"] = df["address"].str.extract(r",\s*([A-Z]{2})\s+\d{5}", expand=False)
    df["zipcode"] = df["address"].str.extract(r"(\d{5})\s*$", expand=False)
    return df


def process_notes(df):
    """Extract reference numbers, detect flags, clean up notes."""
    df["notes"] = df["notes"].str.strip()

    # Extract reference numbers like Ref#12345 or REF#99887
    df["ref_number"] = df["notes"].str.extract(
        r"[Rr][Ee][Ff]#(\d+)", expand=False
    )

    # Flag rows
    df["is_vip"] = df["notes"].str.contains("VIP", case=False, na=False).astype(int)
    df["has_bounced"] = df["notes"].str.contains("BOUNCED", case=False, na=False).astype(int)
    df["needs_followup"] = df["notes"].str.contains(
        "follow-up|pending", case=False, regex=True, na=False
    ).astype(int)

    # Redact discount details
    df["notes_redacted"] = df["notes"].str.replace(
        r"Discount:\s*\d+%", "Discount: [REDACTED]", regex=True
    )

    return df


def summarize(df):
    """Print summary statistics about the cleaned data."""
    print(f"\nCleaned {len(df)} contacts")
    print(f"  Unique domains: {df['email_domain'].nunique()}")
    print(f"  Company emails: {df['is_company_email'].sum()}")
    print(f"  VIP customers: {df['is_vip'].sum()}")
    print(f"  Bounced emails: {df['has_bounced'].sum()}")
    print(f"  With ref numbers: {df['ref_number'].notna().sum()}")
    print(f"  States found: {df['state'].nunique()}")


def main():
    df = load_data()
    df = clean_names(df)
    df = clean_emails(df)
    df = normalize_phones(df)
    df = parse_addresses(df)
    df = process_notes(df)
    summarize(df)

    df.to_csv("cleaned_contacts.csv", index=False)
    print("\nWrote cleaned_contacts.csv")


if __name__ == "__main__":
    main()
