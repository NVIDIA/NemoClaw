# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Pre-flight: stage pre-generated AnomalyGen pairs once per run.

Hoists the per-iter pre-gen ingestion + source_pool assembly out of the loop.
The pre-gen NG/OK pair directory does not change between iterations; only the
k-NN target set does. Running staging + source SigLIP embedding once at
pre-flight removes ~70 GB of duplicate disk and ~50 s of redundant work per
iter on a 10-iter run.

Outputs (under ``<results_dir>/synth_pool/``):
  - ``images/synth_ng/``, ``images/synth_ok/`` — ChangeNet-staged pre-gen pairs
  - ``sdg_rows.csv``                            — ChangeNet 14-col rows + provenance + filepath
  - ``source_pool.csv``, ``source_pool.parquet``— real (mining_pool) + sdg, with provenance + filepath
  - ``manifest.json``                           — counts + paths the loop reads back

The optional ``--embed-with-siglip`` flag also runs SigLIP image embeddings
on the source pool via the data-services container. Skip it if you intend to
let the per-iter mining stage embed the source pool (less optimal but works).
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import subprocess
import sys
from pathlib import Path

# Re-use the existing pair-staging logic instead of duplicating it.
SCRIPT_DIR = Path(__file__).resolve().parent
PAIR_PREPARE = SCRIPT_DIR / "changenet_data_pair_prepare.py"

CHANGENET_COLS = [
    "input_path", "golden_path", "label", "object_name",
    "project", "boardname", "comp_type_2", "mpass_mfail",
    "is_valid", "comp_name", "part_type", "number_of_pins",
    "description", "comp_type_1",
]


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--workspace", required=True, type=Path,
                   help="Workspace root (must contain augmentation/anomalygen/ and augmentation/mining_pool/).")
    p.add_argument("--results-dir", required=True, type=Path,
                   help="Run results directory (RESULTS_DIR). synth_pool/ is created beneath it.")
    p.add_argument("--light", default="SolderLight",
                   help="Lighting suffix used by ChangeNet path resolver (default: SolderLight).")
    p.add_argument("--image-ext", default=".jpg",
                   help="Output image extension (default: .jpg). Pair-prepare converts as needed.")
    p.add_argument("--embed-with-siglip", action="store_true",
                   help="Also run source-pool SigLIP embedding via the data-services container.")
    p.add_argument("--ds-image", default=None,
                   help="data-services image URI (required with --embed-with-siglip).")
    p.add_argument("--siglip-model", default="google/siglip-base-patch16-224",
                   help="SigLIP model id or local path (default: google/siglip-base-patch16-224).")
    p.add_argument("--force", action="store_true",
                   help="Overwrite an existing synth_pool/ directory.")
    return p.parse_args()


def stage_pairs(pregen_dir: Path, synth_pool: Path, light: str, image_ext: str) -> Path:
    """Invoke changenet_data_pair_prepare.py to copy + emit the 14-col sdg CSV."""
    images_root = synth_pool / "images"
    images_root.mkdir(parents=True, exist_ok=True)
    sdg_csv = synth_pool / "sdg_rows_raw.csv"
    cmd = [
        sys.executable, str(PAIR_PREPARE),
        "--input-dir",  str(pregen_dir / "reconstructed_image"),
        "--golden-dir", str(pregen_dir / "original_image"),
        "--output",     str(sdg_csv),
        "--label",      "NG",
        "--images-dir", str(images_root),
        "--subdir",     "synth",
        "--light",      light,
        "--image-ext",  image_ext,
    ]
    subprocess.run(cmd, check=True)
    return sdg_csv


def build_source_pool(
    workspace: Path, synth_pool: Path, sdg_raw: Path, results_dir: Path, image_ext: str
) -> tuple[Path, Path, dict]:
    """Combine real mining_pool + staged sdg into source_pool.{csv,parquet}.

    Paths in source_pool are workspace-root-relative ChangeNet directories so
    the per-iter training spec (images_dir=/data/workspace) can resolve them
    without further rewrites.
    """
    import pandas as pd  # deferred — heavy import

    # --- Real rows ---
    real = pd.read_csv(workspace / "augmentation" / "mining_pool" / "mining_pool.csv")
    # mining_pool input_path includes the file basename; strip it so ChangeNet's
    # {images_dir}/{input_path}/{object_name}_{light}{ext} formula resolves.
    real["input_path"]  = real["input_path"].apply(lambda p: "augmentation/mining_pool/" + os.path.dirname(p))
    real["golden_path"] = real["golden_path"].apply(lambda p: "kpi/images/" + str(p).lstrip("/"))
    real["provenance"]  = "real"
    for c in CHANGENET_COLS:
        if c not in real.columns:
            real[c] = ""
    real["filepath"] = (
        str(workspace) + "/" + real["input_path"] + "/" + real["object_name"] + "_SolderLight" + image_ext
    )

    # --- SDG rows ---
    sdg = pd.read_csv(sdg_raw)
    # Rewrite the bare "synth_ng/" paths to workspace-root-relative ones rooted
    # under results_dir so the training spec resolves them.
    rel = results_dir.relative_to(workspace)
    sdg["input_path"]  = f"{rel}/synth_pool/images/synth_ng"
    sdg["golden_path"] = f"{rel}/synth_pool/images/synth_ok"
    sdg["provenance"]  = "sdg"
    sdg["label"]       = sdg["label"].apply(lambda l: l if l == "PASS" else str(l).lower().strip())
    sdg["filepath"]    = (
        str(workspace) + "/" + sdg["input_path"] + "/" + sdg["object_name"] + "_SolderLight" + image_ext
    )

    # --- Verify on-disk presence (cheap sanity check) ---
    missing_real = [p for p in real["filepath"] if not os.path.isfile(p)]
    missing_sdg  = [p for p in sdg["filepath"]  if not os.path.isfile(p)]
    if missing_real or missing_sdg:
        raise FileNotFoundError(
            f"source_pool integrity check failed: missing_real={len(missing_real)} missing_sdg={len(missing_sdg)}; "
            f"first missing real={missing_real[:2]} first missing sdg={missing_sdg[:2]}"
        )

    out_cols = CHANGENET_COLS + ["provenance", "filepath"]
    pool = pd.concat([real[out_cols], sdg[out_cols]], ignore_index=True)

    csv_path     = synth_pool / "source_pool.csv"
    parquet_path = synth_pool / "source_pool.parquet"
    pool.to_csv(csv_path, index=False)
    pool.to_parquet(parquet_path, index=False)

    sdg[out_cols].to_csv(synth_pool / "sdg_rows.csv", index=False)

    return csv_path, parquet_path, {
        "real_rows":  int(len(real)),
        "sdg_rows":   int(len(sdg)),
        "total_rows": int(len(pool)),
    }


