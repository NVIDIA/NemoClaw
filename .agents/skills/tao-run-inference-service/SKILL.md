---
name: tao-run-inference-service
description: >
  Start, query, and stop a network-specific TAO inference microservice
  ({network_arch}-inference-microservice) by delegating container execution to
  the appropriate platform skill. Handles container image resolution,
  job-payload JSON construction, and the service registry. Use when the user
  wants to run inference on a TAO model checkpoint using a microservice
  container, deploy a TAO inference endpoint, or stop a running inference
  container.
license: Apache-2.0
compatibility: The inference service has no cloud-storage dependency — model weights come from the HuggingFace Hub (HF_TOKEN env var for gated models) or a local container path. Platform prerequisites are checked by each platform skill.
metadata:
  author: NVIDIA Corporation
  version: "0.3.0"
allowed-tools: Read Bash Write
tags:
- inference
- microservice
- workflow
---

# TAO Inference Microservice

## Instructions

**To start an inference service:**
1. Collect required inputs (Section 1) and resolve the container image (Section 2).
2. Build the job payload and inner command (Sections 3–4.1); use `references/code-templates.yaml` → `job_payload_builder`.
3. Read `skills/platform/<platform>/SKILL.md` and start the container (Section 4.2).
4. Write the service registry and poll readiness (Section 4.3); use `references/code-templates.yaml` → `registry_write.<platform>` and `readiness_check`.

**To send an inference request:**
1. Resolve which service receives the request per Section 6.0 (by `job_id`, by `network_arch`, or by explicit user choice when multiple services run — **never silently default to `"latest"` when more than one service exists**), then read the endpoint from `references/code-templates.yaml` → `request.registry_read` with the resolved `job_id`.
2. **Before building the request body, prompt the user for the vLLM-style sampling parameters (Section 6.1).** Present `max_tokens`, `top_p`, `temperature` (and any per-arch extras) with their defaults; let the user override or skip each one to accept the default. Never silently use defaults.
3. Build and send the body per Section 6.2; handle the response per Section 6.3.

**To stop a service:** Read `references/code-templates.yaml` → `stop.registry_read` to resolve the job_id, read `skills/platform/<platform>/SKILL.md`, then follow Section 5.

**Reference data** (schemas, mappings, valid values — no instructions):
- **`references/service.yaml`** — image mappings, valid `network_arch` names, job payload schema, env var names, secrets classification.
- **`references/request.yaml`** — endpoint definition, request field schema, response shapes, code examples.
- **`references/code-templates.yaml`** — Python templates for payload building, registry writes, readiness checks, and stop/request flows.

---

## Secrets rule (applies to every generated code block in this skill)

**Never ask the user to type a secret value into a prompt.** For every secret value:
1. Tell the user which environment variable to set (e.g. `export HF_TOKEN=...`).
2. Generate code that reads it with `os.environ["VAR_NAME"]` — never hard-code, interpolate, or prompt for the value.

**Secret env vars** (full list in `references/service.yaml` → `secrets_handling`):
`HF_TOKEN`, `WANDB_API_KEY`, `CLEARML_API_ACCESS_KEY`, `CLEARML_API_SECRET_KEY`, `TAO_API_KEY`, `TAO_USER_KEY`.

**Safe to collect in the prompt:** `network_arch`, `model_path`, `num_gpus`, prompt text, `WANDB_*` config URLs, `CLEARML_*_HOST` URLs.

---

## 1. What to collect from the user

| Input | Role |
|--------|------|
| **`network_arch`** | Chooses container image, the per-arch inner command shape (`references/service.yaml` → `container_commands.<network_arch>`), and `neural_network_name` in the job JSON when applicable. Must match a basename in `valid_network_arch_config_basenames` in `references/service.yaml` (e.g. `cosmos-rl`, `cosmos-predict2.5`). |
| **`model_path`** | The trained model checkpoint. Valid forms: `hf_model://<org>/<model>` (HuggingFace Hub — set `HF_TOKEN` for gated models) or a local container filesystem path. Cloud URIs (`s3://`, `gs://`, `az://`) are NOT supported — the inference service has no cloud-storage dependency. Always ask the user; never substitute a placeholder. See `references/service.yaml` → `model_path_protocols`. |
| **`platform`** | Compute platform: `local-docker`, `brev`, `lepton`, `slurm`, or `kubernetes`. |
| **`num_gpus`** | Defaults to **1**; minimum **1** for inference. |

---

## 2. Image resolution

Each `network_arch` has a sidecar config file named `{network_arch}.config.json`. Resolve the container image as follows:

