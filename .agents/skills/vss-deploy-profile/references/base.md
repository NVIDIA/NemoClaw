# Base Profile Reference

Profile: `base` | Blueprint: `bp_developer_base` | Mode: `2d`

Video upload, Q&A, and report generation with HITL (Human-in-the-Loop) feedback.

## Services Deployed

Profile `bp_developer_base_2d` activates only the services below. Elasticsearch, Kafka, and VST MCP are **not** part of `base` — they ship with `search`, `lvs`, and `alerts` (see those profile references). If you see `VST_MCP_URL` / `VSS_VA_MCP_PORT` warnings during `docker compose config`, that's expected on `base` and not an error.

Container names below are exactly what `docker ps` reports (sourced from the `container_name:` keys in `deploy/docker/services/**/compose.yml`). LLM/VLM NIM containers are named after the selected model — the row shows the **default**; swapping `LLM_NAME_SLUG` / `VLM_NAME_SLUG` in `generated.env` selects a different per-model compose with its own `container_name`.

| Service | Container | Port | Purpose |
|---|---|---|---|
| VSS Agent | `vss-agent` | 8000 | Orchestrates tool calls and model inference |
| VSS Agent UI | `vss-agent-ui` | 3000 | Web UI — chat, video upload, views |
| HAProxy Ingress | `vss-haproxy-ingress` | 7777 | Browser-facing entry point — proxies UI + Agent API + VST |
| VIOS Ingress (VST) | `vss-vios-ingress` | 30888 | Video Storage Tool — ingest, record, playback |
| VIOS Postgres | `vss-vios-postgres` | — | VIOS metadata store |
| VIOS Sensor MS | `vss-vios-sensor` | — | VIOS sensor management |
| VIOS Stream Processing | `vss-vios-streamprocessing` | — | VIOS stream processing |
| LLM NIM (default) | `nvidia-nemotron-nano-9b-v2` | 30081 | Nemotron LLM for reasoning. Activated by `llm_<mode>_<slug>` COMPOSE_PROFILES; container name = `${LLM_NAME_SLUG}` (e.g. `nvidia-nemotron-nano-9b-v2-fp8`, `nemotron-3-nano`, `gpt-oss-20b`, `llama-3.3-nemotron-super-49b-v1.5`). |
| VLM NIM (default) | `nvidia-cosmos-reason2-8b` | 30082 | Cosmos Reason VLM for vision. Activated by `vlm_<mode>_<slug>`; container name = `${VLM_NAME_SLUG}` (e.g. `cosmos-reason1-7b`, `qwen3-vl-8b-instruct`). |
| Redis | `redis` | 6379 | Cache |
| Phoenix | `phoenix` | 6006 | Observability / telemetry |

## Default Models

| Role | Model | Slug | Type |
|---|---|---|---|
| LLM | `nvidia/nvidia-nemotron-nano-9b-v2` | `nvidia-nemotron-nano-9b-v2` | nim |
| VLM | `nvidia/cosmos-reason2-8b` | `cosmos-reason2-8b` | nim |

The base `.env` defaults both sides to shared local deployment:
`LLM_MODE=local_shared` and `VLM_MODE=local_shared`, with
`LLM_DEVICE_ID=0` and `VLM_DEVICE_ID=0`. `dev-profile.sh` writes the same
mode when LLM/VLM device IDs match and no remote flags are selected.

**Alternate LLMs:** `nvidia/NVIDIA-Nemotron-Nano-9B-v2-FP8`, `nvidia/nvidia-nemotron-nano-9b-v2-dgx-spark`, `nvidia/nemotron-3-nano`, `nvidia/llama-3.3-nemotron-super-49b-v1.5`, `openai/gpt-oss-20b`

**Alternate VLMs:** `nvidia/cosmos-reason1-7b`, `Qwen/Qwen3-VL-8B-Instruct`

## Sizing — GPU memory per model

