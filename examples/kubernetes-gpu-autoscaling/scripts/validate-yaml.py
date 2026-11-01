#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Validate v1 GPU-autoscaling YAML against the schema and in-cluster inference rules."""

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


def check_in_cluster_inference(document: object, path: Path) -> str | None:
    """Require GPU chart Service DNS /v1."""
    blob = json.dumps(document)
    if "compatible-endpoint" in blob or "NEMOCLAW_INFERENCE_PROVIDER_ID" in blob:
        return f"{path}: inference must use spec.inferenceProviders, not compatible-endpoint"
    if not isinstance(document, dict):
        return f"{path}: document is not a mapping"
    spec = document.get("spec")
    if not isinstance(spec, dict):
        return f"{path}: missing spec"
    providers = spec.get("inferenceProviders")
    if not isinstance(providers, dict) or not providers:
        return f"{path}: missing spec.inferenceProviders"
    for name, provider in providers.items():
        if not isinstance(provider, dict):
            return f"{path}: inferenceProviders.{name} is not a mapping"
        endpoint = str(provider.get("endpoint") or "")
        api = provider.get("api")
        if "inference.local" in endpoint:
            return f"{path}: inferenceProviders.{name}.endpoint must not use inference.local"
        if api != "openai-completions":
            return f"{path}: inferenceProviders.{name}.api must be openai-completions"
        if ".svc.cluster.local:" not in endpoint or not endpoint.rstrip("/").endswith("/v1"):
            return (
                f"{path}: inferenceProviders.{name}.endpoint must be cluster Service DNS /v1"
            )
    return None


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
        inference_error = check_in_cluster_inference(document, yaml_path)
        if inference_error:
            failed += 1
            print(f"FAIL {inference_error}")
            continue
        print(f"OK   {yaml_path}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