1. Read `{network_arch}.config.json` and take `api_params.image` (e.g. `COSMOS_RL`). This is a key into `docker_image_defaults.mapping` in `references/service.yaml`.
2. Look up that key in the mapping. If the host env var `IMAGE_<KEY>` is set (e.g. `IMAGE_COSMOS_RL`), it overrides the mapped default.
3. The mapped value is normally a dotted key into the repo-root `versions.yaml` manifest (e.g. `tao_toolkit.cosmos_rl`). Resolve it to a concrete `nvcr.io/...` image URI by looking up `versions.yaml` → `images.<group>.<name>`. Absolute URIs pass through unchanged, so an `IMAGE_<KEY>` env-var override that contains a full URI still works. The Python helper for this lives in `references/code-templates.yaml`.
4. If the config file is missing or `api_params.image` is empty, fall back to the `COSMOS_RL` key.

The config file also has `spec_params.inference.model_path` which drives **folder vs file** path semantics: if the value contains the substring `folder`, the container treats the path as a directory.

---

## 3. Environment variables (no callbacks)

Set these in `env_payload` before encoding `env_json`. Do **not** set `TAO_LOGGING_SERVER_URL` or `TAO_ADMIN_KEY`.

**`TAO_EXECUTION_BACKEND`** — must match the platform:

| Platform | `TAO_EXECUTION_BACKEND` value |
|----------|-------------------------------|
| local-docker | `local-docker` |
| brev | `local-docker` |
| lepton | `lepton` |
| slurm | `slurm` |
| kubernetes | `local-k8s` |

**`CLOUD_BASED`** — always `"False"` for this skill (disables callback posting to `TAO_LOGGING_SERVER_URL`).

**GPU env vars** — only needed when the platform skill does not handle GPU injection automatically:
- Tegra / Jetson: `--runtime=nvidia` with `NVIDIA_DRIVER_CAPABILITIES=all` and `NVIDIA_VISIBLE_DEVICES=<ids>`.
- Standard x86 + nvidia-container-toolkit: use Docker `device_requests`. The platform skill handles this.

---

## 4. Executing across platforms

The job payload and inner command (Sections 1–3) are **platform-agnostic**. For each platform, read **`skills/platform/<name>/SKILL.md`** for preflight checks and credentials **before** generating any execution code.

### 4.1 Build the inner command (per arch)

The inner-command shape is **per `network_arch`** — there is no uniform template. Look up the per-arch entry in `references/service.yaml` → `container_commands.<network_arch>`; if not present, the arch is unsupported — stop and ask. Pick the matching sub-block in `references/code-templates.yaml` → `job_payload_builder.<network_arch>`. Prefix the command with `umask 0 &&` and keep it **identical across platforms** (local-docker, brev, lepton, slurm, kubernetes).

Common across arches:

- `job_id`: fresh `uuid.uuid4()` — becomes the container name and registry key.
- `image`: resolve per Section 2.
- Secrets (`access_key`, `secret_key`, `HF_TOKEN`, etc.) are read from env vars at runtime — never hard-code, never log or print.

Arch-specific notes (full details in `references/service.yaml` → `container_commands`):

- **`cosmos-rl`** — single `--job '<JOB_JSON>' --docker_env_vars '<ENV_JSON>'` blob; `json.dumps(...)` + `shlex.quote(...)`. `env_payload` carries `TAO_EXECUTION_BACKEND` (per Section 3 table), `TAO_API_JOB_ID`, `CLOUD_BASED=False`. The inference service has no cloud-storage dependency; `HF_TOKEN` is the only cred env var that ever applies (for gated HuggingFace models).
- **`cosmos-predict2.5`** — flag-style `cosmos_predict inference_microservice start ... --port 8080` (no `setup.` prefix; uses `tyro.conf.OmitArgPrefixes`). `--job`/`--docker_env_vars` are **not** accepted. Translate `model_path` to `--checkpoint-path` (local path) or `--model <registered_key>` (`hf_model://`); cloud URIs are rejected. The only cred env var that ever applies is `HF_TOKEN` for gated HuggingFace models. Per-request params (prompt, inference_type, num_output_frames, guidance, seed, num_steps, negative_prompt) go in the request body, not at startup. `TAO_EXECUTION_BACKEND`/`TAO_API_JOB_ID`/`CLOUD_BASED` are unused and may be omitted.

### 4.2 Delegate execution to the platform skill

Read **`skills/platform/<platform>/SKILL.md`** and follow it to start the container.

**Base parameters (all platforms):**

