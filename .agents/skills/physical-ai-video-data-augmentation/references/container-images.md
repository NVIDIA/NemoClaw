# Video Data Augmentation Container Images

Canonical image references for the active VDA skill. Keep workflow YAML defaults
and this file in sync when updating tags.

## Main Runtime Components

| Component | Workflow variable/location | Image | Used by | Notes |
|---|---|---|---|---|
| Setup/config generation | `tasks.setup.image` | `nvcr.io/nvidia/base/ubuntu:22.04_20240212` | all flows | Copies scripts/cookbooks and materializes `configs/` + `.env` |
| Augmentation worker | `cosmos_worker_*.image` | `nvcr.io/nvidia/paidf-augmentation:1.0.0` | `augmentation_and_al`, `e2e`, `e2e_super_resolution` | Runs cosmos transfer workflow; expects cosmos cache URL mount |
| Auto-labeling worker | `pl_*_worker_*.image` | `nvcr.io/nvidia/paidf-auto-labeling:1.0.0` | all flows | Runs original/augmented pseudo-labeling workers; expects auto-labeling cache URL mount |

## Setup Model Cache Workflow Images

| Purpose | Workflow file | Image | Notes |
|---|---|---|---|
| Cosmos cache download | `assets/configs/osmo/setup_model_cache.yaml` task `download_cosmos_cache` | `nvcr.io/nvidia/base/ubuntu:22.04_20240212` | Pulls HF artifacts and resolves symlinks before upload |
| Auto-labeling cache download | `assets/configs/osmo/setup_model_cache.yaml` task `download_auto_labeling_cache` | `nvcr.io/nvidia/base/ubuntu:22.04_20240212` | Pulls SeedVR2/ReID/RFDeTR assets before upload |

## Endpoint Runtime Note

VLM/LLM inference for VDA defaults to persistent in-cluster NIM endpoints:

- `qwen3-vl` at `http://qwen3-vl.osmo-nims.svc.cluster.local:8000/v1`
- `qwen25-14b` at `http://qwen25-14b.osmo-nims.svc.cluster.local:8000/v1`

Those endpoint containers are managed outside VDA workflow YAMLs (see
`references/nim/README.md`).

## Current Workflow Defaults

| Workflow | Runtime images |
|---|---|
| `assets/configs/osmo/auto_labeling.yaml` | setup + auto-labeling |
| `assets/configs/osmo/augmentation_and_al.yaml` | setup + augmentation + auto-labeling |
| `assets/configs/osmo/e2e.yaml` | setup + augmentation + auto-labeling |
| `assets/configs/osmo/e2e_super_resolution.yaml` | setup + augmentation + auto-labeling |
| `assets/configs/osmo/setup_model_cache.yaml` | setup-cache ubuntu tasks |

## Update Rule

When changing runtime image tags:

1. Update every impacted OSMO YAML default.
2. Update this file.
3. Search for stale tags in the skill directory and clean them.
