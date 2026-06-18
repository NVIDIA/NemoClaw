# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Load CPPE-5, split train into train+val, save Arrow."""
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
    ds = load_dataset(cfg["dataset_id"], token=token, trust_remote_code=True)
    # CPPE-5: 1000 train / 29 test. Split train 800/200 → use 29-sample test separately if desired.
    full = ds["train"].shuffle(seed=42)
    n_train = min(cfg["n_train"], len(full))
    n_eval = min(cfg["n_eval"], len(full) - n_train)
    train = full.select(range(n_train))
    eval_ = full.select(range(n_train, n_train + n_eval))
    train.save_to_disk(str(out_train))
    eval_.save_to_disk(str(out_eval))
    print(f"[prepare] saved {len(train)} train / {len(eval_)} eval")
    print(f"[prepare] columns: {train.column_names}")


if __name__ == "__main__":
    main()
