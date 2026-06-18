# Video Data Augmentation — Setup


## Table of Contents

- [What you get](#what-you-get)
- [Prerequisites](#prerequisites)
- [Credential check](#credential-check)
- [Path A — OSMO cache workflow (recommended)](#path-a-osmo-cache-workflow-recommended)
- [Path B — Manual cache publication](#path-b-manual-cache-publication)
- [URL layout](#url-layout)
- [Wiring into VDA flows](#wiring-into-vda-flows)
- [Troubleshooting](#troubleshooting)

One-time bootstrap for VDA execution: credentials, storage prefix, model caches,
and submit prerequisites. Runtime workflows assume this setup exists.

## What you get

| Artifact | Default URL under `storage_url` | Purpose |
|---|---|---|
| Cosmos cache | `data/models/cosmos_transfer` | Cosmos Transfer/Predict/guardrail dependencies for augmentation |
| Auto-labeling cache | `data/models/auto_labeling` | SeedVR2, ReID, and RFDeTR dependencies for auto-labeling |
| Dataset inputs | `datasets/<dataset>` | Source videos (`*.mp4`) used by VDA flows |
| Run outputs | `datasets/<dataset>-outputs/<run_id>/...` | Setup, augmented videos, pseudo-label outputs |

## Prerequisites

1. OSMO CLI installed and authenticated:

   ```bash
   command -v osmo && osmo version
   osmo profile show
   ```

2. OSMO credentials available:
   - `hf_token` (`GENERIC`) for Hugging Face downloads.
   - active `DATA` credential/profile matching target backend.
   - `nvcr_io` (`REGISTRY`) is optional and used when you want to refresh/store
     registry credentials explicitly.

3. Backend-native storage root known (`s3://...`, `azure://...`, `swift://...`,
   etc.). This root becomes `storage_url` in submit commands.

## Credential check

Run before setup and before workflow submission:

```bash
bash scripts/preflight_credentials.sh --workflow assets/configs/osmo/<mode>.yaml
```

Restricted egress:

```bash
bash scripts/preflight_credentials.sh --no-probe --workflow assets/configs/osmo/<mode>.yaml
```

If output contains `USER_INPUT_REQUIRED:`, ask one concise unblock question and
stop. Do not continue with submit-time interpolation until this gate passes.
Pass `--workflow` to validate exact workflow image refs via registry probe.
If rotated secrets are supplied in env, preflight refreshes existing OSMO
credentials automatically. To force overwrite without new env secrets:

```bash
bash scripts/preflight_credentials.sh --workflow assets/configs/osmo/<mode>.yaml --refresh
```

## Path A — OSMO cache workflow (recommended)

Use the built-in cache workflow and publish to backend-native storage:

```bash
osmo workflow submit assets/configs/osmo/setup_model_cache.yaml \
  --set-string storage_url=<backend-prefix> path=data
```

This creates:

- `{{storage_url}}/data/models/cosmos_transfer`
- `{{storage_url}}/data/models/auto_labeling`

Expected runtime is typically tens of minutes depending on outbound bandwidth.

## Path B — Manual cache publication

Use only when Path A is unavailable in the environment. The final object
storage layout must still match:

```text
<storage_url>/data/models/cosmos_transfer
<storage_url>/data/models/auto_labeling
```

If manual publishing deviates from this layout, pass explicit overrides at
submit time (append to the same `--set-string` list):

```bash
cosmos_model_cache_url=<custom-cosmos-cache-url> \
auto_labeling_model_cache_url=<custom-auto-labeling-cache-url>
```

## URL layout

Default root:

```text
storage_url=<backend-prefix>
```

| Use | URL |
|---|---|
| Input dataset root | `<storage_url>/datasets/<dataset>` |
| Setup output | `<storage_url>/datasets/<dataset>-outputs/<run_id>/setup_b0` |
| Original labels | `<storage_url>/datasets/<dataset>-outputs/<run_id>/outputs/pseudo_labeled/<video>` |
| Augmented video | `<storage_url>/datasets/<dataset>-outputs/<run_id>/outputs/augmented/<video>_aug0` |
| Augmented labels | `<storage_url>/datasets/<dataset>-outputs/<run_id>/outputs/pseudo_labeled_augmented/<video>_aug0` |
| Cosmos cache | `<storage_url>/data/models/cosmos_transfer` |
| Auto-labeling cache | `<storage_url>/data/models/auto_labeling` |

Always derive `storage_url` from the actual dataset/upload target for that run.
Do not silently keep stale `s3://` prefixes on non-S3 backends.

## Wiring into VDA flows

Before submit:

```bash
python3 scripts/pre_submit_guard.py --workflow assets/configs/osmo/<mode>.yaml
```

If guard reports cache validation failure, default behavior is to run Path A,
then rerun guard and proceed only after it passes.

Required submit variables across flows:

```text
storage_url, dataset, run_id, gpu_platform, skills_dir, video
```

Optional (defaults supplied by YAML):

```text
cookbook=city_traffic
vlm_url=http://qwen3-vl.osmo-nims.svc.cluster.local:8000/v1
llm_url=http://qwen25-14b.osmo-nims.svc.cluster.local:8000/v1
```

## Troubleshooting

| Symptom | Likely cause | Action |
|---|---|---|
| `USER_INPUT_REQUIRED` from preflight | Missing credentials or unresolved env values | Ask one concise unblock question and rerun preflight |
| `NoCredentialsError` during task startup | `storage_url` scheme/profile mismatch | Re-derive backend-native `storage_url` from actual dataset/upload root |
| Cache missing/empty in guard | Setup cache not published at expected URLs | Run Path A cache workflow and rerun guard |
| 401/403 from Hugging Face in setup-cache | Token/license acceptance issue | Refresh `hf_token` and re-run setup-cache |
| Dataset path resolves but empty | Upload target/path mismatch | Upload videos to `<storage_url>/datasets/<dataset>/` and rerun guard |
