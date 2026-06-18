# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Load merve/vqav2-small (validation split), slice into train/eval."""
import argparse, os
from pathlib import Path
import yaml
from datasets import load_dataset


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--config", required=True)
    cfg = yaml.safe_load(open(ap.parse_args().config))
    out_train, out_eval = Path("data/train"), Path("data/eval")
    if out_train.exists() and out_eval.exists():
        print("[prepare] already saved"); return
    token = os.environ.get("HF_TOKEN")
    ds = load_dataset(cfg["dataset_id"], split=cfg.get("dataset_split", "validation"), token=token)
    total = cfg["n_train"] + cfg["n_eval"]
    ds = ds.shuffle(seed=42).select(range(min(total, len(ds))))
    train = ds.select(range(cfg["n_train"]))
    eval_ = ds.select(range(cfg["n_train"], cfg["n_train"] + cfg["n_eval"]))
    train.save_to_disk(str(out_train)); eval_.save_to_disk(str(out_eval))
    print(f"[prepare] {len(train)} train / {len(eval_)} eval")


if __name__ == "__main__":
    main()