| Parameter | Value |
|-----------|-------|
| `image` | resolved container image (Section 2) |
| `command` | `inner` — the shell string built in Section 4.1 |
| `gpu_count` | `num_gpus` |
| `env_vars` | `env_payload` |
| job / container name | `job_id` — must equal the UUID from 4.1 so the registry can reference it |
| `host_port` *(local-docker, brev)* | host-side port to bind to container port 8080. Default `8080`, but **must be unique per concurrent service** — see the port-allocation rule below. |

**Platform-specific additional inputs:**

| Platform | Additional inputs |
|----------|------------------|
| **local-docker** | None beyond base |
| **brev** | `instance_id` (optional — reuse an existing instance); on multi-credential / multi-workspace accounts also `cloud_cred_id` and `workspace_group_id` for first-create — see `skills/platform/tao-run-on-brev/SKILL.md` |
| **lepton** | `resource_shape` (GPU shape ID, e.g. `gpu.8xh100-sxm`); `dedicated_node_group` (optional) |
| **slurm** | `partition` and `account` — check `SLURM_PARTITION`/`SLURM_ACCOUNT` env vars; ask user if unset |
| **kubernetes** | `namespace` (default: `default`); `image_pull_secret` (required for `nvcr.io` images) |

**Port binding (local-docker and brev):** use **direct docker run** (not DockerSDK) so that `-p <host_port>:8080` can be passed and the container name equals `job_id` exactly.

**Port allocation rule (local-docker and brev, REQUIRED for concurrent services):** Before starting a service, read the registry (`/tmp/tao-inf-ms-state.json`) and collect the set of `host_port` values from every existing entry on the same platform (and, for brev, the same `instance_id`). Pick the **lowest free port starting from 8080** that is not in that set — e.g. `host_port = next(p for p in range(8080, 8200) if p not in used_ports)`. The default `8080` only applies when no other service is running. This is what makes "start 3 services, each reachable at a distinct `host_url`" work; without it, services 2 and 3 fail with `bind: address already in use`. Lepton, SLURM, and kubernetes get distinct endpoints from their own platform mechanisms and do not need this step.

### 4.3 After start: service registry and endpoint

Write the service registry immediately after the platform confirms the container is running. The registry (`/tmp/tao-inf-ms-state.json`) is keyed by `job_id`; `"latest"` always points to the most recently started service.

See `references/code-templates.yaml` → `registry_write.<platform>` for the Python template.

| Platform | `host_url` | `platform_job_id` | Extra step before writing |
|----------|-----------|-------------------|--------------------------|
| **local-docker** | `http://localhost:{host_port}` | — | None |
| **brev** | `http://{brev_ip}:{host_port}` | — | `brev ls` → get instance IP (`localhost` is invalid on remote VM) |
| **lepton** | Lepton endpoint URL | `job.id` | Poll `sdk.get_job_status` until Running; get endpoint from console or `lep job get <job.id>` |
| **slurm** | `http://localhost:{host_port}` | SLURM scheduler job ID | Wait until Running; SSH port-forward `localhost:{host_port}→{node}:8080` |
| **kubernetes** | `http://{external_ip}:8080` | k8s job name | `kubectl expose job … --type=LoadBalancer`; wait for external IP |

After writing the registry, print the job_id and URL:

```python
print(f"Inference service started.")
print(f"  Job ID : {job_id}")
print(f"  Arch   : {network_arch}")
print(f"  URL    : {state[job_id]['host_url']}/v1/chat/completions")
print(f"Use this Job ID to send requests or stop the service.")
```

Then poll for readiness — see `references/code-templates.yaml` → `readiness_check`. The container loads the model in the background; do not send requests before it returns 200.

---

## 5. Stopping the inference service

Ask the user for the `job_id` to stop. If they don't provide one, default to `state["latest"]` and confirm which job_id is being stopped. Read the registry using `references/code-templates.yaml` → `stop.registry_read`, then read **`skills/platform/<platform>/SKILL.md`** and use its cancellation / stop mechanism.

| Platform | Identifier to pass | Extra cleanup |
|----------|--------------------|---------------|
| **local-docker** | `job_id_to_stop` — container name | None |
| **brev** | `job_id_to_stop` — container name | None |
| **lepton** | `entry["platform_job_id"]` — Lepton job ID | None |
| **slurm** | `entry["platform_job_id"]` — SLURM job ID | `pkill -f "ssh.*-L.*{entry['host_port']}"` |
| **kubernetes** | `entry["platform_job_id"]` — k8s job name | `kubectl delete svc {entry["platform_job_id"]} -n <namespace>` |

