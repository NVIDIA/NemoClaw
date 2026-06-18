# Defect Image Generation Container Images

Canonical image references for the active Defect Image Generation skill. Keep
the workflow YAML defaults and this file in sync when updating tags.

## Main Runtime Components

| Component | Workflow variable | Image | Used by | Notes |
|---|---|---|---|---|
| usd2roi (texture lane) | `usd2roi_image` | `nvcr.io/nvidia/paidf-simulation:1.0.0` | Day 0 texture, Day 1 real-photo alignment | Isaac Sim full-app image used by the usd2roi → image-edit → infer chain. Scripts live under `/workspace/paidf-simulation/`; invoke Kit directly when OSMO overrides `command`. |
| sdg_pipeline + crop_components (IsaacSim lane) | `isaac_render_image` | `nvcr.io/nvidia/paidf-simulation:1.0.0` | `structural_defect_generation.yaml` | Same image as the usd2roi tag; ships `scripts/sdg/standalone/sdg_pipeline.py` + `scripts/postprocess/crop_components.py`. Crop step uses `--entrypoint python3`. |
| image-edit augmentation | `augmentation_image` | `nvcr.io/nvidia/paidf-augmentation:1.0.0` | Day 0 texture, Day 0 good-image, Day 0 structural-defect | Runs the augmentation client and calls `image_edit_endpoint`; the Qwen serving endpoint is separate. The two IsaacSim Day-0 flows ship their own `build_batch_config.py` adapter (flat `rgb/*.png` layout) while the texture lane walks `<MATERIAL>/<cell>/normal_img/`. |
| anomalygen | `anomalygen_image` | `nvcr.io/nvidia/paidf-anomalygen:1.0.0` | Day 0 texture, Day 1, finetune, setup prep | Powers finetune, inference, and prepared-data setup. Repo is baked at `/workspace/paidf-anomalygen/`. Ships `ngc` CLI on PATH. |

## Setup Images

| Purpose | Workflow variable | Image | Used by | Notes |
|---|---|---|---|---|
| Pretrained bundle + per-case setup | `pretrained_image` | `nvcr.io/nvidia/paidf-anomalygen:1.0.0` | `setup/setup_pretrained.yaml`, `setup/setup_pcb.yaml`, `setup/setup_metal.yaml`, `setup/setup_glass.yaml` | Same image as `anomalygen_image`; ships repo and baked checkpoints. Used by every download group across the four setup workflows. |

## Day 0 Image-Edit Endpoint Images

| Purpose | Location | Image | Notes |
|---|---|---|---|
| Local NVPCB OVSL2SL endpoint | `references/nim/qwen-image-edit-nvpcb-ovsl2sl.yaml` | `vllm/vllm-omni:v0.20.0` | NIM Operator `NIMService` that mirrors the local Docker command for `nvidia/Qwen-Image-Edit-NVPCB-OVSL2SL` via `spec.command`/`spec.args`. |
| Endpoint verification pod | `references/nim/README.md` | `curlimages/curl` | Docs-only helper for probing `/v1/models`; not part of the Defect Image Generation runtime workflow. |

## Current Workflow Defaults

| Workflow | Runtime images |
|---|---|
| `assets/configs/texture_defect_generation_day0.yaml` | `usd2roi_image`, `augmentation_image`, `anomalygen_image` |
| `assets/configs/good_image_generation.yaml` | `usd2roi_image`, `augmentation_image` |
| `assets/configs/structural_defect_generation.yaml` | `isaac_render_image`, `augmentation_image` |
| `assets/configs/texture_defect_generation_day1_manual_roi.yaml` | `anomalygen_image` |
| `assets/configs/texture_defect_generation_day1_real_alignment.yaml` | `usd2roi_image`, `anomalygen_image` |
| `assets/configs/finetune.yaml` | `anomalygen_image` |
| `assets/configs/setup/setup_pretrained.yaml` | `pretrained_image` |
| `assets/configs/setup/setup_pcb.yaml` | `pretrained_image` |
| `assets/configs/setup/setup_metal.yaml` | `pretrained_image` |
| `assets/configs/setup/setup_glass.yaml` | `pretrained_image` |

## Update Rule

When changing one of the three main runtime component images:

1. Update every workflow YAML default that exposes the corresponding variable.
2. Update the table above in this file.
3. Search the skill for the old tag and remove stale references:

```bash
rg '<old-image-or-tag>' skills/physical-ai-defect-image-generation
```
