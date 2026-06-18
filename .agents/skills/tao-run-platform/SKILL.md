---
name: tao-run-platform
description: TAO Execution SDK for submitting and monitoring GPU training jobs on supported platforms (Lepton, Brev, SLURM,
  local Docker, Kubernetes). Use when the user wants to run TAO jobs through the SDK, get job tracking, S3 I/O wrapping,
  multi-node distributed training, or platform-specific features that docker-run can't provide. Trigger phrases include
  "use the TAO SDK", "call tao_sdk", "AutoMLRunner", "ActionWorkflow", "Job handles", "S3 I/O wrapping", "TAO platform run".
license: Apache-2.0
compatibility: Requires Python 3.10+ and the nvidia-tao-sdk package (pip install nvidia-tao-sdk[all]).
metadata:
  author: NVIDIA Corporation
  version: "0.2.0"
allowed-tools: Read Bash
tags:
- platform
- tao
- sdk
---

# TAO Execution SDK

The SDK is the **optional** Python layer for users who need job handles, S3 I/O wrapping, or platform-specific features (Lepton multi-node, SLURM/Lustre queues, Kubernetes Jobs, local Docker debugging, Brev instance reuse). Most TAO skills run with just `docker run` and don't need it. Reach for the SDK when:

- You want a `Job` handle to poll status and stream logs over time.
- The platform is API-only (Lepton has no docker-run equivalent).
- You need S3-aware input download / output upload baked into the entrypoint.
- You're chaining multiple jobs and want persisted state.

## Preflight

Install `nvidia-tao-sdk[all]` before using this platform — the `[all]` extra pulls in every platform-specific dependency (Lepton, Brev, S3 utilities, etc.):

```bash
python -c "import tao_sdk" 2>/dev/null || {
  echo "MISSING: nvidia-tao-sdk not installed. Run:"
  echo "  pip install nvidia-tao-sdk[all]"
  exit 1
}
```

The package index is environment-specific — the runner/container is expected to have a working `pip` configuration (e.g. `~/.pip/pip.conf`, `PIP_INDEX_URL`, `PIP_EXTRA_INDEX_URL`, or proxy). If the install fails for index/network reasons, that's a runner setup issue; this skill stays agnostic to the registry.

If missing, the agent prompts the user to authorize the install via Bash, then re-runs the preflight. Never auto-install silently.

## Setup

