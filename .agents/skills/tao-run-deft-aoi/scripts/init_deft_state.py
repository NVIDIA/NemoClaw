# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Initialize ${RESULTS_DIR}/deft_state.json with a guaranteed-unique key set.

Why this exists: earlier inline-dict writes drifted from the canonical schema
in `references/deft_state.json` and produced duplicate top-level keys (`kpi_target`, `results_dir`, `max_iterations`, `current_iteration`) — Python
3.12+ now emits a `SyntaxWarning` for these and the loop's resume logic reads
whichever copy parsing keeps, which is not stable across edits.

This script builds the dict with literal-once keys and writes the JSON. Atomic
write (tmp + os.replace). Refuses to overwrite an existing file unless `--force`
is passed — the resume path is supposed to read disk, not regenerate.

CLI:

    python scripts/init_deft_state.py \
        --results-dir ~/workspace/results/run_20260514_143000 \
        --workspace ~/workspace \
        --kpi-target "FAR < 10% at recall=100%" \
        --max-iterations 2 \
        --num-gpus 4 \
        --num-epochs 20

The output schema mirrors `references/deft_state.json` exactly.
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import pathlib
import sys
import tempfile


_COMPLETED_STEP_VALUES = [
    "evaluate",
    "rca",
    "anomalygen",
    "routing",
    "data_mining",
    "train",
    "loop_stop",
]
_STATUS_VALUES = ["pending", "in_progress", "complete", "failed"]


def _resolve_train_container_from_versions_yaml() -> str | None:
    """Return the resolved tao_toolkit.pyt image URI from versions.yaml.

    Looks at TAO_SKILL_BANK_PATH (exported by the plugin's session_start
    hook). Returns None if the env var is unset, the file is missing, the
    key path is absent, or PyYAML is unavailable. In that case the caller
    must pass --train-container explicitly; the script intentionally has no
    hardcoded fallback tag so versions.yaml remains the single source of
    truth.
    """
    sb = os.environ.get("TAO_SKILL_BANK_PATH")
    if not sb:
        return None
    vy = pathlib.Path(sb) / "versions.yaml"
    if not vy.is_file():
        return None
    try:
        import yaml  # type: ignore[import-untyped]
    except ImportError:
        return None
    try:
        data = yaml.safe_load(vy.read_text())
        return str(data["images"]["tao_toolkit"]["pyt"])
    except (KeyError, TypeError, yaml.YAMLError):
        return None


_DEFAULT_TRAIN_CONTAINER = _resolve_train_container_from_versions_yaml()


def build_state(args: argparse.Namespace) -> dict:
    ws = args.workspace.resolve()
    rd = args.results_dir.resolve()

    state = {
        "version": 2,
        "started_at": datetime.datetime.now(datetime.timezone.utc).isoformat(
            timespec="seconds"
        ),
        "kpi_target": args.kpi_target,
        "results_dir": str(rd),
        "max_iterations": args.max_iterations,
        "current_iteration": 0,
        "config": {
            "specs_file": str(ws / "specs" / "baseline_spec.yaml"),
            "training_csv": str(ws / "train" / "base" / "training_set.csv"),
            "validation_csv": str(ws / "train" / "base" / "validation_set.csv"),
            "kpi_test_csv": str(ws / "kpi" / "testing_set.csv"),
            "images_dir": str(ws / "kpi" / "images"),
            "backbone_weight_dir": str(ws / "augmentation" / "backbone"),
            "train_container": args.train_container,
            "num_gpus": args.num_gpus,
            "batch_size": args.batch_size,
            "num_epochs": args.num_epochs,
            "anomalygen": {
                # EA variant: ingest pre-generated NG/OK pairs from the
                # customer-supplied directory every iter; synth and real are
                # mined together via k-NN (no SDG bypass, no per-iter cap).
                # See SKILL.md Pipeline step 3.
                "sub_skill": None,
                "mode": "pregen_ingest",
                "pregen_dir": str(ws / "augmentation" / "anomalygen"),
                "reconstructed_image_dir": str(
                    ws / "augmentation" / "anomalygen" / "reconstructed_image"
                ),
                "original_image_dir": str(
                    ws / "augmentation" / "anomalygen" / "original_image"
                ),
                "defect_spec": str(
                    ws / "augmentation" / "anomalygen" / "defect_spec.jsonl"
                ),
            },
            "mining_filter": {
                "sub_skill": "tao-mine-aoi-images",
                "top_k_per_target": args.top_k_per_target,
                "metric": args.knn_metric,
                "min_similarity": args.min_similarity,
            },
        },
        "iterations": {},
        "_completed_step_values": list(_COMPLETED_STEP_VALUES),
        "_status_values": list(_STATUS_VALUES),
    }
    return state


def write_atomic(path: pathlib.Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(payload, f, indent=2)
            f.write("\n")
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Initialize deft_state.json with a guaranteed-unique key set. "
            "Refuses to overwrite an existing file unless --force."
        ),
    )
    parser.add_argument("--results-dir", required=True, type=pathlib.Path)
    parser.add_argument("--workspace", required=True, type=pathlib.Path)
    parser.add_argument(
        "--kpi-target",
        required=True,
        help='e.g. "FAR < 10% at recall=100%%"',
    )
    parser.add_argument("--max-iterations", required=True, type=int)
    parser.add_argument("--num-gpus", required=True, type=int)
    parser.add_argument("--num-epochs", required=True, type=int)
    parser.add_argument("--batch-size", default=16, type=int)
    parser.add_argument("--top-k-per-target", default=5, type=int)
    parser.add_argument(
        "--knn-metric",
        default="cosine",
        choices=("cosine", "euclidean", "manhattan"),
    )
    parser.add_argument(
        "--min-similarity",
        default=None,
        type=float,
        help="Cosine similarity threshold for mining (e.g. 0.9). Omit for none.",
    )
    parser.add_argument(
        "--train-container",
        default=_DEFAULT_TRAIN_CONTAINER,
        help=(
            "TAO toolkit container URI. Defaults to versions.yaml::images.tao_toolkit.pyt "
            "(resolved via TAO_SKILL_BANK_PATH). Required when versions.yaml is not reachable."
        ),
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Overwrite an existing deft_state.json. Off by default to protect resume state.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    if not args.train_container:
        print(
            "init_deft_state: --train-container is required because versions.yaml "
            "could not be resolved (set TAO_SKILL_BANK_PATH or pass --train-container).",
            file=sys.stderr,
        )
        return 2
    out = args.results_dir / "deft_state.json"
    if out.exists() and not args.force:
        print(
            f"init_deft_state: refusing to overwrite {out} (use --force).",
            file=sys.stderr,
        )
        return 2
    state = build_state(args)
    write_atomic(out, state)
    print(f"init_deft_state: wrote {out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