where `entry = state[job_id_to_stop]`. After stopping, clean up the registry: `references/code-templates.yaml` → `stop.registry_cleanup`.

---

## 6. Sending inference requests

### 6.0 Resolve which service receives this request (REQUIRED)

Each request must be routed to the **specific** service that runs the matching model. Routing happens by `job_id` — the registry stores `network_arch` per entry, so you can resolve a target by arch when the user names a model instead of a `job_id`. Apply these rules in order:

1. **User provided an explicit `job_id`** → use it. Verify it exists in `state`.
2. **User named a `network_arch`** (e.g. "send this to the cosmos-rl service") → look up matching entries: `candidates = [j for j, e in state.items() if j != "latest" and isinstance(e, dict) and e["network_arch"] == arch]`.
   - Exactly one match → use it.
   - Multiple matches → **prompt the user** with the candidate `job_id`s and their `started_at`; do not auto-pick.
   - No match → stop and tell the user no service for that arch is running.
3. **No `job_id` and no `network_arch`** → count non-`"latest"` entries in `state`:
   - Exactly one running service → use it.
   - Two or more → **do not silently default to `state["latest"]`**. Prompt the user with the full list (`job_id`, `network_arch`, `host_url`) and require an explicit choice. The `"latest"` pointer is a convenience for single-service workflows, not a routing fallback when multiple services coexist.
   - Zero → stop and tell the user to start a service first.

After resolving, read the endpoint from the registry (`references/code-templates.yaml` → `request.registry_read`), passing the resolved `job_id` as `user_provided_job_id`. Confirm to the user: "Sending to job_id=… arch=… url=…". If the service may still be loading, poll readiness first (`references/code-templates.yaml` → `readiness_check`).

**Cross-check before sending:** if the user-supplied request body contains arch-specific fields (e.g. `guidance` / `num_steps` / `seed` / `negative_prompt` → cosmos-predict2.5; required `image_url`/`video_url` content items → cosmos-rl), verify they are consistent with `state[job_id]["network_arch"]`. On mismatch, stop and ask — sending a cosmos-predict2.5 body to a cosmos-rl service will fail at the container with a 4xx/5xx that is harder to diagnose than catching it here.

### 6.1 Sampling parameters — REQUIRED user prompt before each request

Before constructing the request body, you **MUST** explicitly prompt the user for the vLLM-style sampling parameters. Do **not** silently apply defaults. Use a structured prompt (e.g. `AskUserQuestion` in Claude Code, one question per field) that:

1. Lists every applicable field with its **type** and **default value**.
2. Lets the user skip / accept any field to take that field's default — entering a value is never required.
3. Collects all fields in one round.

After the prompt, apply each user-entered value verbatim and substitute the default for any skipped field. Do not invent values or silently clamp.

**Field list, defaults, and per-arch applicability:** `references/request.yaml` → `chat_completions_request_body` (base sampling fields: `max_tokens`, `top_p`, `temperature`) and `network_arch_constraints.<network_arch>` (per-arch overrides and extras such as `guidance`/`num_steps`/`seed`/`negative_prompt` for `cosmos-predict2.5`). If a field is marked unsupported for the active arch, do **not** prompt for it and do **not** include it in the body.

### 6.2 Request format

Send a `POST` to `{BASE_URL}/v1/chat/completions` with `Content-Type: application/json` and a timeout of **at least 300 s**. The body is OpenAI-compatible (vLLM chat completions); see `references/request.yaml` → `chat_completions_request_body` for the full field schema and content-item shapes (text / image_url / video_url), and `code_examples` for ready-to-run Python and curl samples.

**Constraints:** only the first user message is processed. No secret values in request bodies. **Per-network constraints** (e.g. cosmos-rl requires every request to include an image or video; cosmos-rl rejects `data:` URIs) are in `references/request.yaml` → `network_arch_constraints`.

### 6.3 Response handling

| HTTP status | Meaning | Action |
|-------------|---------|--------|
| **200** | Success — `choices[0].message.content` has the generated text | Read result |
| **202** | Server still initializing or model still loading | Retry after a delay |
| **503** | Initialization failed, model load failed, **or model not yet ready** | Inspect `error.type`: `model_not_ready` → retry; `initialization_error` / `model_load_error` → give up and check logs |
| **400** | Missing or empty JSON body | Fix request |
| **500** | Unhandled exception during inference | Check container logs |

For 202 and 503, the body contains `{"error": {"type": "<error_type>", "message": "<reason>"}}`. See `container_response_shapes` in `references/request.yaml` for error type strings.
