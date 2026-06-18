# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Load FoodSeg103, subsample, save Arrow."""
import argparse, os
from pathlib import Path
import yaml
from datasets import load_dataset


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--config", required=True)
    cfg = yaml.safe_load(open(ap.parse_args().config))
    out_train, out_eval = Path("data/train"), Path("data/eval")
    if out_train.exists() and out_eval.exists():
        print("[prepare] Arrow already present"); return
    token = os.environ.get("HF_TOKEN")
    ds = load_dataset(cfg["dataset_id"], token=token)
    train = ds["train"].shuffle(seed=42).select(range(min(cfg["n_train"], len(ds["train"]))))
    eval_ = ds["validation"].shuffle(seed=42).select(range(min(cfg["n_eval"], len(ds["validation"]))))
    train.save_to_disk(str(out_train))
    eval_.save_to_disk(str(out_eval))
    print(f"[prepare] saved {len(train)} train / {len(eval_)} eval")
    print(f"[prepare] columns: {train.column_names}")


if __name__ == "__main__":
    main()
