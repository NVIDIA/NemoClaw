# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Validate an assembled ChangeNet training CSV before launching training.

Why this exists: `augmentation/mining_pool/mining_pool.csv` is
append-only and accumulates production-line samples daily; rows can reference
images that were deleted, moved, or never staged. Launching ChangeNet training
on a CSV with broken `input_path` / `golden_path` wastes a GPU run because the
TAO container only fails per-batch and surfaces the root cause minutes in.

This script:

1. Reads the assembled training CSV, resolves every `input_path` and
   `golden_path` against a workspace root (or treats absolute paths as-is),
   and hard-stops on any missing file or schema error.
2. Enforces the PASS-preserving label rule: `label == "PASS"` must stay
   uppercase; every other label must be lowercase + stripped. Non-compliant
   rows hard-stop because TAO's ChangeNet classify dataloader does
   case-sensitive equality against the literal string "PASS" to detect
   class 0; any deviation produces silent class-collapse failures at
   training start.
3. Optionally diffs the training CSV against a validation CSV (when
   `--validation-csv` is supplied) on `(input_path, golden_path, label,
   object_name, boardname)` where present. Any validation row appearing
   in training is a hard-stop train/val leak — running this BEFORE CSV
   assembly is finalized lets the orchestrator avoid a wasted GPU run.

Exit code 2 on any validation failure; 0 on success.

CLI:

    python scripts/validate_training_csv.py \
        --csv ${RESULTS_DIR}/iter${N}/dataset/train_combined_iter${N}.csv \
        --workspace-root ~/workspace \
        [--validation-csv ~/workspace/train/base/validation_set.csv]
