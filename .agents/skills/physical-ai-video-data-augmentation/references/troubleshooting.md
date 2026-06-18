# Video Data Augmentation Workflow — Troubleshooting


## Table of Contents

- [When to Consult Adjacent Skills](#when-to-consult-adjacent-skills)
- [Storage URL layout reference](#storage-url-layout-reference)
- [Preflight](#preflight)
- [Canonical Submit Commands](#canonical-submit-commands)
- [Output Retrieval](#output-retrieval)
- [Common Failures](#common-failures)

Operational failure modes, triage commands, and recovery paths for VDA workflow
execution.

## When to Consult Adjacent Skills

| Symptom / question | Owning skill | Look for |
|---|---|---|
| OSMO pool, storage, submit/query/logs, credential wiring, scheduler errors | `skills/physical-ai-infrastructure-setup-and-resilient-scaling/components/osmo-cli/reference.md` | OSMO control-plane and object-storage operations |
| VLM/LLM NIM deploy/repair and endpoint health | `skills/physical-ai-infrastructure-setup-and-resilient-scaling/components/inference-nim-operator/reference.md` | In-cluster NIM lifecycle and verification |

Workflow-level routing, interpolation, and pre-submit guard failures stay with
this skill.

## Storage URL layout reference

Use the canonical URL map in `references/setup.md` under `## URL layout`.
This troubleshooting reference links to that single source of truth to avoid
drift.

## Preflight

```bash
bash scripts/preflight_credentials.sh --workflow assets/configs/osmo/<flow>.yaml
python3 scripts/pre_submit_guard.py --workflow assets/configs/osmo/auto_labeling.yaml
python3 scripts/pre_submit_guard.py --workflow assets/configs/osmo/augmentation_and_al.yaml
python3 scripts/pre_submit_guard.py --workflow assets/configs/osmo/e2e.yaml
python3 scripts/pre_submit_guard.py --workflow assets/configs/osmo/e2e_super_resolution.yaml
```

If credentials were rotated or the user asks to resend them to OSMO:

```bash
bash scripts/preflight_credentials.sh --workflow assets/configs/osmo/<flow>.yaml --refresh
```

If rotated secrets are already present in env, preflight refreshes existing
credentials automatically even without `--refresh`.

If guard reports cache failure, run:

```bash
osmo workflow submit assets/configs/osmo/setup_model_cache.yaml \
  --set-string storage_url=<backend-prefix> path=data
```

Then rerun guard before submitting the target flow.

## Canonical Submit Commands

All flows share one submit shape; only `assets/configs/osmo/<flow>.yaml` changes.
Use the parameterized command and flow→YAML table in the `SKILL.md` "Submit (all
flows)" section, or the per-flow walkthrough under `references/flows/<flow>.md`.
Submit-time interpolation values are identical across flows. Use one
`--set-string` flag and pass all required pairs in that single list:
`dataset`, `run_id`, `gpu_platform`, `video`, `storage_url`, `skills_dir`,
`cosmos_model_cache_url`, `auto_labeling_model_cache_url` (plus endpoint
overrides when used).

## Output Retrieval

```bash
osmo workflow query <workflow_id> --format-type json
osmo workflow logs <workflow_id> --task <task_name> -n 200
osmo data list --no-pager <output_url>
osmo data download <output_url> <local_dir>/
```

For post-run evidence, mirror the full run output to workspace-local path and
co-locate input video there:

```bash
ROOT="$(git rev-parse --show-toplevel)"
RUN_LOCAL_DIR="$ROOT/media/vda/runs/<run_id>"
mkdir -p "$RUN_LOCAL_DIR/input"
osmo data download "<storage_url>/datasets/<dataset>-outputs/<run_id>/" "$RUN_LOCAL_DIR/"
osmo data download "<storage_url>/datasets/<dataset>/<video>.mp4" "$RUN_LOCAL_DIR/input/"
```

## Common Failures

| Symptom | Likely cause | Action |
|---|---|---|
| `USER_INPUT_REQUIRED` from preflight | Missing credentials/env values | Ask one concise unblock question and rerun preflight |
| Agent claims "`nvapi-*` key type is unsupported for `nvcr.io`" | Prefix-based assumption instead of registry evidence | Re-run `preflight_credentials.sh --workflow <flow-yaml>` and use workflow image probe HTTP results as source of truth; if image refs remain `401/403`, treat as registry reachability/policy issue rather than a key-prefix issue |
| `Jinja substitution failure: '<var>' is undefined` | Missing required submit interpolation key(s) or clobbered flags | Submit once with one `--set-string` payload containing all required pairs (do not repeat or mix `--set`/`--set-string`) |
| `NoCredentialsError` or backend auth errors | Wrong `storage_url` scheme/profile | Derive `storage_url` from the active dataset/upload backend and resubmit |
| Dataset probe shows empty input | Wrong dataset root or missing uploads | Upload `*.mp4` files to `<storage_url>/datasets/<dataset>/`, rerun guard |
| Worker waits on VLM/LLM endpoint | Endpoint unavailable or wrong base URL | Verify NIM health and URL (`.../v1`) before resubmit |
| In-cluster NIMs absent/unhealthy | Missing deploy/repair pass | Run one NIM repair pass with `NIM_SERVICES="qwen3-vl qwen25-14b"` |
| Workflow image pulls fail after key rotation | Existing `nvcr_io`/`hf_token` credential is stale | Rerun preflight with `--workflow <flow-yaml> --refresh` to overwrite OSMO credentials from current secrets |
| `VIDEO_NAME` path separator errors | Invalid filename value | Use basename only (`foo.mp4` -> `foo`) |
| Agent reports video encoding/codec issue | Requested codec path implies royalty-bearing encoder/decoder | Tell the user we only use free packages, do not re-encode input videos with royalty-bearing codecs, and retry with the original input encoding |
| Cosmos worker non-zero after generation | Post-processing edge path | Use current `cosmos_worker.sh` and confirm recovered output artifact exists |
| Input/augmented videos fail to render in chat (`Outside allowed folders`) | MEDIA path is outside workspace | Copy the full run outputs to a workspace-local run folder (`media/vda/runs/<run_id>`), copy/download input video into `<run_local_dir>/input/`, emit MEDIA from that local run folder, then render side-by-side MP4 and summarize manifest + auto-labeling artifacts |
