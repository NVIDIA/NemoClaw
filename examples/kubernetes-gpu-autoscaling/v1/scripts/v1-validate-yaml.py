#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Validate v1 desired-state YAML against schemas/nemoclaw-v1alpha1.schema.json."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import yaml
from jsonschema import Draft202012Validator
from jsonschema.exceptions import SchemaError


def load_schema(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def load_document(path: Path) -> object:
    if str(path) == "-":
        return yaml.safe_load(sys.stdin.read())
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--schema",
        required=True,
        type=Path,
        help="Path to nemoclaw-v1alpha1.schema.json",
    )
    parser.add_argument("yaml_files", nargs="+", type=Path)
    args = parser.parse_args()

    try:
        schema = load_schema(args.schema)
        validator = Draft202012Validator(schema)
        validator.check_schema(schema)
    except (OSError, json.JSONDecodeError, SchemaError) as exc:
        print(f"schema error: {exc}", file=sys.stderr)
        return 2

    failed = 0
    for yaml_path in args.yaml_files:
        try:
            document = load_document(yaml_path)
            errors = sorted(validator.iter_errors(document), key=lambda e: list(e.absolute_path))
        except (OSError, yaml.YAMLError) as exc:
            print(f"FAIL {yaml_path}: {exc}")
            failed += 1
            continue
        if errors:
            failed += 1
            first = errors[0]
            loc = ".".join(str(part) for part in first.absolute_path) or "<root>"
            print(f"FAIL {yaml_path}: {loc}: {first.message}")
            continue
        print(f"OK   {yaml_path}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