"""

from __future__ import annotations

import argparse
import csv
import pathlib
import sys

_REQUIRED_COLUMNS = ("input_path", "golden_path", "label", "object_name")
_PATH_COLUMNS = ("input_path", "golden_path")
_LEAK_KEY_CANDIDATES = (
    "input_path",
    "golden_path",
    "label",
    "object_name",
    "boardname",
)


def _resolve(p: str, workspace_root: pathlib.Path) -> pathlib.Path:
    path = pathlib.Path(p)
    if path.is_absolute():
        return path
    return workspace_root / path


def normalize_label(label: str) -> str:
    """Preserve 'PASS' verbatim; lowercase + strip every other label."""
    if label == "PASS":
        return label
    return label.lower().strip()


def _check_label_case(rows: list[dict]) -> list[str]:
    """Return rows whose label is not in the canonical case.

    We compare the raw value (no caller-side strip) against normalize_label's
    output so trailing whitespace counts as non-canonical. The whole point of
    the normalization rule is that the on-disk row matches what the dataloader
    sees byte-for-byte — silently stripping here would mask the bug.
    """
    bad: list[tuple[int, str]] = []
    for i, row in enumerate(rows):
        raw = row.get("label") or ""
        if not raw.strip():
            bad.append((i, "<empty label>"))
            continue
        if raw != normalize_label(raw):
            bad.append((i, raw))
    if not bad:
        return []
    sample = ", ".join(f"row {i}: {p!r}" for i, p in bad[:5])
    return [
        f"{len(bad)} row(s) have non-canonical label case "
        f"(must be 'PASS' verbatim or lowercase+stripped); first: {sample}"
    ]


def _check_leakage(
    train_rows: list[dict],
    train_cols: list[str],
    validation_csv: pathlib.Path,
) -> list[str]:
    if not validation_csv.is_file():
        return [f"--validation-csv not found: {validation_csv}"]
    with validation_csv.open(newline="") as f:
        reader = csv.DictReader(f)
        val_cols = reader.fieldnames or []
        val_rows = list(reader)

    join_keys = [k for k in _LEAK_KEY_CANDIDATES if k in train_cols and k in val_cols]
    if not join_keys:
        return [
            f"--validation-csv has no shared columns with training CSV "
            f"(tried {list(_LEAK_KEY_CANDIDATES)}); cannot leakage-check"
        ]

    def _key(row: dict) -> tuple:
        return tuple((row.get(k) or "").strip() for k in join_keys)

    val_keys = {_key(r) for r in val_rows}
    leaks: list[tuple[int, tuple]] = [
        (i, _key(r)) for i, r in enumerate(train_rows) if _key(r) in val_keys
    ]
    if not leaks:
        return []
    sample = ", ".join(f"row {i}: {k}" for i, k in leaks[:5])
    return [
        f"{len(leaks)} train/val leak(s) on keys {join_keys}; first: {sample}"
    ]


def validate(
    csv_path: pathlib.Path,
    workspace_root: pathlib.Path,
    validation_csv: pathlib.Path | None = None,
    light: str = "SolderLight",
    image_ext: str = ".jpg",
) -> list[str]:
    """Return a list of human-readable validation errors (empty == valid).

    Uses stdlib csv so the script runs on bare hosts without pandas.

    Path resolution follows TAO ChangeNet's siamese dataloader convention
    when `object_name` is present in the CSV:
        <workspace_root>/<input_path>/<object_name>_<light><image_ext>
    Falls back to flat-file resolution (<workspace_root>/<input_path>) when
    `object_name` is absent.
    """
    errors: list[str] = []

    if not csv_path.is_file():
        return [f"CSV not found: {csv_path}"]

    with csv_path.open(newline="") as f:
        reader = csv.DictReader(f)
        columns = reader.fieldnames or []
        rows = list(reader)

    missing_cols = [c for c in _REQUIRED_COLUMNS if c not in columns]
    if missing_cols:
        errors.append(
            f"missing required column(s): {missing_cols}; got {list(columns)}"
        )
        # Continue so the user sees both schema and path errors in one shot.

    if not rows:
        errors.append("CSV is empty (0 data rows)")

    siamese_mode = "object_name" in columns
    for col in _PATH_COLUMNS:
        if col not in columns:
            continue
        missing: list[tuple[int, str]] = []
        for i, row in enumerate(rows):
            raw = (row.get(col) or "").strip()
            if not raw:
                missing.append((i, f"<empty {col}>"))
                continue
            if siamese_mode:
                obj = (row.get("object_name") or "").strip()
                if not obj:
                    missing.append((i, f"<empty object_name for siamese {col}>"))
                    continue
                # TAO siamese resolution: images_dir/input_path/object_name_light.ext
                resolved = _resolve(raw, workspace_root) / f"{obj}_{light}{image_ext}"
            else:
                resolved = _resolve(raw, workspace_root)
            if not resolved.is_file():
                missing.append((i, f"{raw} -> {resolved}"))
        if missing:
            sample = ", ".join(f"row {i}: {p!r}" for i, p in missing[:5])
            errors.append(
                f"{len(missing)} row(s) reference a missing {col} on disk "
                f"(workspace_root={workspace_root}, siamese={siamese_mode}); first: {sample}"
            )

    if "label" in columns:
        errors.extend(_check_label_case(rows))

    if validation_csv is not None:
        errors.extend(_check_leakage(rows, list(columns), validation_csv))

    return errors


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Validate an assembled ChangeNet training CSV: schema + existence "
            "of every input_path / golden_path, PASS-preserving label case, "
            "and (optionally) train/val leakage. Call this between CSV "
            "assembly and the training docker invocation."
        ),
    )
    parser.add_argument(
        "--csv",
        required=True,
        type=pathlib.Path,
        help="Absolute path to the assembled training CSV.",
    )
    parser.add_argument(
        "--workspace-root",
        required=True,
        type=pathlib.Path,
        help=(
            "Absolute workspace root. Relative input_path / golden_path values "
            "are resolved against this directory; absolute values are used as-is."
        ),
    )
    parser.add_argument(
        "--validation-csv",
        required=False,
        default=None,
        type=pathlib.Path,
        help=(
            "Optional validation CSV. When supplied, the script diffs the "
            "training CSV against it on (input_path, golden_path, label, "
            "object_name, boardname) where present and hard-stops on any "
            "validation row that appears in training."
        ),
    )
    parser.add_argument(
        "--light",
        default="SolderLight",
        help=(
            "Lighting suffix for TAO siamese path resolution: "
            "<input_path>/<object_name>_<light><image_ext>. Default: SolderLight."
        ),
    )
    parser.add_argument(
        "--image-ext",
        default=".jpg",
        help="Image extension for siamese path resolution. Default: .jpg.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    errors = validate(
        args.csv,
        args.workspace_root,
        args.validation_csv,
        light=args.light,
        image_ext=args.image_ext,
    )
    if errors:
        print(
            f"validate_training_csv: FATAL — {len(errors)} issue(s) in {args.csv}",
            file=sys.stderr,
        )
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        return 2
    print(f"validate_training_csv: ok ({args.csv})", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