Credentials come from **environment variables** — sourced from `~/.config/tao/.env` (auto-loaded by the skill bank's SessionStart hook).

```python
from tao_sdk.platforms.lepton import LeptonSDK   # DGX Cloud
from tao_sdk.platforms.brev   import BrevSDK     # Brev GPU instances

sdk = LeptonSDK()    # reads LEPTON_WORKSPACE_ID, LEPTON_AUTH_TOKEN
# or
sdk = BrevSDK()      # reads BREV_API_TOKEN (optional — falls back to brev login)
```

Both SDKs validate credentials lazily on first use and raise `CredentialError` with a clear message if a required env var is missing. Required env vars:

| Platform | Required | Optional |
|---|---|---|
| Lepton | `LEPTON_WORKSPACE_ID`, `LEPTON_AUTH_TOKEN` | — |
| Brev | — (manual `brev login` works) | `BREV_API_TOKEN` |
| S3 I/O (any platform) | `S3_BUCKET_NAME`, `ACCESS_KEY`, `SECRET_KEY` | `S3_ENDPOINT_URL`, `CLOUD_REGION` |
| Container env | `NGC_KEY` | `HF_TOKEN` |

The agent never reads credential values — it only checks presence with `[ -n "$VAR_NAME" ]`.

## Workflow Launch Intake

For any TAO workflow or action launch, first confirm the user goal. Then ask
for platform and monitoring preferences before credentials or launch details.
Generate the supported platform choices from the packaged helper, not by
scanning platform docs or folders:

```bash
${TAO_SKILL_BANK_PATH:-~/tao-skills-external}/scripts/list_tao_platforms.py \
  --skill-bank ${TAO_SKILL_BANK_PATH:-~/tao-skills-external} --format text
```

Ask:

1. Which supported platform should run this workflow?
2. Should long-running monitoring stay enabled? Default: enabled. This means
   the agent remains attached and posts status until terminal state, including
   long `PENDING` queue waits.
3. How many minutes between status updates? Default: 5 minutes.

After the model/action are known, resolve the default container image from the
packaged metadata and ask the user to confirm it or provide `image=<override>`
before creating runner files:

```bash
${TAO_SKILL_BANK_PATH:-~/tao-skills-external}/scripts/resolve_tao_image.py \
  --skill-bank ${TAO_SKILL_BANK_PATH:-~/tao-skills-external} \
  --model <network_arch> --action <action> --format text
```

For train-capable model workflows, inspect model-level AutoML metadata before
creating a plain training job:

```bash
${TAO_SKILL_BANK_PATH:-~/tao-skills-external}/scripts/list_tao_models.py \
  --skill-bank ${TAO_SKILL_BANK_PATH:-~/tao-skills-external} \
  --scope automl --format json
```

If the selected model has `automl_enabled: true` and a valid train schema,
route training through `skills/applications/tao-run-automl` by default. A workflow should
only bypass AutoML when its run settings include `automl_policy: off`, the user
explicitly asks for a plain run, or the model metadata says AutoML is enabled
but the train schema is not packaged yet.

After the platform is selected, get the credential filter:

```bash
${TAO_SKILL_BANK_PATH:-~/tao-skills-external}/scripts/list_tao_platforms.py \
  --skill-bank ${TAO_SKILL_BANK_PATH:-~/tao-skills-external} \
  --platform <platform> --format text
```

Ask only for credentials returned for the selected platform. For example, SLURM
needs `SLURM_USER` and `SLURM_HOSTNAME`; it does not need Lepton credentials.
Kubernetes and local Docker do not need Lepton or SLURM credentials. Ask storage
credentials such as S3 keys only when the selected platform and the data/result
URIs require them.

## Core API

All platform SDKs implement the same core shape:

```python
sdk.create_job(image, command, gpu_count=1, env_vars=None, inputs=None, outputs=None, **kwargs) -> Job
sdk.get_job_status(job_id) -> JobStatus
sdk.get_job_logs(job_id, tail=None) -> str
sdk.cancel_job(job_id) -> bool
sdk.get_failure_analysis(job_id) -> dict | None
sdk.get_job_results_dir(job_id) -> str
sdk.check_path(remote_path) -> bool
sdk.list_path(remote_path) -> list[str]
```

Lepton-only:
- `sdk.get_job_replicas(job_id)` — replica-level diagnostics for stuck-pending jobs.

Brev-only:
- `sdk.delete_instance(instance_id)` — clean up an ephemeral instance.
- `sdk.list_instances()` — list active instances.

## Submitting a Job

The agent always **constructs the container command via `build_entrypoint`** before calling `create_job`. The agent reads the action's schema from `skill_info.yaml` (`command`, `config_format`, `inputs`, `outputs`, `upload_excludes`) and passes those fields as kwargs. `build_entrypoint` bakes the in-container `script_runner` runtime (inlined as a base64 heredoc) and the CLI invocation that, at runtime, downloads declared inputs, writes the spec file at `{config_path}` with remote URIs rewritten to local paths, runs the user command, and uploads outputs. The platform SDK's `create_job` runs the resulting command **as-is** — no implicit wrapping.

`build_entrypoint` infers the mode (`config` / `args` / `passthrough`) from what you pass — you never pass `mode` explicitly. See [`references/job-construction.md`](references/job-construction.md) for the full entrypoint contract, the spec/args construction strategy per action `mode`, the mode-inference table, and `resolve_container_image()`. See [`references/outputs.md`](references/outputs.md) for where outputs land (the runtime destination tables and per-platform injection policy) and the critical "spec is nested dicts, not flat dotted keys" rule. See [`references/examples.md`](references/examples.md) for complete spec-driven and path-keyed `build_entrypoint` + `create_job` examples.

## Monitoring

```python
status = sdk.get_job_status(job.id)
print(status.status)   # Pending, Running, Complete, Error, Canceled
print(status.message)  # platform-specific detail

logs = sdk.get_job_logs(job.id, tail=200)
print(logs)
```

For stuck-Pending Lepton jobs, replica diagnostics reveal the cause (image pull, scheduling, mount errors):

```python
for r in sdk.get_job_replicas(job.id):
    issue = r["status"].get("readiness_issue")
    if issue:
        print(issue["reason"], issue["message"])
        # e.g. "InProgress" / "Pulling image"  (normal for big images)
        #      "Failed"     / "ImagePullBackOff" (NGC_KEY problem)
        #      "ConfigError" / "Mount point not found" (bad node)
```

On failure, `get_failure_analysis()` classifies the root cause:

```python
analysis = sdk.get_failure_analysis(job.id)
if analysis:
    print(analysis["err_class"])   # ERR_PROGRAM, ERR_INFRA, etc.
    print(analysis["suggestion"])  # human-readable fix
    for event in analysis.get("job_failure_by_node_event", []):
        print(event["node_event_name"], event["message"])  # OOM, GPU error, etc.
```

## Polling pattern

For interactive runs where the user wants to watch:

```python
import time
status_interval_minutes = status_interval_minutes or 5
while True:
    status = sdk.get_job_status(job.id)
    if status.status in ("Complete", "Error", "Canceled"):
        break
    print(f"  {status.status}")
    time.sleep(status_interval_minutes * 60)

if status.status == "Error":
    print(sdk.get_job_logs(job.id, tail=100))
    print(sdk.get_failure_analysis(job.id))
```

With long-running monitoring enabled, do not stop after 30 minutes or after a
few unchanged polls. Keep emitting updates every `status_interval_minutes`
until the job finishes, fails, is canceled, or the user asks to detach/stop.
If the chat/runtime cannot remain open that long, say so explicitly and provide
the durable workflow/log path for manual status refresh.

Do not use a final response for non-terminal monitored jobs. Finalizing the
turn detaches the chat watcher. Keep non-terminal status messages in progress
updates and continue polling; only finalize at terminal state, explicit user
detach/stop, or a real runtime limit that prevents further polling.

For background runs, persist `job.id` and the `state_file` path, then re-attach later by constructing the same SDK and calling `get_job_status(job_id)` — job state is read from the on-disk store.

## Orchestration patterns

Multi-step workflows, parallel sweeps, and run-folder durability via
`ActionWorkflow` live in
[`references/orchestration-patterns.md`](references/orchestration-patterns.md).
Read it before chaining `create_job` calls, sweeping a parameter, or
persisting run state across context breaks.

## Dataset utilities

When the skill's documented filenames don't match the user's layout, list the dataset to confirm:

```python
assert sdk.check_path("s3://my-bucket/coco/")
files = sdk.list_path("s3://my-bucket/coco/train/")
# Use the actual paths to set spec fields.
```

For S3 paths, strip trailing slashes when concatenating to avoid `//`:

```python
base = dataset_uri.rstrip("/")
specs["dataset"]["train_csv"] = f"{base}/train.csv"   # nested — see "spec is nested dicts"
```

## Platform-specific notes

Each backend (Lepton, Brev, SLURM, Kubernetes, local Docker) has its own import
path, storage model, distributed-training options, credential scope, and
`create_job` kwargs. See
[`references/platform-notes.md`](references/platform-notes.md) for the
per-platform details before generating or launching runner artifacts for a
given backend.

## Error patterns

SDK error → root cause → fix mappings are in
[`references/error-patterns.md`](references/error-patterns.md). Read when
you hit a `CredentialError`, image-pull failure, stuck-Pending job, or
similar — the entries map exception text to the underlying cause.

## What the SDK does NOT do

Scope guardrails (no skill-reading, no HPO, no spec opinions, no
auto-platform-selection, no workflow orchestration) live in
[`references/scope.md`](references/scope.md).
