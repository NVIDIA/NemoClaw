#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Discover and lightly validate Dynamo recipes."""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable

FRAMEWORKS = {"vllm", "sglang", "trtllm", "tokenspeed"}
PLACEHOLDER_RE = re.compile(r"(<[^>]+>|your-|change-me|changeme|my-tag|TODO)", re.I)
# Recipes declare GPUs either as the DynamoGraphDeployment shorthand
# (`limits.gpu: "4"`) or the standard Kubernetes `nvidia.com/gpu: 4`; match both.
GPU_RE = re.compile(r"(?:nvidia\.com/gpu|(?<![\w./-])gpu):\s*[\"']?(\d+)")


@dataclass
class Recipe:
    model: str
    framework: str
    mode: str
    path: str
    deploy_yaml: str
    perf_yaml: str | None
    model_cache_dir: str | None
    gpu_count_hint: int | None


def repo_root(start: Path) -> Path:
    for path in [start, *start.parents]:
        if (path / "recipes").is_dir() and (path / ".git").exists():
            return path
    raise SystemExit("Could not find Dynamo repo root from current directory")


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return path.read_text(errors="replace")


def gpu_values_in_yaml_blocks(text: str, block_name: str) -> list[int]:
    values: list[int] = []
    in_block = False
    block_indent = 0
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(line) - len(line.lstrip())
        if stripped == f"{block_name}:":
            in_block = True
            block_indent = indent
            continue
        if in_block and indent <= block_indent:
            in_block = False
        if in_block:
            match = GPU_RE.search(line)
            if match:
                values.append(int(match.group(1)))
    return values


def gpu_count_hint(text: str) -> int | None:
    limits = gpu_values_in_yaml_blocks(text, "limits")
    if limits:
        return sum(limits)
    requests = gpu_values_in_yaml_blocks(text, "requests")
    if requests:
        return sum(requests)
    values = [int(match) for match in GPU_RE.findall(text)]
    return max(values) if values else None


def discover(root: Path) -> list[Recipe]:
    recipes_dir = root / "recipes"
    recipes: list[Recipe] = []
    for deploy in sorted(recipes_dir.rglob("deploy.yaml")):
        rel = deploy.relative_to(recipes_dir)
        parts = rel.parts
        framework_index = next(
            (i for i, part in enumerate(parts) if part in FRAMEWORKS), None
        )
        if framework_index is None:
            model = parts[0]
            framework = "unknown"
            mode_parts = parts[1:-1]
        else:
            model = "/".join(parts[:framework_index])
            framework = parts[framework_index]
            mode_parts = parts[framework_index + 1 : -1]
        mode = "/".join(mode_parts) if mode_parts else "unknown"
        recipe_dir = deploy.parent
        model_cache = recipes_dir / model / "model-cache"
        perf = recipe_dir / "perf.yaml"
        text = read_text(deploy)
        recipes.append(
            Recipe(
                model=model,
                framework=framework,
                mode=mode,
                path=str(recipe_dir.relative_to(root)),
                deploy_yaml=str(deploy.relative_to(root)),
                perf_yaml=str(perf.relative_to(root)) if perf.exists() else None,
                model_cache_dir=str(model_cache.relative_to(root))
                if model_cache.exists()
                else None,
                gpu_count_hint=gpu_count_hint(text),
            )
        )
    return recipes


def match_recipes(
    recipes: Iterable[Recipe],
    query: str | None,
    framework: str | None,
    mode: str | None,
) -> list[Recipe]:
    out = []
    for recipe in recipes:
        haystack = " ".join(
            [recipe.model, recipe.framework, recipe.mode, recipe.path]
        ).lower()
        if query and query.lower() not in haystack:
            continue
        if framework and recipe.framework != framework:
            continue
        if mode and mode.lower() not in recipe.mode.lower():
            continue
        out.append(recipe)
    return out


def print_table(recipes: list[Recipe]) -> None:
    headers = ["model", "framework", "mode", "gpus", "perf", "path"]
    rows = [
        [
            recipe.model,
            recipe.framework,
            recipe.mode,
            "" if recipe.gpu_count_hint is None else str(recipe.gpu_count_hint),
            "yes" if recipe.perf_yaml else "no",
            recipe.path,
        ]
        for recipe in recipes
    ]
    widths = [
        max(len(str(row[i])) for row in [headers, *rows]) if rows else len(headers[i])
        for i in range(len(headers))
    ]
    print("  ".join(headers[i].ljust(widths[i]) for i in range(len(headers))))
    print("  ".join("-" * widths[i] for i in range(len(headers))))
    for row in rows:
        print("  ".join(str(row[i]).ljust(widths[i]) for i in range(len(headers))))


def line_matches(path: Path, patterns: list[re.Pattern[str]]) -> list[str]:
    hits: list[str] = []
    if not path.exists() or not path.is_file():
        return hits
    for lineno, line in enumerate(read_text(path).splitlines(), start=1):
        if any(pattern.search(line) for pattern in patterns):
            hits.append(f"{path}:{lineno}: {line.strip()}")
    return hits


