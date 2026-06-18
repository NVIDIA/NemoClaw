#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Identify FP/FN cases by comparing model predictions to ground truth.

Reads the evaluation ``results.json`` (searched recursively under
results_dir) and compares each prediction's ``response`` against
its ``gt`` value. Mismatches are treated as false-positive /
false-negative cases. Because the eval output only contains a
``video_id`` (UUID), the KPI annotations file is used to resolve
the full media path.

Supports both local paths and S3 URIs (s3://) via fsspec.
"""
import argparse
import json
import os

import fsspec
import pandas as pd


def _is_remote(path):
    return "://" in path


def _open(path, mode="r"):
    """Open a file — works with both local and s3:// paths."""
    return fsspec.open(path, mode)


def _find_results_json(results_dir):
    """Find results.json under results_dir (local or S3)."""
    if _is_remote(results_dir):
        fs, _ = fsspec.core.url_to_fs(results_dir)
        # Strip protocol for glob
        root = results_dir.split("://", 1)[1]
        matches = fs.glob(f"{root}/**/results.json")
        if not matches:
            raise FileNotFoundError(
                f"No results.json found under {results_dir}"
            )
        proto = results_dir.split("://")[0]
        return f"{proto}://{matches[0]}"
    else:
        import glob
        pattern = os.path.join(results_dir, "**", "results.json")
        matches = glob.glob(pattern, recursive=True)
        if not matches:
            raise FileNotFoundError(
                f"No results.json found under {results_dir}"
            )
        return matches[0]


def analyze_kpi_gaps(
    results_dir: str,
    gaps_parquet: str,
    kpi_ann_path: str,
    kpi_media_path: str,
) -> str:
    with _open(kpi_ann_path, "r") as f:
        annotations = json.load(f)

    predictions_json = _find_results_json(results_dir)

    with _open(predictions_json, "r") as f:
        predictions_data = json.load(f)

    ann_lookup = {ann["id"]: ann["video"] for ann in annotations}

    fp_fn_cases = []
    for item in predictions_data:
        video_id = item.get("video_id", "")
        response = item.get("response", "").lower().strip()
        question = item.get("question", "")
        gt = item.get("gt", "").lower().strip()

        if response != gt:
            video_path = ann_lookup.get(video_id)
            if not video_path:
                raise FileNotFoundError(
                    f"Video {video_id} not found in {kpi_ann_path}"
                )
            if not os.path.isabs(video_path) and not _is_remote(video_path):
                video_path = os.path.join(kpi_media_path, video_path)
            fp_fn_cases.append({
                "video_id": video_path,
                "question": question,
                "ground_truth": gt,
            })

    df = pd.DataFrame(fp_fn_cases)

    if not _is_remote(gaps_parquet):
        gaps_dir = os.path.dirname(gaps_parquet)
        if gaps_dir:
            os.makedirs(gaps_dir, exist_ok=True)

    print(f"Saving {len(df)} cases to {gaps_parquet}...")
    df.to_parquet(gaps_parquet, index=False)

    print(f"\n=== Summary ===")
    print(f"Total FP/FN cases: {len(df)}")
    print(f"Results saved to {gaps_parquet}")

    return gaps_parquet


def main():
    parser = argparse.ArgumentParser(
        description="Analyze KPI gaps: identify FP/FN cases from eval results"
    )
    parser.add_argument("--results-dir", required=True)
    parser.add_argument("--gaps-parquet", required=True)
    parser.add_argument("--kpi-ann-path", required=True)
    parser.add_argument("--kpi-media-path", required=True)
    args = parser.parse_args()

    analyze_kpi_gaps(
        results_dir=args.results_dir,
        gaps_parquet=args.gaps_parquet,
        kpi_ann_path=args.kpi_ann_path,
        kpi_media_path=args.kpi_media_path,
    )


if __name__ == "__main__":
    main()
