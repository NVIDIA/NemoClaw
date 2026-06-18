# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Inspect a locale's managed persona dataset and print its available fields.

Fields are split into two groups based on the with_synthetic_personas setting:
  - PII fields: always included in person sampling
  - SYNTHETIC PERSONA fields: only included when with_synthetic_personas=True

Usage: python get_person_object_schema.py <locale>
Example: python get_person_object_schema.py en_US
"""

from __future__ import annotations

import sys

import pyarrow.parquet as pq

from data_designer.config.utils.constants import MANAGED_ASSETS_PATH
from data_designer.engine.sampling_gen.entities.dataset_based_person_fields import PERSONA_FIELDS, PII_FIELDS


def main(locale: str) -> None:
    path = MANAGED_ASSETS_PATH / f"datasets/{locale}.parquet"
    if not path.exists():
        print(f"Error: locale '{locale}' does not exist (no dataset at {path})", file=sys.stderr)
        sys.exit(1)

    schema = {field.name: str(field.type) for field in pq.read_schema(path)}

    pii = {k: v for k, v in schema.items() if k in PII_FIELDS and v != "null"}
    persona = {k: v for k, v in schema.items() if k in PERSONA_FIELDS and v != "null"}

    print(f"=== {locale} PII fields (always included) ({len(pii)}) ===")
    for name, dtype in pii.items():
        print(f"  {name}: {dtype}")

    print(f"\n=== {locale} SYNTHETIC PERSONA fields (with_synthetic_personas=True) ({len(persona)}) ===")
    for name, dtype in persona.items():
        print(f"  {name}: {dtype}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(f"Usage: {sys.argv[0]} <locale>", file=sys.stderr)
        sys.exit(1)
    main(sys.argv[1])
