# Defect Image Generation Workflow — Troubleshooting


## Table of Contents

- [When to Consult Component Skills](#when-to-consult-component-skills)
- [URL Layout](#url-layout)
- [Preflight](#preflight)
- [Shipped Taxonomies](#shipped-taxonomies)
- [Canonical Submit Commands](#canonical-submit-commands)
- [Output Retrieval](#output-retrieval)
- [Common Failures](#common-failures)
- [IsaacSim Render (structural_defect_generation.yaml)](#isaacsim-render-structural_defect_generationyaml)
- [usd2roi-render (good_image_generation.yaml / texture_defect_generation_day0.yaml)](#usd2roi-render-good_image_generationyaml-texture_defect_generation_day0yaml)
- [nvcr.io image pull failures](#nvcrio-image-pull-failures)

Operational gotchas, failure-mode recipes, and canonical submit commands for the
URL-based Defect Image Generation workflows. For canonical image tags, see
`references/container-images.md`.

## When to Consult Component Skills

| Symptom / question | Owning skill | Look for |
|---|---|---|
| Kit, `sdg_pipeline.py`, `usd2roi_crop.py`, missing semantic classes, `pcba_target.yaml`, scan-grid tuning, USD scene selection | `skills/simulation/SKILL.md` (usd2roi component skill) | Day-0 SDG config, semantic rules, writer flags, per-cell ROI crop logic |
| Image-edit prompt, endpoint calls, letterbox, guidance scale, batch config expansion, endpoint timeouts | `skills/augmentation/SKILL.md` | Remote endpoint executor and augmentation cookbook schema |
| AMP routing (`free` / `text` / `cad`), `defect_spec.jsonl`, `prep_testcase.sh`, checkpoint validation, `run_sdg.sh`, training output layout, best-step selection | `skills/anomalygen/SKILL.md` | Phases 0-7, data structure, defect spec, training and inference mechanics |
| OSMO pool/quota, workflow submit/query/logs/events/cancel, URL storage, `osmo data upload/download/list`, credentials, image pull errors, pod-template mount issues | `skills/physical-ai-infrastructure-setup-and-resilient-scaling/SKILL.md` | CLI reference, workflow YAML v2, credential payloads, URL output conventions |

**Decision shortcut by task name:** `usd2roi-render` -> usd2roi component skill
(`skills/simulation/SKILL.md`), `augment-image-edit` ->
augmentation, `finetune` or `anomaly-infer` -> anomalygen.
Workflow YAML, Jinja, storage URL, pool, credential, and image pull issues stay
with this skill plus `physical-ai-infrastructure-setup-and-resilient-scaling`.

## URL Layout

Default root:

```bash
DIG_ROOT=s3://osmo-workflows/dig
```

| Use | URL |
|---|---|
| PCBA checkpoint | `${DIG_ROOT}/models/pcb` |
| Metal checkpoint | `${DIG_ROOT}/models/metal_surface` |
| Glass checkpoint | `${DIG_ROOT}/models/glass` |
| Pretrained weights | `${DIG_ROOT}/models/pretrained` |
| Raw training data | `${DIG_ROOT}/datasets/<usecase>/raw` |
| PCBA CAD assets | `${DIG_ROOT}/datasets/pcb/assets` |
| Day 1 real-photo alignment | `${DIG_ROOT}/datasets/pcb/assets/input_real_image/<board>.jpg` (ships inside canonical `pcb-assets`; e.g. `0603_H100.jpg`, `115_2819_000.jpg`) |
| Run output | `${DIG_ROOT}/runs/<name>/<stage>` |

Built-in workflow `usecase` values are `pcb`, `metal_surface`, and `glass`. The metal
`usecase` is uniformly `metal_surface` — the cookbook lives at `assets/cookbooks/metal_surface/`, URL paths use `datasets/metal_surface/raw` + `models/metal_surface`, and the trained taxonomy's material name matches (`anomaly_types_json=[["metal_surface","MT_*"],...]`).

## Preflight

```bash
bash scripts/preflight_credentials.sh
DIG_URL_ROOT=s3://osmo-workflows/dig bash scripts/preflight_urls.sh 0 pcb
DIG_URL_ROOT=s3://osmo-workflows/dig bash scripts/preflight_urls.sh 1 metal_surface
DIG_URL_ROOT=s3://osmo-workflows/dig bash scripts/preflight_urls.sh 1 glass
DIG_URL_ROOT=s3://osmo-workflows/dig bash scripts/preflight_urls.sh finetune pcb
```

For finetune-from-scratch checks:

```bash
USE_PRETRAINED_CHECKPOINT=false DIG_URL_ROOT=s3://osmo-workflows/dig \
  bash scripts/preflight_urls.sh 1 metal_surface
```

For Day 1 PCBA real-photo alignment:

```bash
DIG_URL_ROOT=s3://osmo-workflows/dig bash scripts/preflight_urls.sh 1 pcb real-alignment
```

## Shipped Taxonomies

| Usecase | `checkpoint_step` | `anomaly_types_json` |
|---|---|---|
| `pcb` | `14000` | `[["IC","bridge"],["passive_component","excess_solder"],["passive_component","missing"]]` |
| `metal` | `10000` | `[["metal_surface","MT_Blowhole"],["metal_surface","MT_Break"],["metal_surface","MT_Crack"],["metal_surface","MT_Fray"],["metal_surface","MT_Uneven"]]` |
| `glass` | `9000` | `[["Phone","oil"],["Phone","scratch"],["Phone","stain"]]` |

`anomaly_types_json` must match the checkpoint's `ag_config.yaml`
`anomaly_types` list exactly. PCBA spans two materials; do not collapse it into a
single material.

## Canonical Submit Commands

Day 0 PCBA passthrough:

```bash
osmo workflow submit skills/physical-ai-defect-image-generation/assets/configs/texture_defect_generation_day0.yaml \
  --pool default \
  --set name=pcb-e2e-$(date +%Y%m%d-%H%M) \
        dig_url_root=<dig_url_root> \
        image_edit_endpoint=http://qwen-image-edit-nvpcb-ovsl2sl.osmo-nims.svc.cluster.local:8000/v1 \
        image_edit_model=nvidia/Qwen-Image-Edit-NVPCB-OVSL2SL
```

Day 1 metal_surface passthrough:

```bash
osmo workflow submit skills/physical-ai-defect-image-generation/assets/configs/texture_defect_generation_day1_manual_roi.yaml \
  --pool default \
  --set name=metal_surface-demo-$(date +%Y%m%d-%H%M) \
        dig_url_root=<dig_url_root> \
        usecase=metal_surface \
        checkpoint_step=10000 \
        'anomaly_types_json=[["metal_surface","MT_Blowhole"],["metal_surface","MT_Break"],["metal_surface","MT_Crack"],["metal_surface","MT_Fray"],["metal_surface","MT_Uneven"]]'
```

Day 1 glass passthrough:

```bash
osmo workflow submit skills/physical-ai-defect-image-generation/assets/configs/texture_defect_generation_day1_manual_roi.yaml \
  --pool default \
  --set name=glass-demo-$(date +%Y%m%d-%H%M) \
        dig_url_root=<dig_url_root> \
        usecase=glass \
        checkpoint_step=9000 \
        'anomaly_types_json=[["Phone","oil"],["Phone","scratch"],["Phone","stain"]]'
```

Smoke-test knobs: add `render_patches=5 num_sdg=15` for Day 0, or
`num_sdg=15` for Day 1.

## Common Failures

- **`ERROR: /usr/share/nvidia/nvoptix.bin not mounted`** (OV tasks: `usd2roi-render`, `usd2roi-render-day1`, `sdg-and-crop`) — the OSMO pod template is missing the OptiX denoiser binary hostPath mount. Without it, Kit silently falls back to raw path tracing → noisy ROI output. Invoke the `physical-ai-infrastructure-setup-and-resilient-scaling` skill to patch the pod template (`osmo config update POD_TEMPLATE`) and re-submit.
- **`ERROR: /dev/shm is NN GiB; need >= 16 GiB`** (OV + training tasks) — the OSMO pod template's `emptyDir` for `/dev/shm` is undersized. Same fix: patch via `physical-ai-infrastructure-setup-and-resilient-scaling`. 32 GiB is the recommended size for ray-tracer buffers (OV) and torchrun shared-memory (training).
- **URL output rejected** — use `outputs: - url: s3://...`; `dataset.url` is not accepted by the current OSMO schema.
- **Missing URL artifacts** — submit the relevant `setup/setup_<case>.yaml` + `setup/setup_pretrained.yaml`, or upload data with `osmo data upload` under the same DIG root.
- **Checkpoint taxonomy mismatch** — trim `anomaly_types_json` to the shipped table or retrain via `finetune.yaml`.
- **`ag_config.yaml not found in checkpoint`** — checkpoint URL does not contain the expected training config alongside weights.
- **`ERROR: pretrained tree not at .../pretrained`** — rerun setup for `models/pretrained`.
- **`ERROR: $DATASET_DIR/defect_spec.jsonl missing in raw dataset`** — the raw data URL is incomplete; rerun setup for the usecase.
- **`ERROR: prep_testcase.sh produced an empty validation.jsonl`** (finetune-from-scratch) — the raw dataset has no training masks under `<MATERIAL>/mask/<defect>/`.
- **Submask lookup failed** — raw data must have `<material>/mask/<defect>/` for every pair in `anomaly_types_json`, with a flat `<defect>/` fallback only for custom flat uploads.
- **Day 1 real-alignment no real photo** — confirm the canonical `pcb-assets` artifact is uploaded under `<dig_url_root>/datasets/pcb/assets/`; the per-board photo at `input_real_image/<board>.jpg` must exist (default board is `0603_H100`).
- **Day 1 real-alignment registration low MI** — retune the per-board cookbook at `assets/cookbooks/pcb/<board>/usd2roi_nvpcb.yaml` (camera or registration ranges); `assets/cookbooks/pcb/usd2roi_day1.yaml` is only the fallback when no per-board cookbook is selected.
- **Image-edit endpoint failures** — verify `image_edit_endpoint` from inside the cluster and inspect `references/nim/README.md`.
- **Jinja comment-token collision** — avoid bash `${#ARRAY[@]}` in workflow inline scripts; Jinja treats `{#` as a comment start.
- **Group/task name collisions** — OSMO requires group names and task names to be globally unique.
- **dshm OOM** — confirm the active OSMO pod template has sufficient `/dev/shm`.
- **multi-GPU FT cgroup OOM** — finetune-from-scratch or multi-GPU inference dies with `OOMKilled` / `Memory cgroup out of memory` shortly after torchrun spawns ranks. Each cosmos-predict2-2B rank loads the full 2B + T5 + NVDINOV2 + SAM2 + Qwen3-VL stack into host RAM (~33 GiB steady-state during DDP sync), so a hardcoded `train_memory: 64Gi` only fits 1 rank. The workflow YAMLs scale memory + CPU with `train_gpu` / `infer_gpu` via `{{ [64, gpu|int * 48]|max }}Gi` — confirm your submit isn't overriding `train_memory` / `infer_memory` back to a fixed value. Pass `--set train_gpu=N infer_gpu=N` together to scale both, or set them individually for asymmetric sizing.
- **Workflow never progresses / no task logs appear** — if the active pod template mounts `/usr/share/nvidia/nvoptix.bin` but no cluster node actually has that host file, pods can stay stuck in a bad pending state instead of failing clearly. Use `skills/physical-ai-infrastructure-setup-and-resilient-scaling/SKILL.md` to inspect `osmo workflow events <workflow_id>` and determine whether the workflow is blocked on the `nvoptix.bin` hostPath or another scheduling/mount event.

## IsaacSim Render (structural_defect_generation.yaml)

The structural-defect IsaacSim workflow invokes `sdg_pipeline.py` +
`crop_components.py` inside the canonical `paidf-simulation` image (tag pinned
in `references/container-images.md`). Issues lifted from the upstream
`generate` skill plus OSMO-specific additions:

- **`Config boundary violation: keys [...] appear in both --config and --pcba-config`** — `sdg_pipeline.py` enforces a strict split: USD/scene-bound fields live in `pcba_target.yaml`; pipeline/render/lighting/defect fields live in the render cookbook (`defect_image.yaml`). If the user edits a cookbook and copies a field across the line, this fails fast. Move each listed key to exactly one file.
- **`Unknown component_types keyword: 'X'`** — pcba_target.yaml's `component_types` must be `ALL`, `0`, an inline list, or a key in `configs/components.yaml` `subsets:`. The per-board cookbook copies under `assets/cookbooks/pcb/<board>/` ship explicit lists.
- **Pipeline runs but `trigger_0000/` is empty** — output landed elsewhere. Both workflows sed-patch `output:` to the OSMO task output dir; check `<output>/render_config.yaml` snapshot to verify the patched value, then look for `[Pipeline] Output: <path>` in the render log.
- **Only `rgb_0000..rgb_0003.png`, last frame is `rgb_0004.png` and 0 bytes** — semantic-segmentation segfault workaround interaction; the writer reports N frames but the last gets truncated on close. Pad `render_patches` by 1 (`--set render_patches=6` to get 5 usable frames) or set `writer.semantic_segmentation: false` in the render cookbook.
- **`"Loaded pcba target"` prints but `component_types` is still a literal string** — keyword resolver did not run. Check `pcba_target.yaml` snapshot at `<output>/pcba_target.yaml`; ensure `configs/components.yaml` is reachable inside the container at `/workspace/paidf-simulation/configs/components.yaml`.
- **Asset references break — `spark_lighting.usd not found`** — the scene USD (e.g. `spark_lighting.usd`) references peer USDs by relative path. The full USD tree must be present under `<dig_url_root>/datasets/pcb/assets`; uploading just the top-level scene file leaves the references dangling. Re-publish via `setup/setup_pcb.yaml` (which ships the full asset bundle).
- **`crop_components.py: no trigger_NNNN found`** — the render step succeeded too quietly (`good_image/` exists but has no `trigger_*` dirs). Re-inspect the render-task log around the Kit `--exec` line; the failure is usually upstream of the crop task. Confirm `nvoptix.bin` is mounted via `osmo workflow events <id>`.
- **`Permission denied` writing to `/osmo/data/output/...`** — OSMO sets the right ownership on `/osmo/data/output` at task start; this is rare. Do NOT add a `chmod 777 $OUT` in the workflow — that path can't be chmod-ed by the task (OSMO-managed mount). If perms are genuinely wrong, the issue is in the pod template or the OSMO event log, not something the workflow YAML can patch.
- **`Unknown defect_modes: [...]`** (structural-defect only) — the patcher whitelists `shift`, `tombstone`, `sideflip`. Any other value fails fast. If extending the cookbook with a new mode, update the patcher's `ALL_MODES` set in `structural_defect_generation.yaml`.
- **Editing `max_image_count:` in the cookbook YAML doesn't change the frame cap** — the workflow sed-patches `max_image_count:` in the cookbook from the `MAX_IMAGE_COUNT` env var (derived from the `render_patches` workflow knob) at task start. To change the cap, pass `--set render_patches=N` at submit time. The cookbook value is purely a default that gets overwritten.
- **`MAX_IMAGE_COUNT=1` produces 0 crops and fails** (structural-defect only) — the scan_grid is 100 cells; `MAX_IMAGE_COUNT=1` picks a single cell at random. If that cell happens to view empty board area for the active `defect_modes`, `crop_components.py` emits 0 outputs and the task exits non-zero (`No Files in Output Folder` from the OSMO upload step). The render itself succeeded — only the crop step's empty-output guard tripped. Use `MAX_IMAGE_COUNT >= 2` (recommended `>= 3`) so at least one frame lands on a populated region.

## usd2roi-render (good_image_generation.yaml / texture_defect_generation_day0.yaml)

Both workflows invoke the same `usd2roi-render` task: Kit + `sdg_pipeline.py`
(scan_grid render with mesh-level semantics) followed by `usd2roi_crop.py`
(semantic-mask-driven multi-cell ROI extraction). Issues:

- **`usd2roi_crop.py: 0 ROI pairs emitted`** — the render produced trigger frames but the crop step found no semantic regions matching the cookbook's `crop.classes` whitelist. Confirm the `semantics:` block in `day0_image.yaml` matches mesh paths in your USD, and the `crop.classes` entries match those semantic class names.

## nvcr.io image pull failures

The `paidf-*` workflow images are public on `nvcr.io/nvidia/` and pull
anonymously, so no registry credential is configured by default. If a task fails
to pull its image — e.g. an authorization error or `nvcr.io` rate-limiting on a
busy cluster — add an NGC registry pull credential and reference it on the
affected task(s):

1. Create an OSMO REGISTRY credential from your NGC API key:
   ```bash
   osmo credential set nvcr_io --type REGISTRY \
     --payload registry=nvcr.io username='$oauthtoken' auth="$NGC_API_KEY"
   ```
2. Add the credential to the `credentials:` block of each task that hit the pull
   error (keep the existing `hf-token` entry where present):
   ```yaml
             credentials:
               nvcr_io:
                 NGC_CLI_API_KEY: auth   # authorizes the image pull
               hf-token:
                 HF_TOKEN: token
   ```
3. Re-submit. If `osmo workflow validate`/`submit` reports `<field> is not a
   valid credential key`, the REGISTRY credential's field is `auth` — re-set it
   with the command in step 1.
