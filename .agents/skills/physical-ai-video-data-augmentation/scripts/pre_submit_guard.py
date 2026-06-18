#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Validate VDA workflow YAML before submit.

Mode-aware checks:
- If auto-labeling tasks are present, require PL cookbook artifacts in setup.files.
- If augmentation tasks are present, require augmentation prompt artifacts in setup.files.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path
from typing import Any

import yaml


PL_REQUIRED_SUFFIXES = [
    "auto_labeling/auto_labeling_config.yaml",
    "auto_labeling/prompts/event_analysis.md",
    "auto_labeling/question_bank.json",
]

AUG_REQUIRED_SUFFIXES = [
    "augmentation/augmentation.yaml",
    "augmentation/prompts/prompt_polishing_system_prompt.md",
    "augmentation/prompts/template_generation_system_prompt.md",
]


def _iter_tasks(doc: dict[str, Any]) -> list[dict[str, Any]]:
    workflow = doc.get("workflow") or {}
    tasks: list[dict[str, Any]] = list(workflow.get("tasks") or [])
    for g in workflow.get("groups") or []:
        tasks.extend(g.get("tasks") or [])
    return tasks


def _is_pl_task(task: dict[str, Any]) -> bool:
    name = str(task.get("name", "")).lower()
    image = str(task.get("image", "")).lower()
    return "auto-labeling" in image or name.startswith("pl_")


def _is_aug_task(task: dict[str, Any]) -> bool:
    name = str(task.get("name", "")).lower()
    image = str(task.get("image", "")).lower()
    return "augmentation" in image or name.startswith("cosmos_")


def _find_setup_task(tasks: list[dict[str, Any]]) -> dict[str, Any] | None:
    for task in tasks:
        if str(task.get("name", "")).lower() == "setup":
            return task
    return None


def _collect_localpaths(setup_task: dict[str, Any]) -> list[str]:
    out: list[str] = []
    for f in (setup_task.get("files") or []):
        lp = f.get("localpath")
        if isinstance(lp, str):
            out.append(lp.replace("\\", "/"))
    return out


def _collect_setup_input_urls(setup_task: dict[str, Any]) -> list[str]:
    urls: list[str] = []
    for item in (setup_task.get("inputs") or []):
        if not isinstance(item, dict):
            continue
        url = item.get("url")
        if isinstance(url, str):
            urls.append(url)
    return urls


def _collect_cache_input_urls(tasks: list[dict[str, Any]]) -> list[str]:
    urls: set[str] = set()
    for task in tasks:
        for item in (task.get("inputs") or []):
            if not isinstance(item, dict):
                continue
            url = item.get("url")
            if not isinstance(url, str):
                continue
            if "/models/cosmos_transfer" in url or "/models/auto_labeling" in url:
                urls.add(url)
    return sorted(urls)