def embed_source_pool_with_siglip(
    workspace: Path, synth_pool: Path, source_parquet: Path, ds_image: str, siglip_model: str
) -> Path:
    """Run the data-services embedding container once on the source pool.

    Per-iter mining can then skip step 2 and reuse this parquet.
    """
    embed_spec = synth_pool / "embedding_spec.yaml"
    embed_spec.write_text(
        f"model: SigLIP\nmodel_path: {siglip_model}\nbatch_size: 64\n"
    )
    (synth_pool / "experiment_specs").mkdir(exist_ok=True)
    out_parquet = synth_pool / "source_embeddings.parquet"
    log_path = synth_pool / "source_embed.log"

    hf_token = os.environ.get("HF_TOKEN", "")
    cmd = [
        "docker", "run", "--gpus", "all", "--rm", "--ipc=host",
        "-e", f"HF_TOKEN={hf_token}",
        "-e", f"HUGGING_FACE_HUB_TOKEN={hf_token}",
        "-v", f"{workspace}:{workspace}",
        "-w", str(synth_pool),
        ds_image, "embedding", "image_embeddings",
        "-e", str(embed_spec),
        f"input_parquet={source_parquet}",
        f"output_parquet={out_parquet}",
    ]
    with log_path.open("w") as lf:
        rc = subprocess.run(cmd, stdout=lf, stderr=subprocess.STDOUT).returncode
    if rc != 0 or not out_parquet.is_file():
        raise RuntimeError(
            f"SigLIP embedding failed (rc={rc}); tail of {log_path}:\n"
            + "\n".join(log_path.read_text().splitlines()[-20:])
        )
    return out_parquet


def main() -> int:
    args = parse_args()
    workspace: Path = args.workspace.resolve()
    results_dir: Path = args.results_dir.resolve()
    synth_pool = results_dir / "synth_pool"

    if synth_pool.exists():
        if not args.force:
            print(f"refuse-to-overwrite: {synth_pool} (use --force)", file=sys.stderr)
            return 2
        import shutil
        shutil.rmtree(synth_pool)
    synth_pool.mkdir(parents=True)

    pregen_dir = workspace / "augmentation" / "anomalygen"
    for sub in ("reconstructed_image", "original_image"):
        d = pregen_dir / sub
        if not d.is_dir() or not any(d.iterdir()):
            print(f"missing or empty: {d}", file=sys.stderr)
            return 1

    sdg_raw = stage_pairs(pregen_dir, synth_pool, args.light, args.image_ext)
    csv_path, parquet_path, counts = build_source_pool(
        workspace, synth_pool, sdg_raw, results_dir, args.image_ext
    )

    embed_parquet: Path | None = None
    if args.embed_with_siglip:
        if not args.ds_image:
            print("--embed-with-siglip requires --ds-image", file=sys.stderr)
            return 1
        embed_parquet = embed_source_pool_with_siglip(
            workspace, synth_pool, parquet_path, args.ds_image, args.siglip_model
        )

    manifest = {
        "schema_version": 1,
        "workspace": str(workspace),
        "results_dir": str(results_dir),
        "synth_pool_dir": str(synth_pool),
        "source_pool_csv": str(csv_path),
        "source_pool_parquet": str(parquet_path),
        "source_embeddings_parquet": str(embed_parquet) if embed_parquet else None,
        "sdg_rows_csv": str(synth_pool / "sdg_rows.csv"),
        "ng_dir": str(synth_pool / "images" / "synth_ng"),
        "ok_dir": str(synth_pool / "images" / "synth_ok"),
        "siglip_model": args.siglip_model if args.embed_with_siglip else None,
        "counts": counts,
    }
    (synth_pool / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(json.dumps(manifest, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
