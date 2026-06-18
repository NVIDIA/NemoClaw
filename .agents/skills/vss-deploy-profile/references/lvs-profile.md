# VSS LVS Profile — Reference

Profile: `lvs` | Blueprint: `bp_developer_lvs` | Mode: `2d`

Long-video summarization. The LLM stack is identical to `base` (`base.md`) — same supported models, same sizing math. **The VLM serving is different**: LVS no longer brings up a standalone Cosmos NIM; all VLM traffic goes through `rtvi-vlm` on port 8018, which loads the VLM checkpoint itself.

## What's different from `base`

- **No SDR, Envoy, or SDRC router.** VST sensor and ingress talk to **vss-vios-streamprocessing** on **:30001** directly (`STREAM_PROCESSOR_MODULE_ENDPOINT`, `VST_NGINX_MODE=vst-direct`). Alerts/search use **SDRC** on **:10000** instead.
- **No standalone VLM NIM service.** The `vlm_local_*_<slug>` compose profile is *not* enabled for LVS. The VLM lives inside the `rtvi-vlm` container.
- **`rtvi-vlm` (port 8018) is the VLM serving layer.** It can load a VLM checkpoint directly (integrated mode) or proxy to a remote OpenAI-compatible endpoint.
- **RT-VLM image tags:** x86 / Jetson-Tegra uses `nvcr.io/nvidia/vss-core/vss-rt-vlm:3.2.0`; SBSA / DGX Spark / Grace uses `nvcr.io/nvidia/vss-core/vss-rt-vlm:3.2.0-sbsa`.
- **Default integrated checkpoint:** `ngc:nim/nvidia/cosmos-reason2-8b:hf-1208`.
- **`VLM_NAME` is the model basename, NOT the friendly NIM name.** For the default integrated path: `VLM_NAME=nim_nvidia_cosmos-reason2-8b_hf-1208` (production-confirmed; using `nvidia/cosmos-reason2-8b` causes vss-lvs to return 400). Same caveat as alerts. Detail in [Default models](#default-models) and [Hard rules](#hard-rules).
- **GPU device for VLM is `RT_VLM_DEVICE_ID`** (defaults to `${VLM_DEVICE_ID:-0}` via the rtvi-vlm compose), not the standalone `VLM_DEVICE_ID`. In shared mode, LLM and RT-VLM both pin to GPU 0.

## What gets deployed

Container names below are the actual `container_name:` keys from `deploy/docker/services/**/compose.yml`. LLM NIM container is named after the selected model (default shown; varies with `LLM_NAME_SLUG`).

| Service | Container | Port | Purpose |
|---|---|---|---|
| VSS Agent | `vss-agent` | 8000 | Orchestrates tool calls and model inference |
| VSS Agent UI | `vss-agent-ui` | 3000 | Web UI — chat, video upload, views |
| VST Ingress | `vss-vios-ingress` | 30888 | Video storage + ingest |
| LLM NIM (default) | `nvidia-nemotron-nano-9b-v2` | 30081 | Same options as `base` (Nano 9B v2 default). Container name = `${LLM_NAME_SLUG}`. |
| **RT-VLM** | **`vss-rtvi-vlm`** | **8018** | **VLM runner — loads `MODEL_PATH` or proxies remote** |
| LVS service | `vss-lvs` | 38111, 38112 | Long-video segmentation + summarization |
| Shared Logstash | `logstash` | 9600 | Loads the `mdx-lvs` RTVI → Kafka → ES pipeline |
| Elasticsearch + Kibana | `elasticsearch`, `kibana` | 9200, 5601 | Log/event storage |
| Kafka | `kafka` | 9092 | Message broker (VLM captions topic: `mdx-vlm-captions`) |
| Redis | `redis` | 6379 | Cache |
| Phoenix | `phoenix` | 6006 | Observability |

Post-deploy readiness probe: `curl -sf http://${HOST_IP}:38111/v1/ready` should return exit 0 once `vss-lvs` is serving. The VSS Agent at `http://${HOST_IP}:8000/health` is the cross-profile readiness signal; this one confirms the LVS-specific microservice.

## Default models

| Role | `*_NAME` (env) | `*_NAME_SLUG` | Served by |
|---|---|---|---|
| LLM | `nvidia/nvidia-nemotron-nano-9b-v2` | `nvidia-nemotron-nano-9b-v2` | NIM (port 30081) |
| VLM | **`nim_nvidia_cosmos-reason2-8b_hf-1208`** | `cosmos-reason2-8b` | RT-VLM (port 8018), `MODEL_PATH=ngc:nim/nvidia/cosmos-reason2-8b:hf-1208` |

> **`VLM_NAME` must be the basename of `RTVI_VLM_MODEL_PATH` — NOT the friendly NIM name.** RT-VLM advertises this exact string in `/v1/models`, and the LVS service / agent calls the model by that id. Setting `VLM_NAME=nvidia/cosmos-reason2-8b` (the friendly NIM name) reproduces a real production bug: vss-lvs returns `400 BadParameters: No such model 'nvidia/cosmos-reason2-8b'` and summarization fails. **Always set `VLM_NAME=nim_nvidia_cosmos-reason2-8b_hf-1208` for the default integrated path.** Same caveat as `alerts.md`.

LLM alternates: same as base — `NVIDIA-Nemotron-Nano-9B-v2-FP8`, `nvidia/nvidia-nemotron-nano-9b-v2-dgx-spark` (DGX Spark only; see `edge.md`), `nemotron-3-nano`, `llama-3.3-nemotron-super-49b-v1.5`, `gpt-oss-20b`.

VLM alternates: see [VLM serving paths](#vlm-serving-paths) below.

## VLM serving paths

Pick the path that matches the user's VLM choice. Default is **integrated**.

### Path A — Integrated (RT-VLM loads the checkpoint itself)

Use this when the requested VLM is one of the integrated-supported set:

| VLM | `VLM_NAME` (must match `/v1/models` basename) | `VLM_NAME_SLUG` | `RTVI_VLM_MODEL_PATH` | `RTVI_VLM_MODEL_TO_USE` | Extra env |
|---|---|---|---|---|---|
| Cosmos Reason 2 8B (default) | `nim_nvidia_cosmos-reason2-8b_hf-1208` | `cosmos-reason2-8b` | `ngc:nim/nvidia/cosmos-reason2-8b:hf-1208` | `cosmos-reason` | — |
| Cosmos Reason 1 7B | `nim_nvidia_cosmos-reason1-7b_hf-<tag>` | `cosmos-reason1-7b` | `ngc:nim/nvidia/cosmos-reason1-7b:hf-<tag>` (confirm tag against rtvi-vlm release notes) | `cosmos-reason` | — |
| **Nemotron Nano V3 Omni 30B** ([build.nvidia.com](https://build.nvidia.com/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning)) | confirm via `curl http://${HOST_IP}:8018/v1/models` after RT-VLM boots (HF git: paths don't transform via the `nim_…` rule) | `nemotron-3-nano-omni-30b-a3b-reasoning` | `git:https://huggingface.co/nvidia/Nemotron-Nano-V3-Omni-GA0420-FP8` | `vllm-compatible` | `VLM_MODEL_SUPPORTS_AUDIO=true`, `VLM_TRUST_REMOTE_CODE=true`, `ENABLE_AUDIO=true` |

**`VLM_NAME` transformation rule (NGC NIM paths):** `ngc:nim/<org>/<model>:<tag>` → `nim_<org>_<model>_<tag>`. Drop the `ngc:` prefix; replace `/` and `:` with `_`. RT-VLM advertises this exact string in `/v1/models`. A mismatch produces `400 BadParameters: No such model …` from vss-lvs (production-confirmed bug, 2026-05-10).

For HF git paths (e.g. Nemotron Omni), the advertised name is determined by RT-VLM at load time — verify with `curl http://${HOST_IP}:8018/v1/models | jq` once it's healthy and copy that string verbatim into `VLM_NAME`.

To switch the integrated VLM, edit `deploy/docker/developer-profiles/dev-profile-lvs/generated.env`:

```bash
# Example — Cosmos Reason 1 7B
VLM_NAME=nim_nvidia_cosmos-reason1-7b_hf-<tag>           # matches /v1/models basename
VLM_NAME_SLUG=cosmos-reason1-7b
VLM_MODE=local_shared                                    # or local for dedicated GPU
RTVI_VLM_MODEL_PATH=ngc:nim/nvidia/cosmos-reason1-7b:hf-<tag>
RTVI_VLM_MODEL_TO_USE=cosmos-reason
```

`RTVI_VLM_ENDPOINT` stays empty in integrated mode — RT-VLM serves locally.

**Nemotron Omni — additional env.** The Omni model adds audio support and pulls weights from Hugging Face (not NGC), so it needs a small extra block in `dev-profile-lvs/generated.env`:

```bash
# Model selection
VLM_NAME=<copy from `curl http://${HOST_IP}:8018/v1/models | jq -r '.data[0].id'` after RT-VLM boots>
VLM_NAME_SLUG=nemotron-3-nano-omni-30b-a3b-reasoning
VLM_MODE=local_shared                                    # or local
RTVI_VLM_MODEL_PATH=git:https://huggingface.co/nvidia/Nemotron-Nano-V3-Omni-GA0420-FP8
RTVI_VLM_MODEL_TO_USE=vllm-compatible
HF_TOKEN=<token>                                         # weights gated on HF — request access first

# Audio (LVS feature flag + RT-VLM passthrough)
ENABLE_AUDIO=true                                        # LVS-side: enables audio ingest path
VLM_MODEL_SUPPORTS_AUDIO=true                            # RT-VLM container env: vLLM loads with audio modality
VLM_TRUST_REMOTE_CODE=true                               # Omni uses custom model code from the HF repo
```

> **Two-step deploy for Omni:** because the advertised `VLM_NAME` for HF git paths isn't deterministic, deploy once with a placeholder `VLM_NAME` (any value), wait for RT-VLM to boot and report ready, `curl /v1/models` to read the real id, then edit `VLM_NAME` and recreate the agent. The same approach applies if a future RT-VLM image changes the basename derivation rule for NIM paths.

`ENABLE_AUDIO` is an **LVS profile-level** env (read by the LVS agent / summarization service to enable the audio ingest path). It's wired up in upcoming PRs — set it whenever the chosen VLM advertises audio support, even if the underlying compose doesn't reference it yet (set-and-forget). `VLM_MODEL_SUPPORTS_AUDIO` and `VLM_TRUST_REMOTE_CODE` are RT-VLM container env vars that gate audio loading and trust HF custom code respectively.

> **MoE sizing caveat (Omni 30B-A3B).** Omni is a Mixture-of-Experts model — the name `30B-A3B` means 30 B total parameters with ~3 B active per token. The `weights × 1.3` formula in [`base.md`](base.md#sizing-math) uses **total** parameters, so on FP8 the resident weight footprint is ≈ `30 × 8 / 8 × 1.3 = 39 GB`. The model still needs the full weight set in VRAM even though only the active subset runs per token. Plan for ~40 GB just for weights, plus KV cache.

### Path B — Remote (RT-VLM proxies to an external VLM endpoint)

Use this when:

1. **The user supplied a remote VLM endpoint URL** (e.g. *"deploy LVS with VLM at `https://launchpad:11572` serving `cosmos-reason2-8b`"*), **OR**
2. **The local GPU can't fit the requested VLM alongside the LLM** per the sizing math (and the user has agreed to go remote — same two-trigger rule as [`base.md` § When to use remote LLM/VLM](base.md#when-to-use-remote-llmvlm)).

Edit `dev-profile-lvs/generated.env`:

```bash
VLM_MODE=remote
VLM_BASE_URL=<remote-endpoint>                           # no trailing /v1
VLM_NAME=<model-name-served-there>
RTVI_VLM_ENDPOINT=<remote-endpoint>/v1                   # WITH /v1 — RT-VLM-specific
RTVI_VLM_MODEL_TO_USE=openai-compat
RTVI_VLM_MODEL_PATH=none
NVIDIA_API_KEY=<key if required>
```

> **`/v1` quirk:** `VLM_BASE_URL` must NOT end in `/v1` (the agent appends it). `RTVI_VLM_ENDPOINT` MUST end in `/v1` (RT-VLM uses it verbatim). Don't mix them up.

### Path C — BYO local VLM (model not in the integrated set)

Use this when the user wants a VLM that RT-VLM can't load directly (e.g. Qwen3-VL, a third-party HF model, or an unreleased checkpoint).

1. Stand the VLM up as a separate service per [`base.md` § Swapping a different LLM/VLM](base.md#swapping-a-different-llmvlm) — either an in-tree NIM compose under `deploy/docker/services/nim/<slug>/` or a DLFW vLLM compose. The service must expose an OpenAI-compatible endpoint.
2. Point RT-VLM at the local URL using **Path B's env vars**, with `VLM_BASE_URL` / `RTVI_VLM_ENDPOINT` set to the localhost address (e.g. `http://${HOST_IP}:30082`).

This is "remote mode pointed at a local container" — keep `VLM_MODE=remote` so RT-VLM doesn't try to load the model itself.

## Sizing — RT-VLM-specific knobs

For VLM **weight cost** (params × bits ÷ 8 × 1.3) and the general formula, see [`base.md` § Sizing math](base.md#sizing-math) — it applies unchanged. RT-VLM's own runtime is a thin wrapper around vLLM, so weights still dominate.

The RT-VLM container reads sizing knobs from `dev-profile-lvs/.env` with the `RTVI_VLM_` / `RTVI_VLLM_` prefix; they propagate inside the container as the standard vLLM env vars (see `deploy/docker/services/rtvi/rtvi-vlm/rtvi-vlm-docker-compose.yml`).

| `dev-profile-lvs/.env` var | Inside-container var | Default | Purpose |
|---|---|---|---|
| `RTVI_VLLM_GPU_MEMORY_UTILIZATION` | `VLLM_GPU_MEMORY_UTILIZATION` | empty (vLLM default ≈ 0.9) | **Primary sizing knob.** Fraction of total GPU memory RT-VLM may use — weights + KV cache + activations included. Same semantics as `--gpu-memory-utilization` and `NIM_KVCACHE_PERCENT` (see [`base.md`](base.md#nim_kvcache_percent--gb-on-common-gpus)). |
| `RTVI_VLM_MAX_MODEL_LEN` | `VLM_MAX_MODEL_LEN` | `32768` | Max context length. Lower this first when OOM mid-inference. |
| `RTVI_VLLM_MAX_NUM_SEQS` | `VLLM_MAX_NUM_SEQS` | `256` | Max concurrent sequences. Lower if KV cache thrashes under load. |
| `RTVI_VLLM_MAX_NUM_BATCHED_TOKENS` | `VLLM_MAX_NUM_BATCHED_TOKENS` | `5120` | Per-step token budget for chunked prefill. |
| `RTVI_VLM_NUM_VLM_PROCS` | `NUM_VLM_PROCS` | empty (1) | Parallel VLM worker processes (rare to change). |
| `VSS_NUM_GPUS_PER_VLM_PROC` | `VSS_NUM_GPUS_PER_VLM_PROC` | empty | Tensor parallelism for the VLM. Set when the VLM is too big for one GPU. |
| `RT_VLM_DEVICE_ID` | (compose `device_ids`) | `${VLM_DEVICE_ID:-0}` | Which GPU RT-VLM pins to. In shared mode set this equal to `LLM_DEVICE_ID`. |

The sizing flow is identical to base: pick the fraction with the formula in [`base.md`](base.md#sizing-math), write it into `dev-profile-lvs/generated.env` (one place — there is no per-hardware `hw-*.env` for RT-VLM), re-resolve the compose, deploy, watch the rtvi-vlm logs for `Maximum concurrency for X tokens per GPU: Y x` to confirm the KV-cache budget.

## LVS-specific write location for the worked example

Run the math from [`base.md` § Worked example](base.md#worked-example--nemotron-nano-9b--cosmos-reason2-8b-on-h100-80-gb-shared) — the fractions are identical. The only LVS-specific bit is **where** the VLM fraction is written:

```bash
# LLM — same file as base
# deploy/docker/services/nim/nvidia-nemotron-nano-9b-v2/hw-H100-shared.env
NIM_KVCACHE_PERCENT=0.449

# VLM — RT-VLM, in the LVS profile env
# deploy/docker/developer-profiles/dev-profile-lvs/generated.env
RTVI_VLLM_GPU_MEMORY_UTILIZATION=0.40
RT_VLM_DEVICE_ID=0
LLM_DEVICE_ID=0
LLM_MODE=local_shared
VLM_MODE=local_shared
```

For dedicated mode, set `LLM_DEVICE_ID=0`, `RT_VLM_DEVICE_ID=1`, leave `RTVI_VLLM_GPU_MEMORY_UTILIZATION` empty (RT-VLM gets the whole GPU 1 at vLLM's default ~0.9).

## Hard rules

- **`VLM_NAME` must equal RT-VLM's `/v1/models` basename.** This is the single most important field for LVS to function. For the default integrated Cosmos2: `VLM_NAME=nim_nvidia_cosmos-reason2-8b_hf-1208`. Using the friendly NIM name `nvidia/cosmos-reason2-8b` causes vss-lvs to return `400 BadParameters: No such model …` and summarization fails — confirmed in production (2026-05-10). Transformation rule for NGC NIM paths: `ngc:nim/<org>/<model>:<tag>` → `nim_<org>_<model>_<tag>`. For HF git paths or any custom MODEL_PATH, verify by `curl http://${HOST_IP}:8018/v1/models | jq` after RT-VLM boots and copy the `id` field.
- **L40S (48 GB) cannot host the LLM + RT-VLM shared.** 23.4 + 20.8 = 44.2 GB > 40.8 GB usable. Use a 2-GPU L40S host (LLM on device 0, RT-VLM on device 1) or escalate to the user about a remote VLM (Path B).
- **RT-VLM image tag must match the CPU platform.** x86 and Jetson-Tegra platforms, including AGX/IGX Thor, use `RTVI_VLM_IMAGE_TAG=3.2.0` (`nvcr.io/nvidia/vss-core/vss-rt-vlm:3.2.0`). SBSA server-ARM platforms, including DGX Spark and Grace, use `RTVI_VLM_IMAGE_TAG=3.2.0-sbsa` (`nvcr.io/nvidia/vss-core/vss-rt-vlm:3.2.0-sbsa`). LLM-side, follow `edge.md`: DGX Spark uses the standalone DGX Spark Nano 9B NIM, while AGX/IGX Thor still uses the Edge 4B fallback.
- **Don't co-deploy a standalone Cosmos NIM with RT-VLM.** The standalone `vlm_local_*_cosmos-reason2-8b` profile must NOT be active for LVS. Verify by checking that `resolved.yml` doesn't have a `cosmos-reason2-8b` or `cosmos-reason2-8b-shared-gpu` service alongside `rtvi-vlm`.
- **`VLM_MODE=remote` ⇒ `RTVI_VLM_MODEL_PATH=none`.** Forgetting this leaves RT-VLM trying to load weights AND proxy at the same time → startup hang or OOM.
- **`/v1` suffix mismatch.** `VLM_BASE_URL` no `/v1`; `RTVI_VLM_ENDPOINT` yes `/v1`. The skill should always write both consistently when going remote.

## Key capabilities

- Quickly generate a high-level narrative summary of a long video
- Extract timestamped highlights based on user-defined events
- Processes uploaded files from minutes to hours in duration
- Results returned through the AI agent chat interface
- Human-in-the-loop (HITL) prompt editing for report generation

## Endpoints (after deploy)

See [`base.md` — Endpoints](base.md#endpoints-after-deploy) for how `${PUBLIC}` is resolved and Brev secure-link behavior. Rows marked *(direct)* are on-host only, not browser-reachable on Brev.

| Service | URL to report (through ingress) |
|---|---|
| Agent UI | `${PUBLIC}/` |
| Agent REST API | `${PUBLIC}/api` |
| Kibana | `${PUBLIC}/kibana` |
| Phoenix | `${PUBLIC}/phoenix` |
| RT-VLM (direct) | `http://<HOST_IP>:8018/v1/` (OpenAI-compatible) |

## Env file location

```
deploy/docker/developer-profiles/dev-profile-lvs/.env
deploy/docker/developer-profiles/dev-profile-lvs/generated.env
```

## Debugging

- **`docker logs vss-rtvi-vlm`** — startup takes up to 20 min on first run (model download from NGC). Look for `Maximum concurrency for X tokens per GPU: Y x` to confirm vLLM is up and the KV-cache budget is what you set.
- **`vss-lvs` returns `400 BadParameters: No such model '<id>'`** (summarization fails in the UI) — `VLM_NAME` doesn't match what RT-VLM advertises. Verify with `curl http://${HOST_IP}:8018/v1/models | jq`; the `id` field must equal `VLM_NAME` in `dev-profile-lvs/generated.env` (the deployed values). For the default integrated path that's `nim_nvidia_cosmos-reason2-8b_hf-1208` (NOT `nvidia/cosmos-reason2-8b`). Fix → `docker compose --env-file <env> -f resolved.yml up -d --no-deps --force-recreate vss-lvs vss-agent`. If the same UI chat thread is stuck in the failed-tool loop, refresh or start a fresh prompt.
- **VLM never produces summaries** — check that the topic `mdx-vlm-captions` is being written. `docker exec kafka kafka-console-consumer --bootstrap-server localhost:9092 --topic mdx-vlm-captions --max-messages 1`.
- **Empty Kibana dashboards** — shared `logstash` may have failed to load the `mdx-lvs` pipeline or protobuf codec; `docker logs logstash` should show pipeline startup for `mdx-lvs-logstash.conf`.
- **OOM in RT-VLM under load** — lower `RTVI_VLLM_GPU_MEMORY_UTILIZATION` by 0.05; if that doesn't help, drop `RTVI_VLM_MAX_MODEL_LEN` to `16384` and `RTVI_VLLM_MAX_NUM_SEQS` to `64`.