def _check_object_url_non_empty(url: str) -> str | None:
    if "PLACEHOLDER_" in url:
        return f"contains unresolved placeholders: {url}"

    try:
        result = subprocess.run(
            ["osmo", "data", "list", "--no-pager", url],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
    except FileNotFoundError:
        return "osmo CLI not found in PATH"
    except subprocess.TimeoutExpired:
        return "timed out while listing dataset objects"

    # Older osmo CLI builds may not support --no-pager. Retry without it.
    combined = f"{result.stdout}\n{result.stderr}"
    if result.returncode != 0 and ("unknown flag" in combined or "unknown option" in combined):
        try:
            result = subprocess.run(
                ["osmo", "data", "list", url],
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )
        except subprocess.TimeoutExpired:
            return "timed out while listing dataset objects"

    output = f"{result.stdout}\n{result.stderr}"
    if result.returncode != 0:
        details = (result.stderr or result.stdout or "unknown error").strip()
        return f"osmo data list failed (exit {result.returncode}): {details}"
    if "No entries found" in output or "Total 0 objects" in output:
        return "resolves to zero objects"
    return None


def _missing_suffixes(localpaths: list[str], required: list[str]) -> list[str]:
    missing: list[str] = []
    for suffix in required:
        if not any(lp.endswith(suffix) for lp in localpaths):
            missing.append(suffix)
    return missing


def _invalid_video_name_values(tasks: list[dict[str, Any]]) -> list[tuple[str, str]]:
    bad: list[tuple[str, str]] = []
    for task in tasks:
        env = task.get("environment") or {}
        if not isinstance(env, dict):
            continue
        video_name = env.get("VIDEO_NAME")
        if isinstance(video_name, str) and ("/" in video_name or "\\" in video_name):
            task_name = str(task.get("name", "<unnamed-task>"))
            bad.append((task_name, video_name))
    return bad


def _emit_cache_default_action(reason: str) -> None:
    print("ERROR: pre-submit guard failed. " + reason)
    print(
        "DEFAULT_ACTION: Run setup_model_cache.yaml, then rerun pre-submit guard "
        "before submitting VDA workflow."
    )
    print(
        "Hint: osmo workflow submit assets/configs/osmo/setup_model_cache.yaml "
        "--set-string storage_url=<backend-prefix> path=data"
    )
    print(
        "Ask the user only if storage backend/prefix is ambiguous or cache setup fails."
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate VDA workflow setup.files coverage.")
    parser.add_argument("--workflow", required=True, help="Path to rendered workflow YAML")
    args = parser.parse_args()

    workflow_path = Path(args.workflow)
    if not workflow_path.exists():
        print(f"ERROR: workflow file not found: {workflow_path}")
        return 2

    with workflow_path.open("r", encoding="utf-8") as f:
        doc = yaml.safe_load(f)

    if not isinstance(doc, dict):
        print("ERROR: invalid workflow YAML: expected mapping at root")
        return 2

    tasks = _iter_tasks(doc)
    setup_task = _find_setup_task(tasks)
    if setup_task is None:
        print("ERROR: setup task not found (expected task named 'setup').")
        return 2

    has_pl = any(_is_pl_task(t) for t in tasks)
    has_aug = any(_is_aug_task(t) for t in tasks)
    localpaths = _collect_localpaths(setup_task)

    missing: list[str] = []
    if has_pl:
        missing.extend(_missing_suffixes(localpaths, PL_REQUIRED_SUFFIXES))
    if has_aug:
        missing.extend(_missing_suffixes(localpaths, AUG_REQUIRED_SUFFIXES))

    if missing:
        print("ERROR: pre-submit guard failed. Missing setup.files entries:")
        for item in missing:
            print(f"  - {item}")
        return 1

    invalid_video_names = _invalid_video_name_values(tasks)
    if invalid_video_names:
        print("ERROR: pre-submit guard failed. VIDEO_NAME must be a basename (no path separators).")
        print("Hint: flatten uploaded demo assets or move prefix into dataset URL, not VIDEO_NAME.")
        for task_name, video_name in invalid_video_names:
            print(f"  - task {task_name}: VIDEO_NAME={video_name!r}")
        return 1

    dataset_urls = _collect_setup_input_urls(setup_task)
    if not dataset_urls:
        print("ERROR: pre-submit guard failed. setup task has no dataset input URL.")
        return 1

    dataset_errors: list[tuple[str, str]] = []
    for dataset_url in dataset_urls:
        err = _check_object_url_non_empty(dataset_url)
        if err:
            dataset_errors.append((dataset_url, err))
    if dataset_errors:
        print("ERROR: pre-submit guard failed. Dataset input URL validation failed:")
        for dataset_url, reason in dataset_errors:
            print(f"  - {dataset_url}: {reason}")
        print("Hint: upload data first, then rerun guard before submit.")
        return 1

    cache_urls = _collect_cache_input_urls(tasks)
    has_cosmos_cache = any("/models/cosmos_transfer" in url for url in cache_urls)
    has_al_cache = any("/models/auto_labeling" in url for url in cache_urls)
    if has_aug and not has_cosmos_cache:
        _emit_cache_blocker(
            "Augmentation tasks are present but no cosmos cache URL is wired in task inputs."
        )
        return 1
    if has_pl and not has_al_cache:
        _emit_cache_blocker(
            "Auto-labeling tasks are present but no auto_labeling cache URL is wired in task inputs."
        )
        return 1

    cache_errors: list[tuple[str, str]] = []
    for cache_url in cache_urls:
        err = _check_object_url_non_empty(cache_url)
        if err:
            cache_errors.append((cache_url, err))
    if cache_errors:
        _emit_cache_default_action("Model cache URL validation failed.")
        for cache_url, reason in cache_errors:
            print(f"  - {cache_url}: {reason}")
        return 1

    checks = []
    if has_pl:
        checks.append("auto-labeling")
    if has_aug:
        checks.append("augmentation")
    checks_label = ", ".join(checks) if checks else "none"
    print(f"OK: pre-submit guard passed (mode-aware checks: {checks_label}).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