Sizing for `base` is per-model. The default pair is `cosmos-reason2-8b` (VLM) + `nvidia-nemotron-nano-9b-v2` (LLM); the user can swap either by editing `LLM_NAME` / `LLM_NAME_SLUG` / `VLM_NAME` / `VLM_NAME_SLUG` in `dev-profile-base/generated.env` (the skill's per-deploy working copy; see ``SKILL.md`` (see `../SKILL.md`) Step 1c). The compose system auto-resolves to the right service via the computed `COMPOSE_PROFILES` (`llm_<mode>_<slug>` and `vlm_<mode>_<slug>`).

The tables below give the **VRAM cost per model** (weights × 1.3 overhead). Use this with the [Sizing math](#sizing-math) section to decide whether a (LLM, VLM, GPU) combo fits. 

### LLMs (compose files under `deploy/docker/services/nim/`)

| Model | Type | Compose file | Params | Precision | Est. VRAM (weights × 1.3) |
|---|---|---|---|---|---|
| `nvidia/nvidia-nemotron-nano-9b-v2` (default) | NIM (`nvcr.io/nim/...:1`) | `nim/nvidia-nemotron-nano-9b-v2/compose.yml` | 9 B | FP16 | **23.4 GB** |
| `nvidia/nvidia-nemotron-nano-9b-v2-dgx-spark` | NIM (`nvcr.io/nim/...:1.0.0-variant`, DGX Spark only) | not in tree - see `edge.md` | 9 B | NVFP4 | ~5.9 GB |
| `nvidia/NVIDIA-Nemotron-Nano-9B-v2-FP8` | DLFW vLLM (`nvcr.io/nvidia/vllm:25.12.post1-py3`) | `nim/nvidia-nemotron-nano-9b-v2-fp8/compose.yml` | 9 B | FP8 | **11.7 GB** |
| `nvidia/nemotron-3-nano` | NIM | `nim/nemotron-3-nano/compose.yml` | ~3 B | FP16 | ~7.8 GB |
| `nvidia/llama-3.3-nemotron-super-49b-v1.5` | NIM | `nim/llama-3.3-nemotron-super-49b-v1.5/compose.yml` | 49 B | FP16 | **127 GB** (needs tp≥2 to fit on H100/L40S) |
| `openai/gpt-oss-20b` | NIM | `nim/gpt-oss-20b/compose.yml` | 20 B | FP16 | **52 GB** |
| `nvidia/NVIDIA-Nemotron-Edge-4B-v2.1-EA-020126_FP8` | DLFW vLLM (standalone, edge only) | not in tree — see `edge.md` | 4 B | FP8 | **5.2 GB** |

### VLMs (compose files under `deploy/docker/services/nim/`)

| Model | Type | Compose file | Params | Precision | Est. VRAM (weights × 1.3) |
|---|---|---|---|---|---|
| `nvidia/cosmos-reason2-8b` (default) | NIM (`nvcr.io/nim/...:1.6.0`) | `nim/cosmos-reason2-8b/compose.yml` | 8 B | FP16 | **20.8 GB** |
| `nvidia/cosmos-reason1-7b` | NIM | `nim/cosmos-reason1-7b/compose.yml` | 7 B | FP16 | **18.2 GB** |
| `Qwen/Qwen3-VL-8B-Instruct` | DLFW vLLM | `nim/qwen3-vl-8b-instruct/compose.yml` | 8 B | FP16 | **20.8 GB** |

### GPU VRAM reference


| GPU | VRAM | 85% usable | Notes |
|---|---|---|---|
| H100 SXM / PCIe | 80 GB | 68 GB | Default for shared mode |
| H200 | 141 GB | 119.85 GB | Plenty of headroom for any pair |
| B200 / GB200 | 192 GB | 163.2 GB | Newest, highest-capacity |
| RTX PRO 6000 (Blackwell) | 96 GB | 81.6 GB | Workstation Blackwell |
| GB10 (DGX Spark) | 128 GB unified | ~108 GB | Shared with system; cap aggressively |
| AGX/IGX Thor | 128 GB unified | ~108 GB | Edge unified memory |
| L40S / L40 / RTX 6000 Ada | 48 GB | 40.8 GB | Too small for LLM + VLM shared at FP16 |
| A100 80 GB | 80 GB | 68 GB | Hopper-era 80 GB option |

The "85% usable" column is the budget you have for weights + KV cache + activations. we reserve the remaining 15% for framework/CUDA overhead (`SINGLE_GPU_MEMORY_THRESHOLD = 0.85`).

## Sizing math


```text
weights_GB     = (num_params_B × bits_per_param) / 8
total_GB       = weights_GB × 1.3                          # +30% for KV cache + activations
fits_dedicated = total_GB                ≤  0.85 × gpu_vram_GB
fits_shared    = total_GB(LLM) + total_GB(VLM)
                                         ≤  0.85 × gpu_vram_GB

# In single-GPU shared mode, KV / GPU-mem fraction per service:
fraction       = (this_num_params / total_num_params) × 0.85
# Set this in NIM_KVCACHE_PERCENT (NIMs) and --gpu-memory-utilization (vLLM/DLFW).
```

`bits_per_param` = 16 for FP16/BF16, 8 for FP8/INT8, 4 for INT4/MXFP4.

### `NIM_KVCACHE_PERCENT` ↔ GB on common GPUs

`NIM_KVCACHE_PERCENT` is a fraction (0.0–1.0) of **total GPU VRAM** the NIM container is allowed to consume (weights + KV cache + activations all included). For vLLM containers, the same fraction is `--gpu-memory-utilization`.

> **NIM 2.x renames the knob.** Set both forms in every `hw-*.env` so the deploy works on either major version:
> - **LLM NIM** — `NIM_KVCACHE_PERCENT=<v>` *and* `NIM_GPU_MEM_FRACTION=<v>`.
> - **VLM NIM** — `NIM_KVCACHE_PERCENT=<v>` *and* `NIM_PASSTHROUGH_ARGS="--gpu-memory-utilization <v>"`.
>
> The rest of this doc uses `NIM_KVCACHE_PERCENT` for brevity; mirror the value into the matching 2.x form per the table above.

| Fraction | H100 / A100-80 (80 GB) | H200 (141 GB) | RTX PRO 6000 (96 GB) | GB10 / Thor (128 GB) | L40S (48 GB) |
|---|---|---|---|---|---|
| 0.25 | 20 GB | 35.25 GB | 24 GB | 32 GB | 12 GB |
| 0.40 | 32 GB | 56.4 GB | 38.4 GB | 51.2 GB | 19.2 GB |
| 0.50 | 40 GB | 70.5 GB | 48 GB | 64 GB | 24 GB |
| 0.70 (default dedicated for VLM) | **56 GB** | 98.7 GB | 67.2 GB | 89.6 GB | 33.6 GB |
| 0.85 (max safe) | 68 GB | 119.85 GB | 81.6 GB | 108.8 GB | 40.8 GB |

Read this as: at `NIM_KVCACHE_PERCENT=0.7` on an H100, the NIM is allowed 56 GB total. A 9B FP16 model uses ~23 GB of that for weights, leaving ~33 GB for KV cache — enough for long contexts at moderate concurrency.

### Worked example — Nemotron Nano 9B + Cosmos Reason2 8B on H100 80 GB shared

```text
LLM weights = 9 × 16 / 8 = 18 GB        →  18 × 1.3 = 23.4 GB total
VLM weights = 8 × 16 / 8 = 16 GB        →  16 × 1.3 = 20.8 GB total

shared check: 23.4 + 20.8 = 44.2 GB     ≤  68 GB (0.85 × 80) ✓ fits

LLM fraction = (9 / (9+8)) × 0.85 = 0.449   → NIM_KVCACHE_PERCENT=0.449
VLM fraction = (8 / (9+8)) × 0.85 = 0.400   → NIM_KVCACHE_PERCENT=0.400
reserved     = 1 - (0.449 + 0.400) = 0.151  (the 15% framework/CUDA buffer)
```

The in-tree `*-shared.env` files round these to `0.4` for both because the default 9B + 8B pair is symmetric enough; you don't need the exact `0.449` — anything within ±0.05 is fine.

## Choosing dedicated vs shared

| Available GPUs | Strategy |
|---|---|
| **2+ GPUs** | **Dedicated** — pick the lowest precision available for each model and put one per GPU. Set `LLM_MODE=local`, `VLM_MODE=local`, `LLM_DEVICE_ID=0`, `VLM_DEVICE_ID=1`. NIM defaults take care of KV cache (`NIM_KVCACHE_PERCENT` not needed). |
| **1 GPU + the pair fits** | **Shared** — set `LLM_MODE=local_shared`, `VLM_MODE=local_shared`, both `LLM_DEVICE_ID` and `VLM_DEVICE_ID` to the same index. Set `NIM_KVCACHE_PERCENT` per the formula above. |
| **1 GPU but the pair doesn't fit** | **Stop and ask the user about a remote endpoint** — see [When to use remote LLM/VLM](#when-to-use-remote-llmvlm). Don't silently switch to a smaller / lower-precision model; the user picked the model for a reason. |
| **0 local GPUs** | **`remote-all`** — both `LLM_MODE=remote` and `VLM_MODE=remote`. Sizing math doesn't apply locally. |

Rule of thumb: a config is **`single_gpu_viable`** iff every service has `gpu_count=1` AND the sum of all services' total VRAM ≤ 0.85 × GPU VRAM. If false, the agent must escalate to the user (don't auto-pick a smaller local fallback).

## When to use remote LLM/VLM

Two — and only two — triggers should put either side into `remote` mode.

### Trigger 1 — User supplied an endpoint

The user's prompt names an LLM and/or VLM endpoint URL (e.g. *"deploy with remote LLM at `http://launchpad:11571` serving `nvidia/nvidia-nemotron-nano-9b-v2`"*) or asks for `remote-all`. Action:

- Set `LLM_MODE=remote` (and/or `VLM_MODE=remote`) in `dev-profile-base/generated.env`.
- Set `LLM_BASE_URL` (no trailing `/v1`), `LLM_NAME`, and `NVIDIA_API_KEY` if the endpoint requires auth.
- Local sizing math doesn't apply for the remote side.
- See [Env Overrides — Common Scenarios](#env-overrides--common-scenarios) below for full recipes.

### Trigger 2 — Local GPU can't fit the model the user wants

The sizing math says the user's chosen LLM/VLM (or pair) doesn't fit on the available GPUs. **Stop the deploy and ask the user**:

> The host has `<N>` × `<GPU>` (`<VRAM>` GB each). The model `<LLM_NAME>` needs `~<X>` GB at `<precision>`, which doesn't fit alongside `<VLM_NAME>` (`~<Y>` GB).
>
> Options:
> 1. **Switch to a remote LLM (or VLM)** — give me the endpoint URL and the model name served there. NVIDIA's public API is `https://integrate.api.nvidia.com` if you have an `NVIDIA_API_KEY`.
> 2. **Switch to a lower-precision build** of the same model (e.g. `nvidia/NVIDIA-Nemotron-Nano-9B-v2-FP8` instead of FP16).
> 3. **Use `remote-all`** — both LLM and VLM at remote endpoints; no local GPU used.

Wait for the user to pick. **Don't silently substitute a different local model** — the user chose the original for a reason (eval consistency, behavior parity, license, etc.).

### Hard rules

- **L40S (48 GB) cannot host the default LLM + VLM shared.** 23.4 + 20.8 = 44.2 GB > 0.85 × 48 = 40.8 GB. Use a 2-GPU L40S host (one model per GPU), or escalate to the user per Trigger 2.
- **DGX Spark shared mode must use the DGX Spark Nano 9B NIM path in `edge.md`.** Run `nvcr.io/nim/nvidia/nvidia-nemotron-nano-9b-v2-dgx-spark:1.0.0-variant` as a standalone local NIM on port `30081` and set `LLM_MODE=remote`, `LLM_BASE_URL=http://localhost:30081`, and `LLM_NAME_SLUG=none`. The image is not wired into compose yet. Do not use the standard `nvcr.io/nim/nvidia/nvidia-nemotron-nano-9b-v2:1` image on DGX Spark.
- **AGX/IGX Thor shared mode: Edge 4B is the LLM; the VLM still runs via RT-VLM.** The Edge 4B fallback in `edge.md` (standalone vLLM + `HF_TOKEN`) is the **LLM** path — this skill has no verified Thor-supported Nano 9B NIM, so keep it unless the user supplies a verified remote LLM endpoint. The **VLM** on base+Thor is *not* a standalone NIM: `dev-profile.sh` deploys RT-VLM with the integrated Cosmos Reason 2 checkpoint (`VLM_MODEL_TYPE=rtvi`, `RTVI_VLM_MODEL_PATH=ngc:nim/nvidia/cosmos-reason2-8b:hf-1208`, `RTVI_VLM_MODEL_TO_USE=cosmos-reason2`, `RTVI_VLLM_GPU_MEMORY_UTILIZATION=0.35`).
- **Llama 3.3 49B FP16 doesn't fit on a single 80 GB GPU.** 49 × 16 / 8 × 1.3 = 127 GB > 68 GB usable. Either run dedicated with tensor parallelism (`tp=2` on two H100s → 63.7 GB/GPU) or use H200 (141 GB) / B200 (192 GB) — or escalate per Trigger 2.
- **`HARDWARE_PROFILE` is just an env-file label, not a sizing oracle.** It selects the path `nim/<slug>/hw-<HARDWARE_PROFILE>(-shared).env` — that's all. Pre-tuned env files exist for known platforms as a convenience, but missing != unsupported. Compute the right `NIM_KVCACHE_PERCENT` (or `--gpu-memory-utilization`) from the [Sizing math](#sizing-math) and write it into a fresh `hw-<HARDWARE_PROFILE>(-shared).env` (or set `HARDWARE_PROFILE=OTHER` and edit `hw-OTHER(-shared).env`). The agent's correctness check is the **resolved compose**: does it include the right LLM/VLM service for the chosen `LLM_NAME_SLUG` / `VLM_NAME_SLUG`, and does that service's env carry the computed sizing values? If yes, the deploy will work regardless of which `HARDWARE_PROFILE` label is used.
- **Remote side — no local GPU needed.** When `LLM_MODE=remote` or `VLM_MODE=remote`, the matching local NIM/vLLM service is skipped entirely. Sizing math doesn't apply for the remote side.

## Tuning workflow

`HARDWARE_PROFILE` only chooses which `nim/<slug>/hw-<HARDWARE_PROFILE>(-shared).env` file compose loads. The values inside that file are what actually matter, and they come from the sizing math — not from any hardware-specific knowledge baked into the label. So the procedure is the same whether or not the host has a "known" profile:

1. **Compute** the start fraction from [Sizing math](#sizing-math). Round to 2 decimal places.
2. **Write** it into the env file the resolved compose will load. The path is `deploy/docker/services/nim/<model-slug>/hw-<HARDWARE_PROFILE>(-shared).env` — pick or create whichever `HARDWARE_PROFILE` label fits (use the host's actual profile for documentation value, or `OTHER` if none matches and you're not contributing back).
   - **LLM NIM**: `NIM_KVCACHE_PERCENT=<v>` **and** `NIM_GPU_MEM_FRACTION=<v>`. **VLM NIM**: `NIM_KVCACHE_PERCENT=<v>` **and** `NIM_PASSTHROUGH_ARGS="--gpu-memory-utilization <v>"`. Also set `NIM_MAX_MODEL_LEN` and `NIM_MAX_NUM_SEQS` if you need to constrain context/concurrency.
   - vLLM: edit the model's `compose.yml` to set `--gpu-memory-utilization <value>` (or pass through an env var if the compose supports it)
3. **Re-resolve and deploy**: `docker compose --env-file <env> config > resolved.yml && docker compose --env-file <env> -f resolved.yml up -d`. `--env-file` is required on `up` too — without it `COMPOSE_PROFILES` is unset and `up` exits 0 with zero services (see `SKILL.md` Step 5). Before running `up -d`, verify `resolved.yml` includes the right LLM/VLM service for your `LLM_NAME_SLUG` / `VLM_NAME_SLUG` and that the sizing values you wrote are visible in its `environment:` block.
4. **Watch container logs** for the KV-cache report on startup (NIM logs `KV cache size: X GB` once it boots; vLLM logs `Maximum concurrency for X tokens per GPU: Y x`):
   - **OOM at model load** → lower fraction by 0.05 and redeploy.
   - **OOM mid-inference** (after a few requests, on long prompts) → also lower `NIM_MAX_MODEL_LEN` / `--max-model-len` and `NIM_MAX_NUM_SEQS` (e.g. from `4096`/`16` to `2048`/`4`).
   - **Container starts but "Out of memory for chunked prefill"** → lower `NIM_MAX_NUM_SEQS` only.
   - **Plenty of headroom** (KV cache reports < 30% utilization under load) → raise fraction by 0.05 and redeploy to extract more concurrency.
5. **Save** the working values into the `hw-*(.env)` so the combo is reproducible.

> **Don't tune past 0.85.** The default 15% reserved is what NIMs/vLLM need for CUDA graphs, framework overhead, and activation buffers. Going higher reliably OOMs under non-trivial load.

## Swapping a different LLM/VLM

The skill never invokes `dev-profile.sh`. Swapping a model is purely an `.env` edit + (if needed) a new compose file under `deploy/docker/services/nim/<slug>/`. Use this decision tree.

### Step 1 — Is the model already in tree?

In-tree slugs are the directory names under `deploy/docker/services/nim/`:

- **LLMs:** `nvidia-nemotron-nano-9b-v2`, `nvidia-nemotron-nano-9b-v2-fp8`, `nemotron-3-nano`, `llama-3.3-nemotron-super-49b-v1.5`, `gpt-oss-20b`
- **VLMs:** `cosmos-reason2-8b`, `cosmos-reason1-7b`, `qwen3-vl-8b-instruct`

If yes → set the four env vars in `deploy/docker/developer-profiles/dev-profile-base/generated.env`:

```bash
# Example: switch LLM to Nano 9B FP8
LLM_NAME=nvidia/NVIDIA-Nemotron-Nano-9B-v2-FP8
LLM_NAME_SLUG=nvidia-nemotron-nano-9b-v2-fp8

# Example: switch VLM to cosmos-reason1-7b
VLM_NAME=nvidia/cosmos-reason1-7b
VLM_NAME_SLUG=cosmos-reason1-7b
```

The slug must match the directory name exactly. `COMPOSE_PROFILES` then auto-includes `llm_<mode>_<slug>` and `vlm_<mode>_<slug>`, picking up the right service from the in-tree compose. Re-run the dry-run (`docker compose --env-file <env> config > resolved.yml`) and verify `resolved.yml` contains the expected service. Confirm the `hw-<HARDWARE_PROFILE>(-shared).env` exists for the new model on this host (per the [GPU VRAM reference](#gpu-vram-reference) above).

### Step 2 — Is the model published as a NIM on build.nvidia.com?

If yes (NGC catalog has an `nvcr.io/nim/<org>/<model>:<tag>` image): create a new in-tree NIM compose.

1. Create `deploy/docker/services/nim/<your-slug>/compose.yml` modeled on `cosmos-reason2-8b/compose.yml`. Two services:
   - `<your-slug>` with `profiles: [llm_local_<slug>]` (or `vlm_local_<slug>`) and the dedicated-GPU device assignment.
   - `<your-slug>-shared-gpu` with `profiles: [llm_local_shared_<slug>]` (or `vlm_local_shared_<slug>`) and `device_ids: ["${SHARED_LLM_VLM_DEVICE_ID:-${LLM_DEVICE_ID:-0}}"]`.
2. Add `hw-<HARDWARE_PROFILE>.env` and `hw-<HARDWARE_PROFILE>-shared.env` files. Compute the starting fraction from the formula in [Sizing math](#sizing-math). Set both forms per the v1.x↔v2.x table above: **LLM** → `NIM_KVCACHE_PERCENT=<v>` and `NIM_GPU_MEM_FRACTION=<v>`; **VLM** → `NIM_KVCACHE_PERCENT=<v>` and `NIM_PASSTHROUGH_ARGS="--gpu-memory-utilization <v>"`. Add `NIM_MAX_MODEL_LEN` and `NIM_MAX_NUM_SEQS` per the model's documented limits.
3. Add the new compose file to the `include:` list in `deploy/docker/services/nim/compose.yml`.
4. Edit `dev-profile-base/generated.env` to set `LLM_NAME` / `LLM_NAME_SLUG` (or VLM equivalents).
5. Run the [Tuning workflow](#tuning-workflow) above.

### Step 3 — No NIM available → use a DLFW (vLLM) container

For models that aren't packaged as NIMs but have weights on Hugging Face or NGC, deploy them via `nvcr.io/nvidia/vllm:<tag>-py3` (x86_64) or `ghcr.io/nvidia-ai-iot/vllm:latest-jetson-thor` (Jetson). The in-tree DLFW pattern lives in `deploy/docker/services/nim/nvidia-nemotron-nano-9b-v2-fp8/compose.yml` — copy that as the template. Key shape:

```yaml
services:
  <slug>:                                    # dedicated-GPU variant
    image: nvcr.io/nvidia/vllm:25.12.post1-py3
    command:
      - python3
      - -m
      - vllm.entrypoints.openai.api_server
      - --model
      - <hf-org>/<hf-model>
      - --trust-remote-code
      - --tensor-parallel-size
      - "1"
      - --gpu-memory-utilization
      - "0.85"                               # dedicated: leave 15% headroom
      - --port
      - "8000"
      - --enable-auto-tool-choice
      - --tool-call-parser
      - <parser>                             # qwen3_coder, nemotron_json, llama3_json, ...
    profiles:
      - llm_local_<slug>
    runtime: nvidia
    ports:
      - ${LLM_PORT:-30081}:8000
    env_file:
      - ${VSS_APPS_DIR}/services/nim/<slug>/hw-${HARDWARE_PROFILE}.env
    deploy:
      resources:
        reservations:
          devices:
            - capabilities: [gpu]
              driver: nvidia
              device_ids: ["${LLM_DEVICE_ID:-0}"]

  <slug>-shared-gpu:                         # shared-GPU variant
    # ... same shape, with these changes:
    command:
      # ...
      - --gpu-memory-utilization
      - "0.40"                               # shared default; refine via Sizing math
    profiles:
      - llm_local_shared_<slug>
    env_file:
      - ${VSS_APPS_DIR}/services/nim/<slug>/hw-${HARDWARE_PROFILE}-shared.env
    deploy:
      resources:
        reservations:
          devices:
            - capabilities: [gpu]
              driver: nvidia
              device_ids: ["${SHARED_LLM_VLM_DEVICE_ID:-${LLM_DEVICE_ID:-0}}"]
```

Then add the file to `nim/compose.yml`'s `include:` list and edit `dev-profile-base/generated.env` to set `LLM_NAME` / `LLM_NAME_SLUG`. Use the [Tuning workflow](#tuning-workflow) to dial in `--gpu-memory-utilization`.

> **Edge note.** On DGX Spark / Thor, follow `edge.md` instead. DGX Spark currently runs the DGX Spark Nano 9B NIM as a standalone local service on port `30081`; Thor still uses the Edge 4B standalone vLLM fallback. In both cases the agent treats the local standalone LLM as `LLM_MODE=remote` because the LLM service is outside the compose stack.

### Picking `--gpu-memory-utilization` quickly

For shared mode, compute it via the formula. As sanity-check defaults / in-tree precedents:

| Co-residency | LLM `--gpu-memory-utilization` | VLM `NIM_KVCACHE_PERCENT` | Source |
|---|---|---|---|
| Nano 9B v2 FP8 + Cosmos Reason2 8B (shared) | 0.40 | 0.40 | FP8 + Cosmos2 `*-shared.env` |
| DGX Spark Nano 9B NIM + Cosmos Reason2 8B on DGX Spark | 0.40 | 0.40 | `edge.md` standalone NIM recipe |
| Edge 4B + RT-VLM on Thor | 0.25 | RT-VLM default 0.35 | `edge.md` Thor fallback |
| Qwen3-VL 8B + Nano 9B (shared) | 0.40 | 0.40 | Qwen3 `*-shared.env` |

Rules of thumb when adding a new model:

- **FP8 / INT8 weights:** start at 0.40 shared, 0.85 dedicated.
- **BF16 / FP16 weights:** start at 0.40–0.50 shared (only if the pair fits per the formula), 0.85 dedicated.
- **Edge unified memory (DGX Spark / Thor):** cap aggressively. Start with `0.40` for the DGX Spark Nano 9B NIM recipe and `0.25` for the Thor Edge 4B vLLM fallback; lower by `0.05` if startup or first inference reports memory pressure.
- **OOM at startup** → lower by 0.05. **OOM mid-inference** → also lower `NIM_MAX_MODEL_LEN` / `--max-model-len` and `NIM_MAX_NUM_SEQS`.

If you're unsure what fits, deploy `remote-all` (both LLM and VLM at remote endpoints) — no local sizing required.

## Env Overrides — Common Scenarios

### Minimal deploy (auto-detect hardware)

```json
{
  "HARDWARE_PROFILE": "<detected>",
  "VSS_APPS_DIR": "<repo>/deploy/docker",
  "VSS_DATA_DIR": "<repo>/data",
  "HOST_IP": "<detected>",
  "NGC_CLI_API_KEY": "<from env>"
}
```

> **Note on base URLs**: `LLM_BASE_URL` / `VLM_BASE_URL` must NOT end in `/v1`.
> The agent config appends `/v1` automatically. If the user gives you a URL
> with `/v1`, strip it before writing to the env.

### Remote LLM + local VLM

```json
{
  "HARDWARE_PROFILE": "<detected>",
  "VSS_APPS_DIR": "<repo>/deploy/docker",
  "VSS_DATA_DIR": "<repo>/data",
  "HOST_IP": "<detected>",
  "NGC_CLI_API_KEY": "<from env>",
  "LLM_MODE": "remote",
  "LLM_BASE_URL": "https://integrate.api.nvidia.com",
  "NVIDIA_API_KEY": "<key>"
}
```

### Remote LLM + remote VLM (`remote-all` — no local GPU for inference)

Fire this recipe when the user says *"deploy in remote-all mode"*,
*"both LLM and VLM are remote"*, or supplies two endpoint URLs (one per
role). Both mode vars MUST flip from the `.env` defaults
(`LLM_MODE=local_shared`, `VLM_MODE=local_shared`) to `remote`; leaving either
at `local_shared` keeps the local shared NIM `COMPOSE_PROFILES` active.

```json
{
  "HARDWARE_PROFILE": "<detected>",
  "VSS_APPS_DIR": "<repo>/deploy/docker",
  "VSS_DATA_DIR": "<repo>/data",
  "HOST_IP": "<detected>",
  "LLM_MODE": "remote",
  "LLM_BASE_URL": "<llm-endpoint-from-user>",
  "LLM_NAME":     "<llm-model-from-user>",
  "VLM_MODE": "remote",
  "VLM_BASE_URL": "<vlm-endpoint-from-user>",
  "VLM_NAME":     "<vlm-model-from-user>",
  "NVIDIA_API_KEY": "<key if endpoints require auth>"
}
```

If the user didn't provide endpoint URLs/models, **ask them** — don't
guess. For NVIDIA's public API: `https://integrate.api.nvidia.com` (strip
any trailing `/v1`). For launchpad-style internal endpoints, use the
exact URL they gave you.

Post-write sanity check:
```bash
grep -E '^(LLM_MODE|VLM_MODE|LLM_BASE_URL|VLM_BASE_URL|LLM_NAME|VLM_NAME)=' \
  deploy/docker/developer-profiles/dev-profile-base/generated.env
```
Expect six lines, all non-empty; `LLM_MODE=remote` and `VLM_MODE=remote`
must both appear. If either is `local_shared` or `local`, you did not
overwrite the template default — re-run the `sed` with the correct value.

### Dedicated GPUs (2-GPU system)

```json
{
  "HARDWARE_PROFILE": "<detected>",
  "VSS_APPS_DIR": "<repo>/deploy/docker",
  "VSS_DATA_DIR": "<repo>/data",
  "HOST_IP": "<detected>",
  "NGC_CLI_API_KEY": "<from env>",
  "LLM_MODE": "local",
  "VLM_MODE": "local",
  "LLM_DEVICE_ID": "0",
  "VLM_DEVICE_ID": "1"
}
```

### Different LLM model

```json
{
  "LLM_NAME": "nvidia/llama-3.3-nemotron-super-49b-v1.5",
  "LLM_NAME_SLUG": "llama-3.3-nemotron-super-49b-v1.5"
}
```

## COMPOSE_PROFILES (computed — do not set directly)

The `.env` file computes this from other variables:

```
COMPOSE_PROFILES=${BP_PROFILE}_${MODE},${BP_PROFILE}_${MODE}_${HARDWARE_PROFILE},llm_${LLM_MODE}_${LLM_NAME_SLUG},vlm_${VLM_MODE}_${VLM_NAME_SLUG}
```

Example resolved value:
```
bp_developer_base_2d,bp_developer_base_2d_DGX-SPARK,llm_remote_none,vlm_local_shared_cosmos-reason2-8b
```

The agent sets the upstream variables — `COMPOSE_PROFILES` is derived automatically.

## Endpoints (after deploy)

**Report the deployed public origin, not a raw container port.** Read it
directly from the running stack — `docker inspect vss-agent` exposes
`VSS_AGENT_EXTERNAL_URL`, the fully-assembled `proto://host:port` the agent
actually serves (orchestrator equivalent: `docker_read`). Don't synthesize a
`<HOST_IP>:<port>` URL — that surfaces an unreachable internal IP on Brev,
where this origin is the `https://7777-<id>.brevlab.com` secure link (see
[`brev.md`](brev.md)). Call that value `PUBLIC` below; everything is routed
through the HAProxy ingress at that origin.

| Service | URL to report (through ingress) |
|---|---|
| Agent UI | `${PUBLIC}/` |
| Agent REST API | `${PUBLIC}/api` |
| Reports | `${PUBLIC}/static/agent_report_<DATE>.md` |
| Phoenix telemetry | `${PUBLIC}/phoenix` |

**Direct service ports — internal only** (on-host `curl` debugging; not
browser-reachable on Brev, never report these as the access URL):

| Service | Direct port |
|---|---|
| Agent UI (direct) | `http://<HOST_IP>:3000/` |
| Agent REST API (direct) | `http://<HOST_IP>:8000/` |
| Swagger UI | `http://<HOST_IP>:8000/docs` — not routed through the ingress; direct/port-forward only |
| Phoenix (direct) | `http://<HOST_IP>:6006/` |

## Env File Location

```
<repo>/deploy/docker/developer-profiles/dev-profile-base/.env
<repo>/deploy/docker/developer-profiles/dev-profile-base/generated.env
```

## Debugging

After a base deploy is up, confirm the full pipeline (VST upload → VLM →
agent report) by driving a real query through the agent — e.g. ask it over
the REST API or UI to describe a video you've uploaded to VST. If the
agent returns a non-empty answer, the upload → ingest → inference → reply
path is healthy.

Common failure modes and what they mean for base:

| Symptom | Likely cause |
|---|---|
| `POST /api/v1/videos` HTTP 500 | Agent not finished starting — poll `/health` longer |
| VST `sensor/streams` stays empty | VST container unhealthy — check `docker logs vss-vios-ingress` |
| VST returns empty `sensor/streams` but VST container is healthy | Check Postgres health/logs with `docker logs vss-vios-postgres`. Current compose uses the named volume `vios_pg_data` for PGDATA, not a `$VSS_DATA_DIR` Postgres bind mount. See [`data-directory.md`](data-directory.md) before removing any volume. |
| WebSocket query returns `error_message` | LLM or VLM NIM not healthy — `docker logs nvidia-nemotron-nano-9b-v2` / `nvidia-cosmos-reason2-8b` |
| HITL prompt never arrives | `vss-agent` misconfigured HITL config — check `config.yml` |
| Empty report | VLM unreachable from inside `vss-agent` container — check `VLM_BASE_URL` in resolved compose env |

## Known Issues

- `cosmos-reason2-8b` NIM cannot restart after stop/crash — must redeploy full stack
- Reports are in-memory by default — lost on container restart (mount a volume to persist)
- `VLM_NIM_KVCACHE_PERCENT` defaults to `0.7` — may need tuning on memory-constrained GPUs