def metadata_names(path: Path) -> list[str]:
    names = []
    for match in re.finditer(
        r"(?m)^metadata:\n(?:  .*\n)*?  name:\s*([A-Za-z0-9_.-]+)", read_text(path)
    ):
        names.append(match.group(1))
    return names


def model_cache_dir_for(root: Path, recipe_dir: Path) -> Path | None:
    """Locate the model-level model-cache dir that sits beside a recipe.

    Recipes live at ``recipes/<model>/<framework>/<mode>`` while the
    model-cache manifests live at the sibling ``recipes/<model>/model-cache``,
    so validating only the recipe subtree would miss them.
    """
    recipes_dir = root / "recipes"
    try:
        rel = recipe_dir.relative_to(recipes_dir)
    except ValueError:
        return None
    if not rel.parts:
        return None
    candidate = recipes_dir / rel.parts[0] / "model-cache"
    return candidate if candidate.is_dir() else None


def validate(root: Path, target: Path) -> dict[str, object]:
    target = target if target.is_absolute() else root / target
    if target.is_file():
        files = [target]
        recipe_dir = target.parent
    else:
        recipe_dir = target
        files = sorted(target.rglob("*.yaml")) + sorted(target.rglob("*.yml"))

    if not files:
        raise SystemExit(f"No YAML files found under {target}")

    # Pull in the sibling model-level model-cache manifests so storage-class
    # and model-download blockers are not silently skipped.
    if not any("model-cache" in path.parts for path in files):
        mc_dir = model_cache_dir_for(root, recipe_dir)
        if mc_dir:
            files = (
                files + sorted(mc_dir.rglob("*.yaml")) + sorted(mc_dir.rglob("*.yml"))
            )

    deploy_files = [path for path in files if path.name == "deploy.yaml"]
    perf_files = [path for path in files if path.name == "perf.yaml"]
    model_cache_files = [path for path in files if "model-cache" in path.parts]

    warnings: list[str] = []
    blockers: list[str] = []

    for path in files:
        rel = path.relative_to(root) if path.is_relative_to(root) else path
        text = read_text(path)
        if PLACEHOLDER_RE.search(text):
            warnings.append(f"{rel}: contains placeholder-looking values")
        if path.name == "deploy.yaml" and "image:" not in text:
            warnings.append(f"{rel}: no image field found")
        if "HF_TOKEN" in text or "HUGGING_FACE" in text or "HUGGINGFACE" in text:
            if "hf-token-secret" not in text and "secretKeyRef" not in text:
                warnings.append(
                    f"{rel}: references Hugging Face env vars without an obvious secret"
                )
        if "storageClassName" in text and PLACEHOLDER_RE.search(text):
            blockers.append(f"{rel}: storageClassName appears to be a placeholder")

    if not deploy_files:
        blockers.append("No deploy.yaml found for this target")
    if not model_cache_files and (
        recipe_dir.parts and "model-cache" not in recipe_dir.parts
    ):
        warnings.append(
            "No model-cache YAML found under target; check the model-level model-cache directory"
        )

    deployment_names = []
    for deploy in deploy_files:
        deployment_names.extend(metadata_names(deploy))

    def rel_hits(pattern: re.Pattern[str]) -> list[str]:
        return [
            hit.replace(str(root) + "/", "")
            for path in files
            for hit in line_matches(path, [pattern])
        ]

    return {
        "target": str(
            target.relative_to(root) if target.is_relative_to(root) else target
        ),
        "deploy_files": [str(path.relative_to(root)) for path in deploy_files],
        "perf_files": [str(path.relative_to(root)) for path in perf_files],
        "model_cache_files": [
            str(path.relative_to(root)) for path in model_cache_files
        ],
        "deployment_names": deployment_names,
        "gpu_count_hint": sum(
            value
            for value in (gpu_count_hint(read_text(path)) for path in deploy_files)
            if value
        )
        or None,
        "interesting_lines": {
            "storageClassName": rel_hits(re.compile(r"storageClassName")),
            "images": rel_hits(re.compile(r"^\s*image:\s*")),
            "hf_secret": rel_hits(re.compile(r"hf-token-secret|HF_TOKEN|HUGGING")),
            "router": rel_hits(re.compile(r"DYN_ROUTER|router-mode|router_mode")),
        },
        "warnings": warnings,
        "blockers": blockers,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    list_parser = sub.add_parser("list", help="List recipe deployment candidates")
    list_parser.add_argument("--query")
    list_parser.add_argument("--framework")
    list_parser.add_argument("--mode")
    list_parser.add_argument("--format", choices=["json", "table"], default="json")

    validate_parser = sub.add_parser("validate", help="Validate a recipe path")
    validate_parser.add_argument("target", help="Recipe directory or YAML file")

    args = parser.parse_args()
    root = repo_root(Path.cwd().resolve())

    if args.command == "list":
        recipes = match_recipes(discover(root), args.query, args.framework, args.mode)
        if args.format == "table":
            print_table(recipes)
        else:
            print(json.dumps([asdict(recipe) for recipe in recipes], indent=2))
        return 0

    if args.command == "validate":
        print(json.dumps(validate(root, Path(args.target)), indent=2))
        return 0

    return 1


if __name__ == "__main__":
    sys.exit(main())
