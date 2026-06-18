# Defect Image Generation — Asset Setup


## Table of Contents

- [What you get](#what-you-get)
- [Prerequisites](#prerequisites)
- [Credential check](#credential-check)
- [OSMO setup workflows](#osmo-setup-workflows)
- [URL artifact layout](#url-artifact-layout)
  - [Per-artifact root layout + key files](#per-artifact-root-layout-key-files)
  - [Per-use-case parameter values](#per-use-case-parameter-values)
  - [`pcba_target.yaml` is mounted from the cookbook](#pcba_targetyaml-is-mounted-from-the-cookbook)
- [Bring your own data or models](#bring-your-own-data-or-models)
  - [Naming gotcha: `--set` parses numeric-looking values as PEP 515 ints](#naming-gotcha---set-parses-numeric-looking-values-as-pep-515-ints)
- [Wiring into Day 0 / Day 1 / finetune](#wiring-into-day-0-day-1-finetune)
  - [Day 0 (PCBA, full pipeline)](#day-0-pcba-full-pipeline)
  - [Day 1 (Metal surface or Glass)](#day-1-metal-surface-or-glass)
  - [Finetune flow (from scratch — Finetune Only)](#finetune-flow-from-scratch-finetune-only)
- [Troubleshooting](#troubleshooting)

> For per-flow submit commands and shipped-dataset taxonomies, see `references/troubleshooting.md`. For workflow container images, see `references/container-images.md`.

One-time download of finetuned anomalygen checkpoints + per-use-case datasets + the PCBA USD asset bundle + the ~71 GB `models/pretrained` checkpoint tree (all from Hugging Face except UC2 metal, which still comes from public GitHub) into URL-backed OSMO storage artifacts. Setup is split across four narrow workflow YAMLs under `assets/configs/setup/` — submit only the ones the use case needs; they run in-cluster, in parallel.

> **Always set up assets via the OSMO setup workflows** (`setup/setup_<case>.yaml` + `setup/setup_pretrained.yaml`) — never download assets locally to work around a problem. If setup fails on credentials (HF license/scope, missing `hf-token`) or an image pull, **stop and ask the user to rectify it**, then re-submit on OSMO (pull failures: Troubleshooting → "nvcr.io image pull failures"). A cluster that genuinely can't reach Hugging Face or `nvcr.io` is an environment issue to raise with the user, not route around.

## What you get

Eight URL artifacts:

| Default URL | Source | Use case | Asset type |
|---|---|---|---|
| `s3://osmo-workflows/dig/models/pcb` | `nvidia/Cosmos-AnomalyGen-PCB-2B` (HF model) via `scripts/utilities/download_anomalygen_checkpoints.sh --uc pcb` | PCBA | finetuned anomalygen checkpoint (iter 14000) + `ag_config.yaml` |
| `s3://osmo-workflows/dig/models/metal_surface` | `nvidia/Cosmos-AnomalyGen-Metal-2B` (HF model) via `download_anomalygen_checkpoints.sh --uc metal` | Metal surface | finetuned anomalygen checkpoint (iter 10000) + `ag_config.yaml` |
| `s3://osmo-workflows/dig/models/glass` | `nvidia/Cosmos-AnomalyGen-Glass-2B` (HF model) via `download_anomalygen_checkpoints.sh --uc glass` | Glass | finetuned anomalygen checkpoint (iter 9000) + `ag_config.yaml` |
| `s3://osmo-workflows/dig/datasets/pcb/raw` | `nvidia/Cosmos-AnomalyGen-PCB-Dataset` (HF dataset) via `scripts.utilities.prepare_dataset_uc1` | PCBA | raw training tree: clean_image + cad_mask + submasks + `defect_spec.jsonl` + `semantic_segmentation_labels.json` |
| `s3://osmo-workflows/dig/datasets/metal_surface/raw` | [`abin24/Magnetic-tile-defect-datasets.`](https://github.com/abin24/Magnetic-tile-defect-datasets.) (public GitHub) via `scripts.utilities.prepare_dataset_uc2` | Metal surface | curated UC2 subset: 5 anomaly + 5 masks per defect × 5 defects, 20 clean images + `defect_spec.jsonl` |
| `s3://osmo-workflows/dig/datasets/glass/raw` | `nvidia/Cosmos-AnomalyGen-Glass-Masks` (HF dataset, masks + `defect_spec.jsonl` only — NV derivatives, no images) overlaid with user-supplied Roboflow Mobile-Screen zip via `prepare_dataset_uc3.py --masks-from-hf` | Glass | `Phone/{anomaly_image,clean_image}/` from user zip; `Phone/mask/<defect>/` + `defect_spec.jsonl` from HF. Material dir is **`Phone`**. **Prerequisite: upload `mobile_screen.zip` to an OSMO URL prefix first, then submit with `--set uc3_zip_url_root=<prefix>`** — see "Glass case (UC3)" steps below. |
| `s3://osmo-workflows/dig/datasets/pcb/assets` | `nvidia/Spark-AnomalyGen-USD` (HF dataset repo) | PCBA | USD scene + asset tree + per-board real photos at `input_real_image/<board>.jpg` (e.g. `0603_H100.jpg`, `115_2819_000.jpg`) |
| `s3://osmo-workflows/dig/models/pretrained` | nvcr.io `paidf-anomalygen` container (baked NVDINOV2 / SAM2 / Qwen3-VL) + HF gated (`nvidia/Cosmos-Predict2-*`) + HF public (`nvidia/C-RADIOv3-B`, `google-t5/t5-large`, `facebook/dinov2-large`) | all | ~71 GB pretrained bundle (model_sizes=2B; ~140 GB with `2B 14B`) |

> **Metal UC2 source (GitHub):** The upstream repository is [`abin24/Magnetic-tile-defect-datasets.`](https://github.com/abin24/Magnetic-tile-defect-datasets.) — the slug **ends with a literal period** (not a documentation typo). Fetch via OSMO only: submit `setup/setup_metal.yaml`; the `download-metal_surface-data` task runs `prepare_dataset_uc2`, which clones that slug in-cluster.

## Prerequisites

1. **HF token** with read access to the gated `nvidia/Cosmos-AnomalyGen-*` + `nvidia/Cosmos-Predict2-*` + `nvidia/Spark-AnomalyGen-USD` repos. Export locally as `HF_TOKEN`. Sanity-check with a REST probe:
   ```bash
   curl -sI -H "Authorization: Bearer $HF_TOKEN" \
     https://huggingface.co/api/models/nvidia/Cosmos-AnomalyGen-PCB-2B \
     | head -1
   ```
   A `200` means the token can read the gated repo; `401`/`403` means either the token lacks scope or the license hasn't been accepted yet — visit each gated repo page in a browser once and click "Accept" before the OSMO workflow first runs.
2. **NGC API key** — not required. The `paidf-*` workflow images are public on `nvcr.io/nvidia/` and pull anonymously, so no NGC key is needed.
3. **Registry credential** — not required. The workflow YAMLs no longer reference an `nvcr_io` (or any REGISTRY) credential; pulls succeed anonymously. If image pulls fail (authorization error or `nvcr.io` rate-limiting), see `references/troubleshooting.md` → **"nvcr.io image pull failures"** for how to add an NGC pull credential.
4. **OSMO `hf-token` credential** (GENERIC) — required by every group that hits HF (i.e. everything except `download-metal_surface-data`). Accept the model license on each gated page once before first run:
   - https://huggingface.co/nvidia/Cosmos-Predict2-2B-Text2Image
   - https://huggingface.co/nvidia/Cosmos-Predict2-14B-Text2Image
   - https://huggingface.co/nvidia/Cosmos-AnomalyGen-PCB-2B
   - https://huggingface.co/nvidia/Cosmos-AnomalyGen-Metal-2B
   - https://huggingface.co/nvidia/Cosmos-AnomalyGen-Glass-2B
   - https://huggingface.co/datasets/nvidia/Cosmos-AnomalyGen-PCB-Dataset
   - https://huggingface.co/datasets/nvidia/Cosmos-AnomalyGen-Glass-Masks
   - https://huggingface.co/datasets/nvidia/Spark-AnomalyGen-USD
   ```bash
   osmo credential set hf-token --type GENERIC \
     --payload token="$HF_TOKEN"
   ```
5. **Pod-template prerequisites (simulation + finetuning)** — two cluster-level mounts gate DIG GPU work. If a preflight or in-pod check trips on either, **tell the user which mount is missing and why it matters, and seek approval before routing to `physical-ai-infrastructure-setup-and-resilient-scaling`** — that fix mutates the cluster-wide `POD_TEMPLATE`.
   - **`/usr/share/nvidia/nvoptix.bin`** (OptiX denoiser binary) — required by the IsaacSim render tasks (`usd2roi-render`, `usd2roi-render-day1`, `sdg-and-crop`); hostPath-mounted at the same path. Without it Kit silently degrades to noisy raw path tracing (no error, no non-zero exit) — it gates render/ROI quality.
   - **`/dev/shm` ≥ 16 GiB (32 GiB preferred)** — required by **both** the IsaacSim ray-tracer (intermediate buffers) **and the finetuning/training tasks** (`finetune.yaml`, the Day-0 train step, Day-1 finetune-from-scratch), where it backs torchrun shared-memory. Undersized → in-pod preflight fails or torchrun OOMs mid-training.
   - **Asset directory perms** — handled inside OSMO by the workflow's pre-task `chmod 777 $OUT`.

   The OSMO pod template controls both mounts. Validate via `scripts/preflight_pod_template.sh` (or the infra skill's pod-template gate); the in-pod runtime preflight on every OV + training task is the backstop.

   The two IsaacSim Day-0 workflows pin `isaac_render_image` to `nvcr.io/nvidia/paidf-simulation:1.0.0`. See `references/container-images.md` for the canonical tag table.

## Credential check

`scripts/preflight_credentials.sh` is the canonical front door for prereqs §1–§4. The only credential the workflows require is the OSMO credential `hf-token` (GENERIC) — that is what gates the Hugging Face downloads every flow performs. There is **no registry credential requirement**: the `paidf-*` images are public on `nvcr.io/nvidia/` and pull anonymously. The env var `HF_TOKEN` is only needed when (a) `hf-token` is missing and the script needs to **auto-set** it, or (b) you want the outbound HF probe to verify the token still has read scope on the gated `nvidia/Cosmos-AnomalyGen-*` repos. **If `hf-token` is already provisioned and you skip probes, no env var is needed.** Run it before submitting any setup workflow and before every flow submission.

> **Check for a workspace `.env` first.** Before running the credential check, if a `.env` file exists in the agent's workspace, source it so its credentials are exported — `set -a; . ./.env; set +a`. It commonly carries `HF_TOKEN` (and `NGC_API_KEY` for the image-pull fallback), letting the script auto-set the OSMO credential without prompting the user.

```bash
# Default: probe HF (using exported HF_TOKEN), auto-set any missing OSMO credential
bash skills/physical-ai-defect-image-generation/scripts/preflight_credentials.sh

# Restricted-egress shells — skip the outbound HTTPS probe
bash skills/physical-ai-defect-image-generation/scripts/preflight_credentials.sh --no-probe
```

Sample success (`hf-token` already provisioned, `HF_TOKEN` not exported, probes off):

```
note: skipping HF probe — HF_TOKEN not exported (OSMO credential 'hf-token' is already provisioned).
OK: OSMO credential hf-token present (paidf-* images are public on nvcr.io/nvidia/ — no registry credential needed).
```

Sample failure (HF token can't read gated AnomalyGen repos):

```
HF gated-repo probe failed (HTTP 401) at https://huggingface.co/api/models/nvidia/Cosmos-AnomalyGen-PCB-2B
  HF_TOKEN cannot read the gated Cosmos-AnomalyGen repos. Accept the license once at each:
    https://huggingface.co/nvidia/Cosmos-AnomalyGen-PCB-2B
    https://huggingface.co/nvidia/Cosmos-AnomalyGen-Metal-2B
    https://huggingface.co/nvidia/Cosmos-AnomalyGen-Glass-2B
```

Use the manual `curl` snippet from Prerequisites §1 to inspect the raw response if the probe fails.

## OSMO setup workflows

Setup is split across four narrow workflows under `assets/configs/setup/`. Submit only the workflows the use case actually needs — every workflow has no submit-time list parameter, so there is nothing to ignore. The pretrained bundle is its own workflow because every use case needs it; submit it in parallel with whichever case workflows you need. All groups run inside the `paidf-anomalygen` image — it ships `hf` CLI, `prepare_dataset_uc{1,2,3}.py`, and `download_anomalygen_checkpoints.sh`.

| Workflow | Groups | Output URL artifacts |
|---|---|---|
| `setup/setup_pretrained.yaml` | `download-pretrained` (HF Cosmos-Predict2 + T5 + dinov2 + container-baked NVDINOV2/SAM2/Qwen + HF C-RADIOv3-B) | `models/pretrained` |
| `setup/setup_pcb.yaml` | `download-pcb-model` (HF `nvidia/Cosmos-AnomalyGen-PCB-2B`), `download-pcb-data` (`prepare_dataset_uc1` on HF `nvidia/Cosmos-AnomalyGen-PCB-Dataset`), `download-pcb-assets` (HF `nvidia/Spark-AnomalyGen-USD`) | `models/pcb`, `datasets/pcb/raw`, `datasets/pcb/assets` |
| `setup/setup_metal.yaml` | `download-metal_surface-model` (HF `nvidia/Cosmos-AnomalyGen-Metal-2B`), `download-metal_surface-data` (`prepare_dataset_uc2` on public GitHub [`abin24/Magnetic-tile-defect-datasets.`](https://github.com/abin24/Magnetic-tile-defect-datasets.); no HF token, needs outbound github.com) | `models/metal_surface`, `datasets/metal_surface/raw` |
| `setup/setup_glass.yaml` | `download-glass-model` (HF `nvidia/Cosmos-AnomalyGen-Glass-2B`), `download-glass-data` (`prepare_dataset_uc3 --masks-from-hf` on HF `nvidia/Cosmos-AnomalyGen-Glass-Masks` + user Roboflow zip URL-mounted via `uc3_zip_url_root`) | `models/glass`, `datasets/glass/raw` |

Pure download/assembly only — no GPU work. Validation JSONL + AMP placements are produced downstream at finetune / inference time (per the anomalygen skill contract: Phase 1 Step 2 for validation, Phase 2 for inference). Each group writes to its own URL output under `dig_url_root`. The four workflows have no inter-dependencies; submit any subset in parallel.

```bash
# Validate each spec first — catches name/credential/shape errors without queuing
osmo workflow validate skills/physical-ai-defect-image-generation/assets/configs/setup/setup_pretrained.yaml
osmo workflow validate skills/physical-ai-defect-image-generation/assets/configs/setup/setup_pcb.yaml

# PCBA-only path — pretrained bundle + PCB assets, no metal/glass:
osmo workflow submit skills/physical-ai-defect-image-generation/assets/configs/setup/setup_pretrained.yaml --pool <pool>
osmo workflow submit skills/physical-ai-defect-image-generation/assets/configs/setup/setup_pcb.yaml          --pool <pool>

# PCBA + metal_surface — submit pretrained once, plus the two case workflows:
osmo workflow submit skills/physical-ai-defect-image-generation/assets/configs/setup/setup_pretrained.yaml --pool <pool>
osmo workflow submit skills/physical-ai-defect-image-generation/assets/configs/setup/setup_pcb.yaml          --pool <pool>
osmo workflow submit skills/physical-ai-defect-image-generation/assets/configs/setup/setup_metal.yaml       --pool <pool>

# Glass — REQUIRES the Roboflow zip to be uploaded first (see "Glass case" steps below):
osmo workflow submit skills/physical-ai-defect-image-generation/assets/configs/setup/setup_pretrained.yaml --pool <pool>
osmo workflow submit skills/physical-ai-defect-image-generation/assets/configs/setup/setup_glass.yaml       --pool <pool> \
  --set uc3_zip_url_root=s3://osmo-workflows/dig/uploads/glass-zip
```

**Glass case (UC3) — Roboflow zip prerequisite. Do this BEFORE submitting `setup_glass.yaml`:**

1. **Download** the COCO export once (license-gated, browser flow required — Roboflow does not support unauthenticated programmatic download):
   - Visit https://universe.roboflow.com/vu-thi-thu-huyen/mobile-screen
   - Click **Export Dataset** → **COCO** format → download the zip
   - Accept the dataset license/terms once
2. **Rename the file to exactly `mobile_screen.zip`** (the workflow looks for that literal filename inside the staged dir):
   ```bash
   mv /path/to/<roboflow-download>.zip /tmp/mobile_screen.zip
   ```
3. **Upload to an OSMO URL prefix** (any prefix you control; this skill's docs use `s3://osmo-workflows/dig/uploads/glass-zip/` by convention):
   ```bash
   osmo data upload s3://osmo-workflows/dig/uploads/glass-zip/ /tmp/mobile_screen.zip
   # Verify it landed:
   osmo data list --no-pager s3://osmo-workflows/dig/uploads/glass-zip/
   # Should show: mobile_screen.zip
   ```
   > ⚠ **Always pass the destination as a trailing-slash prefix** (`.../glass-zip/`), NOT as a key (`.../glass-zip/mobile_screen.zip`). The OSMO data adapter (MinIO-compatibility edge case) treats a no-slash key whose tail matches an existing prefix as a prefix itself and creates `mobile_screen.zip/mobile_screen.zip` (the outer is a directory). The workflow's `[ -f "$UC3_ZIP_DIR/mobile_screen.zip" ]` then fails because `-f` returns false on directories. If you've already uploaded with the key form, list the prefix, remove the nested directory, and re-upload with the trailing-slash form.
4. **Then submit** with `--set uc3_zip_url_root=<that-prefix>` (the prefix, not the file itself).

The workflow URL-mounts the prefix into the task at `{{input:0}}`, copies the zip
to `/tmp/uc3_input.zip`, and runs `prepare_dataset_uc3.py` to extract images
alongside the masks + `defect_spec.jsonl` pulled from `cosmos-anomalygen-glass-masks`.

> **Why URL-mounted, not `localpath:`?** OSMO's `localpath:` mechanism reads every
> staged file as UTF-8 text during `validate`/`submit` and rejects binary zips with
> `UnicodeDecodeError: 'utf-8' codec can't decode byte 0xb7 ...`. URL-mounted inputs
> sidestep that codepath entirely.

Submitting `setup_glass.yaml` with an empty `uc3_zip_url_root` fails at `osmo workflow validate` (OSMO rejects an empty URL input).

**Knobs** (override via `--set`; pass multiple as `--set k1=v1 k2=v2`; scope column lists which workflow files accept the knob):

| Param | Default | Scope | Notes |
|---|---|---|---|
| `uc3_zip_url_root` | `""` (empty — required) | `setup_glass.yaml` only | **OSMO URL prefix** (not a local path) containing `mobile_screen.zip` — the user-downloaded Roboflow Mobile-Screen COCO export. Upload the zip to this prefix **before** submitting (`osmo data upload <prefix>/ <local-zip>`). The workflow URL-mounts the prefix into the `glass-data` task and copies `mobile_screen.zip` to `/tmp/uc3_input.zip` for `prepare_dataset_uc3.py --masks-from-hf`. URL-mounted (not `localpath:`) because OSMO CLI fails UTF-8 decode on binary zips during validate/submit. |
| `dig_url_root` | `s3://osmo-workflows/dig` | all four | Single DIG root. Setup writes checkpoints under `models/<case>`, pretrained under `models/pretrained`, raw training data under `datasets/<case>/raw`, and CAD assets under `datasets/<case>/assets`. |
| `pretrained_image` | See `references/container-images.md` | all four | Image for **every** download group — ships repo, baked checkpoints, `hf` CLI, `download_anomalygen_checkpoints.sh`, and the three `prepare_dataset_uc*.py` scripts. Public on `nvcr.io/nvidia/`; pulled anonymously (no registry credential). |
| `cpu` / `memory` / `storage` | `1` / `2Gi` / `10Gi` | `setup_pcb.yaml`, `setup_metal.yaml`, `setup_glass.yaml` | Sizing for the per-UC model and dataset groups + the pcb-assets group. |
| `pretrained_model_sizes` | `"2B"` | `setup_pretrained.yaml` | Space-separated; `"2B 14B"` adds the 14B Cosmos-Predict2 checkpoint (~64 GB extra). With `2B 14B`, also bump `storage_large` to ≥300Gi. |
| `cpu_large` / `memory_large` / `storage_large` | `1` / `16Gi` / `220Gi` | `setup_pretrained.yaml` | The default 2B bundle is about 71 GB; HF Hub streams to disk and does not need high RAM. |

**Watch progress:** live status and per-task logs — see `SKILL.md` §"OSMO Monitoring".

**Verify uploaded artifacts** once the setup workflow finishes:

```bash
osmo data list --no-pager <dig_url_root>/
```

## URL artifact layout

URL inputs mount at the requested URL contents rather than under an OSMO dataset name. The setup workflow flattens the NGC version wrapper for generated URL artifacts.

### Per-artifact root layout + key files

| Artifact URL path | Root contents | Notes |
|---|---|---|
| `models/pcb` | `ag_config.yaml`, `iter_000014000.pt` | Emitted by `download_anomalygen_checkpoints.sh --uc pcb` from `nvidia/Cosmos-AnomalyGen-PCB-2B`. |
| `models/metal_surface` | `ag_config.yaml`, `iter_000010000.pt` | Emitted by `download_anomalygen_checkpoints.sh --uc metal` from `nvidia/Cosmos-AnomalyGen-Metal-2B`. (Script arg stays `--uc metal` — its HF repo identifier; OSMO storage path uses canonical `metal_surface`.) |
| `models/glass` | `ag_config.yaml`, `iter_000009000.pt` | Emitted by `download_anomalygen_checkpoints.sh --uc glass` from `nvidia/Cosmos-AnomalyGen-Glass-2B`. |
| `datasets/pcb/raw` | `PCB/`, `defect_spec.jsonl`, `semantic_segmentation_labels.json` | Emitted by `prepare_dataset_uc1.py` from `nvidia/Cosmos-AnomalyGen-PCB-Dataset`; finetune/inference generates validation.jsonl + amp/ on the fly. |
| `datasets/metal_surface/raw` | `metal_surface/{anomaly_image,mask,clean_image}/`, `defect_spec.jsonl` | UC2 prep-script output (downloaded from public GitHub by `prepare_dataset_uc2.py` at setup time); curated 5+5+20 subset matching the reference UC2 dataset. |
| `datasets/glass/raw` | `Phone/{anomaly_image,clean_image,mask}/`, `defect_spec.jsonl` | Images from user's Roboflow zip; masks + defect_spec from `nvidia/Cosmos-AnomalyGen-Glass-Masks` (HF) overlaid by `prepare_dataset_uc3.py --masks-from-hf`. Material dir is **`Phone`**, not `glass` / `Glass`. |
| `datasets/pcb/assets` | `spark_lighting.usd`, `pcba_main_s_detail.usd`, `pcba_base.usd`, `aoi_ring_light.usda`, `materials/`, `component/`, `ECAD_3D/`, `PCBA/` | Pulled from `nvidia/Spark-AnomalyGen-USD` (HF dataset repo) via `hf download --repo-type dataset`. |
| `models/pretrained` | `pretrained/` | Sub-trees per provider (NVDINOV2, nvidia, google-t5, facebook, ...). |

### Per-use-case parameter values

Pull these from the actual checkpoint filenames + material subdirs above. Day 0 and Day 1 defaults already target the shipped PCBA checkpoint (step 14000); the `anomaly_types_json` knob on both flows defaults to the PCBA taxonomy.

| Use case | `checkpoint_step` | `anomaly_types_json` (checkpoint-keyed) | Material subdirs under `datasets/<case>/raw` |
|---|---|---|---|
| PCBA | `14000` | `[["IC","bridge"],["passive_component","excess_solder"],["passive_component","missing"]]` | `IC/`, `passive_component/` |
| Metal surface | `10000` | `[["metal_surface","MT_Blowhole"],["metal_surface","MT_Break"],["metal_surface","MT_Crack"],["metal_surface","MT_Fray"],["metal_surface","MT_Uneven"]]` | `metal_surface/` |
| Glass | `9000` | `[["Phone","oil"],["Phone","scratch"],["Phone","stain"]]` | `Phone/` |

> **Glass material name `Phone`** is intentional — the source dataset was authored against a phone-screen taxonomy. PCBA spans two materials (IC + passive_component) under one shipped checkpoint. Verify against the checkpoint's `ag_config.yaml` `anomaly_types` field before submitting.

### `pcba_target.yaml` is mounted from the cookbook

The PCBA assets bundle ships only the USD tree (15+ `.usd`/`.usda` files + materials). Day 0's `usd2roi-render` mounts `assets/cookbooks/pcb/pcba_target.yaml`, `day0_image.yaml` (with mesh-level semantics inlined), and `day0_crop.yaml` into the task via `files: - localpath:` at submit time, so the dataset doesn't need to ship them. No side-load required.

## Bring your own data or models

Use the same URL layout for custom DIG artifacts. This keeps the setup workflow, manual uploads, and future external S3 paths using the same contract under one DIG root.

```bash
DIG_ROOT=s3://osmo-workflows/dig
CASE=<case-name>

# Custom checkpoint model. The root should contain ag_config.yaml and the
# iter_*.pt file that matches the checkpoint_step you pass to the workflow.
osmo data upload "${DIG_ROOT}/models/${CASE}/" \
  /path/to/checkpoint_dir/*

# Raw training/inference data. The root should contain the material
# directory and defect_spec.jsonl. validation.jsonl + amp/ are NOT required —
# the finetune/inference tasks build them inline via prep_testcase.sh.
osmo data upload "${DIG_ROOT}/datasets/${CASE}/raw/" \
  /path/to/raw_data_dir/*

# Optional CAD/USD assets for PCBA-like usd2roi flows.
osmo data upload "${DIG_ROOT}/datasets/${CASE}/assets/" \
  /path/to/usd_asset_tree/*
```

`osmo data upload` nests each supplied local path's basename. Use `/*` when the contents of a local directory should become the URL root, and use the directory path itself only when you intentionally want an extra top-level folder.

After upload, verify both access and shape:

```bash
osmo data check --access-type READ "${DIG_ROOT}/models/${CASE}/"
osmo data list --no-pager "${DIG_ROOT}/models/${CASE}/"
osmo data list --no-pager "${DIG_ROOT}/datasets/${CASE}/raw/"
```

Keep the material names aligned with `anomaly_types_json` and the checkpoint's `ag_config.yaml`. A minimal raw tree has `<MATERIAL>/clean_image/`, `<MATERIAL>/mask/<defect>/`, and `defect_spec.jsonl`. CAD-guided cases also need `cad_mask/` and `semantic_segmentation_labels.json` where the cookbook expects them.

### Naming gotcha: `--set` parses numeric-looking values as PEP 515 ints

`osmo workflow submit --set <key>=<value>` casts values to int or float when they look numeric — including Python PEP 515 underscore-grouped integers. A value like `115_2819_000` becomes the int `1152819000` (underscores stripped) before Jinja renders it, so `{{ board }}` resolves to `1152819000` even though you passed `115_2819_000`. If the cookbook directory is `assets/cookbooks/pcb/115_2819_000/` the workflow's `localpath: ../cookbooks/pcb/{{ board }}/usd2roi_nvpcb.yaml` mount fails with "file not found" on `1152819000`.

**Safe board / case directory names:**
- Pure digits (`1152819000`) — round-trips through int correctly.
- Names starting with a letter (`H100`, `board_a`, `b001`) — never int-cast.
- Hyphen-separated (`115-2819-000`) — never int-cast.

**Avoid:** underscore-grouped digit sequences (`115_2819_000`, `1_000_000`).

The shipped PCBA alternate board cookbook directory is `assets/cookbooks/pcb/1152819000/` (pure digits) for exactly this reason. The matching real photo `input_real_image/115_2819_000.jpg` inside `datasets/pcb/assets` keeps its original underscore-grouped name (it's a file inside an artifact, not a Jinja-templated path component) — pass it via `--set real_image_filename=input_real_image/115_2819_000.jpg` explicitly when targeting that board. Use `--set-string` instead of `--set` only as a last resort — it disables numeric casting for all `--set-string` values, which usually you don't want.

## Wiring into Day 0 / Day 1 / finetune

Day 0, Day 1, and finetune all consume URL artifacts directly. The only storage knob is `dig_url_root`; the workflow derives inputs from the fixed layout:

- checkpoints: `<dig_url_root>/models/<usecase>`
- pretrained: `<dig_url_root>/models/pretrained`
- raw training data: `<dig_url_root>/datasets/<usecase>/raw`
- PCBA CAD assets: `<dig_url_root>/datasets/pcb/assets`
- Day 1 real-photo alignment inputs: ships inside `<dig_url_root>/datasets/pcb/assets` (canonical `pcb-assets`: per-board photos under `input_real_image/<board>.jpg`)
- run outputs: `<dig_url_root>/runs/<name>/<stage>`

Use `usecase=pcb`, `usecase=metal_surface`, or `usecase=glass` in workflow submits — uniform across `--set usecase=`, URL paths (`datasets/<usecase>/raw`, `models/<usecase>`), and cookbook directories (`assets/cookbooks/<usecase>/`). The `metal_surface` value matches the trained model's material name baked into the checkpoint taxonomy.

### Day 0 (PCBA, full pipeline)

Defaults already target the shipped PCBA checkpoint passthrough; the default DIG root is `s3://osmo-workflows/dig`. Use an existing endpoint or deploy the local cluster endpoint from `references/nim/`:

```bash
STAMP=$(cat /proc/sys/kernel/random/uuid | cut -c1-8)
osmo workflow submit skills/physical-ai-defect-image-generation/assets/configs/texture_defect_generation_day0.yaml \
  --pool <pool> --set name=texture_defect_gen_day0-$STAMP \
        dig_url_root=<dig_url_root> \
        image_edit_endpoint=http://qwen-image-edit-nvpcb-ovsl2sl.osmo-nims.svc.cluster.local:8000/v1 \
        image_edit_model=nvidia/Qwen-Image-Edit-NVPCB-OVSL2SL
```

To finetune from scratch instead of passthrough, just add `use_pretrained_checkpoint=false` — the cookbook is rendered in-pod by `yq` after Phase 1 Step 2 (no pre-submit render needed). Defaults are 1 GPU end-to-end; bump `train_gpu=N infer_gpu=N` to scale (set them individually to break symmetry).

### Day 1 (Metal surface or Glass)

Replace `<usecase>` with `metal_surface` or `glass`. Per-use-case overrides:

| Use case | `checkpoint_step` | `anomaly_types_json` |
|---|---|---|
| Metal surface | `10000` | `[["metal_surface","MT_Blowhole"],["metal_surface","MT_Break"],["metal_surface","MT_Crack"],["metal_surface","MT_Fray"],["metal_surface","MT_Uneven"]]` |
| Glass | `9000` | `[["Phone","oil"],["Phone","scratch"],["Phone","stain"]]` |

```bash
STAMP=$(cat /proc/sys/kernel/random/uuid | cut -c1-8)
osmo workflow submit skills/physical-ai-defect-image-generation/assets/configs/texture_defect_generation_day1_manual_roi.yaml \
  --pool <pool> --set name=texture_defect_gen_day1_manual_roi-$STAMP \
        dig_url_root=<dig_url_root> \
        usecase=<usecase> \
        use_pretrained_checkpoint=true \
        checkpoint_step=<see table above> \
        'anomaly_types_json=<list>'
```

> The raw URL contains clean_image, submasks, cad_mask, `defect_spec.jsonl`, and `semantic_segmentation_labels.json` together. When it ships its own `defect_spec.jsonl` (Mode A), `anomaly_types_json` is unused. For finetune-from-scratch on Day 1, add `use_pretrained_checkpoint=false` — the finetune task builds the validation set fresh via `prep_testcase.sh` inside the pod.

### Finetune flow (from scratch — Finetune Only)

Use `<dig_url_root>/datasets/<usecase>/raw` as the training source. The checkpoint output (`<dig_url_root>/runs/<name>/finetune`) is reusable as a checkpoint URL in Day 0 / Day 1 by pointing their input at that run output or by copying it into `<dig_url_root>/models/<usecase>`.

```bash
# Cookbook is rendered in-pod (5 yq patches + trainer.early_stop drop) — see
# references/flows/finetune.md §"Cookbook render (in-pod, automatic)".
STAMP=$(cat /proc/sys/kernel/random/uuid | cut -c1-8)
osmo workflow submit skills/physical-ai-defect-image-generation/assets/configs/finetune.yaml \
  --pool <pool> --set name=finetune-$STAMP \
        dig_url_root=<dig_url_root> \
        usecase=<usecase>
```

Training-recipe knobs (`lr`, `max_iter`, `anomaly_types`, etc.) live in the cookbook (`assets/cookbooks/<usecase>/ag_config.yaml`), not the `--set` list. To override, add more yq expressions at render time.

## Troubleshooting

- **`preflight_credentials.sh` exits 1** — read the printed remediation. Common cases: the `hf-token` credential is missing **and** `HF_TOKEN` isn't exported (export it and re-run, or provision the credential directly); HF probe `401`/`403` (token lacks read scope on the gated `nvidia/Cosmos-AnomalyGen-*` or `nvidia/Cosmos-Predict2-*` repos — accept the license at each repo page and regenerate the token if needed); OSMO `set` fails (check `osmo profile list` and that the `osmo` CLI is logged in). Use `--no-probe` only if outbound HTTPS is blocked, not to mask a 401. **No env var is required when `hf-token` is already provisioned** — the script skips the probe and exits 0. There is no registry-credential check (images are public).
- **URL output rejected** — use plain `outputs: - url: s3://...`; `dataset.url` is not accepted by the current OSMO schema.
- **Validator: `<field> is not a valid credential key please choose from dict_keys([...])`** — the workflow yaml references a credential field that doesn't exist on the stored credential. OSMO credentials store fields under the exact keys passed in `--payload`. For the `hf-token` GENERIC credential the field is `token` — re-set as `osmo credential set hf-token --type GENERIC --payload token="$HF_TOKEN"` if the field is missing. (If you added an `nvcr_io` REGISTRY credential to work around image-pull failures, its canonical field is `auth` — see `references/troubleshooting.md` → "nvcr.io image pull failures".)
- **HF gated probe returns `401`/`403`** — the HF token cannot read one of the gated `nvidia/Cosmos-AnomalyGen-*` or `nvidia/Cosmos-Predict2-*` repos. Visit each repo page in a browser, click "Agree and access repository," then regenerate the token if it predates the license acceptance.
- **Workflow says COMPLETED but outputs are hard to find** — query the DIG root with `osmo data list --no-pager s3://osmo-workflows/dig/`.
- **`ERROR: 0 files in <out>`** — the HF token lacks read access to the target repo, the license hasn't been accepted, or the repo name is wrong. Confirm with the curl probe in Prerequisites §1, then re-run.
- **Metal UC2 data download fails** — re-submit `setup/setup_metal.yaml`. The upstream GitHub slug must include the trailing period: `abin24/Magnetic-tile-defect-datasets.`; a slug without the final `.` resolves to a different (non-existent) repository and `prepare_dataset_uc2` will fail.
- **`hf: command not found` / `huggingface-cli not found`** — the task is not running inside `pretrained_image`. Confirm `image:` in the failing group points at the canonical `paidf-anomalygen` tag from `references/container-images.md`.
- **Storage exhaustion** — bump `storage` (per-UC + assets tasks) or `storage_large` (pretrained). 10 GiB fits each per-UC download with headroom; the pretrained 220 GiB fits a 71 GB `model_sizes=2B` run, raise to ≥300 GiB for `2B 14B`.
- **One workflow fails, the rest succeed** — re-submit just the failing workflow file (`setup_pcb.yaml` / `setup_metal.yaml` / `setup_glass.yaml` / `setup_pretrained.yaml`); the successful URL artifacts persist under `dig_url_root`.
