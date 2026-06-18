# Cosmos-RL Spec Construction

cosmos-rl is `mode: config`. **Always start from `references/spec_template_train.yaml`** (or `spec_template_evaluate.yaml` for evaluate) — load it as your base spec via `yaml.safe_load(...)` and apply user overrides on top. Don't rebuild from scratch. See `skills/platform/tao-run-platform/SKILL.md`'s "Constructing the spec / args" section for the load-template-then-override pattern.

```python
import yaml
from pathlib import Path

skill = Path.home() / "tao-sdk/tao-skills-external/models/tao-finetune-cosmos-reason"
specs = yaml.safe_load((skill / "references/spec_template_train.yaml").read_text())
# Now apply your overrides on top of `specs` (next section).
```

The reference TOML (and the spec the model actually consumes) is **nested dicts**, not flat dotted keys. The dotted notation in the override examples below denotes *paths into the nested spec* — the agent must walk the path and assign at the leaf, not store the dotted string as a literal key. See `skills/platform/tao-run-platform/SKILL.md`'s "spec is nested dicts" callout.

## Typical Spec Overrides

These are the typical override **paths** to apply on top of the template (not the full spec). The agent reads each `key.subkey.leaf` as a dotted path and assigns the value at that nested location in the template-loaded `specs` dict.

Data source overrides are **mandatory for every action** — the agent MUST construct data source paths from the Per-Action Dataset Requirements table (see `references/datasets.md`).

```python
TRAIN_DATASET_URI = "s3://bucket/data/train"
EVAL_DATASET_URI = "s3://bucket/data/eval"
# Slurm/internal example:
# TRAIN_DATASET_URI = "/lustre/fsw/tao_datasets/cosmos_rl/train"
# EVAL_DATASET_URI = "/lustre/fsw/tao_datasets/cosmos_rl/eval"
# Direct spec-path example:
# TRAIN_ANNOTATION_PATH = "/lustre/fsw/.../annotations_train.json"
# TRAIN_MEDIA_PATH = "/lustre/fsw/.../videos_train.tar.gz"
# EVAL_ANNOTATION_PATH = "/lustre/fsw/.../annotations_eval.json"
# EVAL_MEDIA_PATH = "/lustre/fsw/.../eval_videos"
```

**train (mandatory data sources):**
```python
{
    "custom.train_dataset": {
        "annotation_path": f"{TRAIN_DATASET_URI}/annotations.json",
        "media_path": TRAIN_DATASET_URI,
    },
    "custom.val_dataset": {
        "annotation_path": f"{EVAL_DATASET_URI}/annotations.json",
        "media_path": EVAL_DATASET_URI,
    },
    "policy.model_name_or_path": "hf_model://nvidia/Cosmos-Reason2-8B",
    "policy.model_max_length": 81920,
    "policy.parallelism.dp_shard_size": 4,
    "policy.parallelism.dp_replicate_size": 1,
    "policy.lora.lora_alpha": 256,
    "policy.lora.r": 16,
    "policy.lora.lora_dropout": 0.05,
    "train.epoch": 1,
    "train.train_batch_per_replica": 32,
    "train.optm_lr": 2e-5,
    "train.optm_impl": "fused",
    "train.deterministic": True,
    "train.ckpt.save_freq_in_epoch": 1,
    "train.ckpt.max_keep": 1,
    "train.train_policy.mini_batch": 1,
    "train.train_policy.dataset.test_size": 0,
    "train.train_policy.dataloader_num_workers": 4,
    "train.train_policy.dataloader_prefetch_factor": 4,
    "validation.freq_in_epoch": 1,
    "validation.batch_size": 1,
    "validation.enable_dataset_cache": False,
    # custom.vision.fps defaults to 1 from the spec template — leave it
    # alone unless you need fixed-count extraction (see Vision Encoders in
    # references/parameters.md).
    "custom.system_prompt": "You are a helpful assistant.",
    "logging.logger": ["console", "tao"],
}
```

`custom.val_dataset.annotation_path` and `custom.val_dataset.media_path` are
valid train schema fields even when `defaults-train.json` does not pre-create
`custom.val_dataset`. Strict validators must check the packaged train schema or
seed the parent `custom.val_dataset` object before applying leaf overrides. Do
not reject those keys as typos just because they are absent from the default
spec object.

**evaluate (mandatory data sources):**
```python
{
    "dataset.annotation_path": f"{EVAL_DATASET_URI}/annotations.json",
    "dataset.media_dir": EVAL_DATASET_URI,
    # vision.fps defaults to 1 — see Vision Encoders in references/parameters.md
    # for fps vs nframes.
    "model.enable_lora": True,
    "model.base_model_path": "hf_model://nvidia/Cosmos-Reason2-8B",
}
```

**quantize (mandatory data sources):**
```python
{
    "calibration_dataset.annotation_path": f"{TRAIN_DATASET_URI}/annotations.json",
    "calibration_dataset.media_dir": TRAIN_DATASET_URI,
    "model.enable_lora": True,
    "model.base_model_path": "hf_model://nvidia/Cosmos-Reason2-8B",
}
```

**inference (mandatory data sources):**
```python
{
    "media": "s3://bucket/data/videos/test_video.mp4",
    "prompt": "When does something happen in the video?",
    "enable_lora": True,
    "base_model_path": "hf_model://nvidia/Cosmos-Reason2-8B",
}
```
