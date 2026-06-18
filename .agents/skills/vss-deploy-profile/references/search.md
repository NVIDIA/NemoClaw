# VSS Search Profile — Reference

Profile: `search` | Blueprint: `bp_developer_search` | Mode: `2d`

> **Alpha feature** — not recommended for production.

Semantic video search via Cosmos Embed1 embeddings indexed in Elasticsearch. The Search workflow uses an optional **Critique agent** that re-checks retrieval results — this requires a VLM endpoint (local or remote).

## What's different from `base` and `lvs`

- **Three always-on GPU services:** `rtvi-cv` (DeepStream perception), `rtvi-embed` (Cosmos Embed1 embeddings), and the **LLM**. There is no Cosmos VLM NIM in the default LVS-style integrated path; the VLM is only deployed when the Critique agent needs it.
- **Critique agent needs a VLM.** If the user enables Critique (default in the UI: `use_critic=true`), the deploy must provide a reachable VLM endpoint — either remote or co-located on the available GPUs.
- **LLM shares its GPU with RT-Embed by default.** Reference `dev-profile-search/.env` defaults: `RT_CV_DEVICE_ID=0`, `RT_EMBED_DEVICE_ID=1`, `LLM_DEVICE_ID=1`, `VLM_DEVICE_ID=2`. The LLM must leave headroom for RT-Embed on GPU 1.

## What gets deployed

Container names below are the actual `container_name:` keys from `deploy/docker/services/**/compose.yml`. LLM/VLM NIM containers are named after the selected model (default shown; varies with `LLM_NAME_SLUG` / `VLM_NAME_SLUG`).

| Service | Container | Port | Purpose |
|---|---|---|---|
| RT-CV (DeepStream perception) | `vss-rtvi-cv` | — (host net) | Object detection / tracking on incoming streams; default model family `rtdetr-warehouse` |
| RT-Embed (Cosmos Embed1) | `vss-rtvi-embed` | 8017 | Video + text embedding generation |
| LLM NIM (default) | `nvidia-nemotron-nano-9b-v2` | 30081 | Same options as `base` (Nano 9B v2 default). Container name = `${LLM_NAME_SLUG}`. |
| VLM | depends on placement; default `nvidia-cosmos-reason2-8b` (NIM) or `vss-rtvi-vlm` (RT-VLM) | 30082 (NIM) / 8018 (RT-VLM) | **Only if Critique enabled** — see [VLM placement](#vlm-placement) |
| VSS Agent | `vss-agent` | 8000 | Orchestrates tool calls, embed search, critique |
| VSS Agent UI | `vss-agent-ui` | 3000 | Search tab |
| VST Ingress | `vss-vios-ingress` | 30888 | Video storage + ingest |
| Elasticsearch + Logstash + Kibana | `elasticsearch`, `logstash`, `kibana` | 9200, 5601 | Index, ingest pipeline, dashboards |
| Kafka | `kafka` | 9092 | Embedding pipeline message bus |
| Phoenix | `phoenix` | 6006 | Observability |

## Default models

| Role | Model | Slug | Served by |
|---|---|---|---|
| LLM | `nvidia/nvidia-nemotron-nano-9b-v2` | `nvidia-nemotron-nano-9b-v2` | NIM (port 30081) |
| Embed (RT-Embed) | `nvidia/Cosmos-Embed1-448p-anomaly-detection` | — | RT-Embed (port 8017), `MODEL_PATH=git:https://huggingface.co/nvidia/Cosmos-Embed1-448p-anomaly-detection` |
| Perception (RT-CV) | siglip2 v1.1 + RTDETR (warehouse) | — | RT-CV (DeepStream pipeline) |
| VLM (only when Critique on) | `nvidia/cosmos-reason2-8b` (default) | `cosmos-reason2-8b` | NIM or RT-VLM — see [VLM placement](#vlm-placement) |

## VLM placement

Decide where the VLM goes **before writing any env**. Pick the first option that applies, in order.

```
Critique disabled?                                   → no VLM at all; skip this section
   │
   ▼
User supplied a remote VLM endpoint?                 → Path A: Remote VLM
   │
   ▼
DEFAULT — co-locate VLM on GPU 0 with RT-CV          → Path B: VLM shares GPU 0
   │                                                          (NUM_STREAMS=16 on H100/RTX PRO 6000;
   │                                                           NUM_STREAMS=8 on L40S/A40/Thor/GB10)
   ▼
User explicitly wants a 3rd GPU layout
AND a 3rd GPU is free?                               → Path C: VLM on dedicated 3rd GPU
```

The default placement is **Path B** — co-locate VLM on GPU 0 with RT-CV. Big GPUs (H100, RTX PRO 6000) hold the default `NUM_STREAMS=16` even with the VLM co-resident; smaller GPUs (L40S, A40, Thor, GB10) need `NUM_STREAMS=8` to leave VRAM for the VLM. This works on every supported 2- or 3-GPU host without escalation.

Path C is rarely needed — only when the user explicitly asks for the dedicated-GPU layout (e.g. they have a 3rd GPU sitting idle and want to keep RT-CV's GPU 0 untouched).

If even the per-GPU default doesn't fit (very large VLM, or smaller GPU than the supported set), drop `NUM_STREAMS` further but **confirm with the user before going below 8** — the perception pipeline becomes throughput-limited and the user should know. If even `NUM_STREAMS=1` won't close the math, escalate to Path A (remote) per the two-trigger rule in [`base.md` § When to use remote LLM/VLM](base.md#when-to-use-remote-llmvlm).

### Path A — Remote VLM (user supplied)

Triggered when the user provides a VLM endpoint URL or asks for `remote-vlm` / `remote-all`. Edit `dev-profile-search/generated.env`:

```bash
VLM_MODE=remote
VLM_BASE_URL=<remote-endpoint>                           # no trailing /v1
VLM_NAME=<model-name-served-there>
NVIDIA_API_KEY=<key if required>
# Free up the device that would otherwise host VLM
VLM_DEVICE_ID=                                           # unused in remote mode
```

The Critique agent points the VLM tool at `${VLM_BASE_URL}/v1`. No local VLM container is started.

### Path B — Default: co-locate VLM on GPU 0 with RT-CV

This is the default placement for any 2- or 3-GPU host without a remote VLM. Put the VLM on GPU 0 next to RT-CV. `NUM_STREAMS` depends on the GPU:

| GPU | `NUM_STREAMS` (Path B default) | Reason |
|---|---|---|
| H100 80 GB SXM/HBM3 | **16** | 80 GB has plenty of room for VLM + RT-CV at full throughput |
| H100 PCIe / NVL (80 GB) | **16** | Same |
| RTX PRO 6000 (Blackwell, 96 GB) | **16** | Same |
| L40S (48 GB) | **8** | 48 GB needs RT-CV halved to leave VRAM for the VLM |
| A40 (48 GB) | **8** | Same |
| Thor / GB10 (DGX Spark, ≤ 64 GB unified) | **8** | Edge — unified memory, smaller VLM headroom |

Edit `dev-profile-search/generated.env`:

```bash
RT_CV_DEVICE_ID=0
RT_EMBED_DEVICE_ID=1
LLM_DEVICE_ID=1                                          # LLM shares GPU 1 with RT-Embed
VLM_DEVICE_ID=0                                          # VLM shares GPU 0 with RT-CV
LLM_MODE=local_shared
VLM_MODE=local_shared
NUM_STREAMS=16                                           # 16 on H100/RTX PRO 6000; 8 on L40S/A40/Thor/GB10
```

**Sizing logic for GPU 0 (RT-CV + VLM):**

1. **Compute the VLM budget.** From [`base.md` § Sizing math](base.md#sizing-math) — VLM weights × 1.3. E.g. Cosmos Reason2 8B at FP16 ≈ 20.8 GB; Cosmos Reason1 7B ≈ 18.2 GB.
2. **Set `NIM_KVCACHE_PERCENT` on the VLM** = `VLM_total / GPU_VRAM`, rounded up by 0.05 for headroom. H100 80 GB with CR2: 20.8 / 80 = 0.26 → set **0.30**. L40S 48 GB with CR2: 20.8 / 48 = 0.43 → set **0.45**.
3. **RT-CV takes the rest.** RT-CV doesn't have a `--gpu-memory-utilization` knob — it consumes whatever's free, scaled by `NUM_STREAMS`. With the per-GPU defaults above, it sits comfortably alongside any standard VLM.
4. **Verify with logs.** `docker logs vss-rtvi-cv` for OOM, `docker logs <vlm>` for the KV-cache report. If RT-CV drops frames, lower `NUM_STREAMS` further (with user confirmation if going below 8).

**`NUM_STREAMS=8` is the agent's floor.** If the per-GPU default doesn't fit (e.g. an unsupported small GPU, or a much larger VLM than the standard set), **stop and ask the user** before lowering past 8 — going below 8 means real perception throughput loss. The user should pick between (a) accepting fewer streams, (b) switching to a smaller VLM (CR1 7B vs CR2 8B), or (c) Path A (remote VLM). Same two-trigger rule as [`base.md` § When to use remote LLM/VLM](base.md#when-to-use-remote-llmvlm).

**Escalate to Path A automatically** only if even `NUM_STREAMS=1` can't close — i.e. VLM resident size > 0.85 × GPU_VRAM. The standard CR1/CR2/Qwen3-VL set never hits that on H100 80 GB; on L40S 48 GB a Cosmos2 FP16 VLM fits with NUM_STREAMS=8 and no escalation needed.

### Path C — VLM on a dedicated 3rd GPU (full RT-CV throughput)

Use this when the user explicitly wants the full `NUM_STREAMS=16` perception throughput **and** has a 3rd GPU free. Edit `dev-profile-search/generated.env`:

```bash
RT_CV_DEVICE_ID=0
RT_EMBED_DEVICE_ID=1
LLM_DEVICE_ID=1                                          # shares GPU 1 with RT-Embed
VLM_DEVICE_ID=2                                          # dedicated
LLM_MODE=local_shared                                    # LLM + RT-Embed share GPU 1
VLM_MODE=local                                           # VLM gets GPU 2 alone
NUM_STREAMS=16                                           # full throughput — RT-CV has GPU 0 to itself
```

Sizing notes:

- **GPU 0 (RT-CV) — full GPU.** With no co-resident, RT-CV's DeepStream pipeline runs `NUM_STREAMS=16` comfortably on any supported GPU (H100, RTX PRO 6000, L40S). The upstream perf guide doesn't publish a single GB number for RT-CV; the [RT-Embed max-streams table](#rt-embed-sizing) is for the embedding service, not perception. If you push beyond 16 streams, watch GPU 0 utilization with `nvidia-smi -l 5` and back off if it saturates.
- **GPU 1 (LLM + RT-Embed)** — for the default Cosmos-Embed1 (Triton/ONNX), no util override is needed. The LLM keeps a normal `NIM_KVCACHE_PERCENT` per the per-GPU table in [Worked example](#worked-example--llm--rt-embed-on-gpu-1). Only override RT-Embed's `VLLM_GPU_MEMORY_UTILIZATION` if you've switched to `VLM_MODEL_TO_USE=vllm-compatible` — see [RT-Embed sizing](#rt-embed-sizing) below.
- **GPU 2 (VLM) — dedicated.** Use the relevant compose under `nim/<vlm-slug>/` per [`base.md` § Swapping a different LLM/VLM](base.md#swapping-a-different-llmvlm). For default `cosmos-reason2-8b` at FP16, NIM defaults are fine.

## Sizing — RT-Embed and RT-CV knobs

For VLM and LLM weight cost + the general formula, see [`base.md` § Sizing math](base.md#sizing-math). RT-Embed and RT-CV add their own knobs.

### RT-Embed sizing

Image: `nvcr.io/nvidia/vss-core/vss-rt-embed:3.2.0` (SBSA: `3.2.0-sbsa`). Compose: `deploy/docker/services/rtvi/rtvi-embed/rtvi-embed-docker-compose.yml`.

Per the upstream `perf/benchmark/rtvi_embed_gpu_initial_stream_counts.json`, the **dedicated-GPU ceiling** — max concurrent streams when RT-Embed has the GPU to itself with **no co-resident** model:

| GPU | Max streams (RT-Embed dedicated) |
|---|---|
| H100 80 GB SXM / HBM3 | **140** |
| H100 80 GB PCIe | 100 |
| H100 NVL | 100 |
| RTX PRO 6000 (Blackwell) | 120 |
| L40S | 60 |
| A40 | 30 |
| Thor / GB10 (DGX Spark) | 30 |

These are upper bounds for the dedicated case (any layout where you give RT-Embed its own GPU and nothing else co-locates). The default search layout always has the LLM co-resident on RT-Embed's GPU, so the practical ceiling is lower — but with the 10-GB RT-Embed budget in [Worked example](#worked-example--llm--rt-embed-on-gpu-1), `NUM_STREAMS=16` runs comfortably on all H100/RTX PRO 6000 configs, and `NUM_STREAMS=8` is the safe value on L40S / Thor / GB10.

Knobs (in `dev-profile-search/.env` unless noted):

| Var | Inside-container | Default | Effect |
|---|---|---|---|
| `MODEL_PATH` | `MODEL_PATH` | `git:https://huggingface.co/nvidia/Cosmos-Embed1-448p-anomaly-detection` | Embedding checkpoint. Variants: `Cosmos-Embed1-224p`, `-336p`, `-448p` (smaller resolution = smaller VRAM). |
| `RTVI_EMBED_MODEL` | (label) | `cosmos-embed1-448p-anomaly-detection` | Identifier used by the agent. |
| `NUM_STREAMS` | (RT-CV only — see below) | `16` | Concurrent stream count target for the whole pipeline. |
| `RTVI_EMBED_NUM_VLM_PROCS` | `NUM_VLM_PROCS` | `10` | Parallel embedding workers. More procs = more throughput, more VRAM per process. |
| `VLM_BATCH_SIZE` | `VLM_BATCH_SIZE` | auto (3 / 16 / 64 / 128 by GPU mem) | Batch size for inference. Auto-clamps to GPU capacity. |
| `RTVI_EMBED_NUM_GPUS` / `VSS_NUM_GPUS_PER_VLM_PROC` | `NUM_GPUS` | empty (1) | Multi-GPU distribution per embed process. |
| `RT_EMBED_DEVICE_ID` | (compose `device_ids`) | `1` | Which GPU RT-Embed pins to. |
| `RTVI_EMBED_TAG` | (image tag) | `3.2.0` | x86 / iGPU. For DGX Spark: use the published `3.2.0-sbsa` variant when available. |

**Default Cosmos-Embed1 deployment runs on Triton (ONNX), not vLLM.** From `start_rtvi_embed.sh:47-49` and `src/models/custom/samples/cosmos-embed1/inference.py:55-56`, the default `VLM_MODEL_TO_USE=custom` loads Cosmos-Embed1 via Triton-served ONNX models (`text_embeddings`, `video_embeddings`). For that path:

- **No KV cache** — embedding inference is single-pass through an encoder; there's no autoregressive generation, so vLLM's KV-cache concepts don't apply. There is nothing to disable.
- **`VLLM_GPU_MEMORY_UTILIZATION` is a no-op** when serving the default Cosmos-Embed1. The start script sets it to 0.7 for ≤50 GB GPUs and the Python wrapper's fallback is also 0.7, but the Triton/ONNX path doesn't read it.
- **Memory is governed by Triton runtime + ONNX weights + per-stream activation buffers**, scaling with `NUM_STREAMS`, `NUM_VLM_PROCS`, and `VLM_BATCH_SIZE`. Cosmos-Embed1 (~1 B params at FP16 ≈ 2 GB weights) is small; the dominant cost on big concurrency is per-stream buffers and the decoder workers.

**`VLLM_GPU_MEMORY_UTILIZATION` IS relevant** only when `VLM_MODEL_TO_USE=vllm-compatible` is set — i.e. when RT-Embed is loading a vLLM-served model instead of Cosmos-Embed1 (uncommon for Search; relevant for the LVS Nemotron Omni path). In that case the same `weights + KV + activations` semantics as [`base.md`](base.md#nim_kvcache_percent--gb-on-common-gpus) apply, and the shared-GPU override discussion in [Worked example](#worked-example--llm--rt-embed-on-gpu-1) below applies.

**For the default search shared layout (LLM + Cosmos-Embed1 on GPU 1)**, **budget 10 GB for RT-Embed and give the LLM the rest** — `NIM_KVCACHE_PERCENT = (GPU_VRAM - 10) / GPU_VRAM - 0.15`. See the [worked example](#worked-example--llm--rt-embed-on-gpu-1) for the per-GPU table. No RT-Embed util override is needed; the env var is a no-op for the default Cosmos-Embed1 model.

### RT-CV sizing

Image: `nvcr.io/nvidia/vss-core/vss-rt-cv:3.2.0` (SBSA: `3.2.0-sbsa`). Compose: `deploy/docker/services/rtvi/rtvi-cv/compose.yaml`.

RT-CV is a **DeepStream perception pipeline**, not a vLLM container. It has no `--gpu-memory-utilization`-style knob. Memory scales with stream count and the active model family.

Knobs (in `dev-profile-search/.env`):

| Var | Default | Effect |
|---|---|---|
| `NUM_STREAMS` | `16` | Concurrent video streams in the perception pipeline. Single biggest VRAM driver. |
| `DS_MODEL_FAMILY` | `rtdetr-warehouse` | Detection model family. Other variants change weight footprint. |
| `DS_MODE_FLAG` | `1` | DeepStream mode. |
| `DS_MESSAGE_RATE` | `1` | Inference messages per second per stream. |
| `DS_TRACKER_REID` | `false` | Enable re-identification (extra VRAM). |
| `VISION_ENCODER_MODEL` | `siglip_v2` | Vision encoder downloaded by `perception-2d-init`. |
| `RT_CV_DEVICE_ID` | `0` | Which GPU RT-CV pins to. |
| `PERCEPTION_TAG` | `3.2.0` | Image tag (use `-sbsa-` variant on DGX Spark). |

The upstream perf guide doesn't publish a single GB number — it publishes per-GPU max stream counts (consistent with the table above for RT-Embed). Treat **`NUM_STREAMS=16`** as a starting point on H100 / RTX PRO 6000 / L40S; lower it on smaller GPUs or when co-locating with a VLM.

## Worked example — LLM + RT-Embed on GPU 1

Default layout, Nano 9B v2 LLM + Cosmos-Embed1 on GPU 1.

**RT-Embed budget rule of thumb: 10 GB.** Cosmos-Embed1 weights are ~2 GB (1 B params at FP16); the rest is per-stream activation buffers, decoder workers, and Triton/ONNX runtime overhead. 10 GB is a comfortable budget for `NUM_STREAMS=16` on any GPU. Reserve those 10 GB and give the LLM the rest, leaving the standard 15% framework headroom.

| GPU | VRAM | RT-Embed reserved | Framework (15%) | LLM gets | `NIM_KVCACHE_PERCENT` |
|---|---|---|---|---|---|
| H100 / A100-80 | 80 GB | 10 GB | 12 GB | 58 GB | **0.72** |
| H200 | 141 GB | 10 GB | 21 GB | 110 GB | **0.78** |
| RTX PRO 6000 (Blackwell) | 96 GB | 10 GB | 14 GB | 72 GB | **0.75** |
| L40S | 48 GB | 10 GB | 7 GB | 31 GB | **0.65** (tight — verify under load) |

Formula: `NIM_KVCACHE_PERCENT = (GPU_VRAM - 10) / GPU_VRAM - 0.15`, rounded to 2 decimals.

Two writes:

```bash
# 1. In deploy/docker/services/nim/nvidia-nemotron-nano-9b-v2/hw-H100-shared.env
NIM_KVCACHE_PERCENT=0.72             # LLM gets ~58 GB; leaves 10 GB for RT-Embed + 12 GB framework

# 2. In deploy/docker/developer-profiles/dev-profile-search/generated.env
RT_EMBED_DEVICE_ID=1
LLM_DEVICE_ID=1
LLM_MODE=local_shared
NUM_STREAMS=16
RTVI_EMBED_NUM_VLM_PROCS=            # leave default (10)
# No VLLM_GPU_MEMORY_UTILIZATION override needed — Cosmos-Embed1 uses Triton/ONNX
# (the env var is a no-op for the default model). Override only if you switch
# RT-Embed to VLM_MODEL_TO_USE=vllm-compatible.
```

That's it. No compose-file tweak required for the default Cosmos-Embed1 deployment.

**If you've switched RT-Embed to a vllm-compatible model** (rare — would happen if you load a vLLM-served embedding model instead of Cosmos-Embed1), then you also need to cap RT-Embed's `VLLM_GPU_MEMORY_UTILIZATION`. Compute it from the 10 GB budget: `10 / GPU_VRAM` ≈ `0.13` on H100. Add a passthrough to `rtvi-embed-docker-compose.yml`'s `environment:` block (`VLLM_GPU_MEMORY_UTILIZATION: "${RTVI_EMBED_VLLM_GPU_MEMORY_UTILIZATION:-}"`) and set `RTVI_EMBED_VLLM_GPU_MEMORY_UTILIZATION=0.13` in the profile env.

> **Verifying under load.** Watch `docker logs vss-rtvi-embed` and `nvidia-smi -l 5` on GPU 1 while pushing `NUM_STREAMS=16` of test video. If RT-Embed's resident memory exceeds ~12 GB, raise the budget (e.g. 12 → 15 GB → recompute LLM `NIM_KVCACHE_PERCENT`). If the LLM OOMs at startup, it usually means RT-Embed grabbed more than 10 GB before the LLM allocated; constrain RT-Embed by lowering `NUM_STREAMS` or `RTVI_EMBED_NUM_VLM_PROCS` (10 → 4).

For Path B (default — VLM on GPU 0 with RT-CV), the math is on GPU 0 instead: budget the VLM via [`base.md`](base.md#sizing-math), set its `NIM_KVCACHE_PERCENT` to `VLM_total / GPU_VRAM` rounded up, and let RT-CV consume the rest at the per-GPU `NUM_STREAMS` (16 on H100/RTX PRO 6000, 8 on L40S/A40/Thor/GB10). See [Path B](#path-b--default-co-locate-vlm-on-gpu-0-with-rt-cv) above.

## Hard rules

- **Critique enabled ⇒ a VLM endpoint must be reachable.** UI default is `use_critic=true`; the agent will fail at query time if no VLM is configured. Either set up Path A/B/C, or document with the user that they need to disable Critique in the UI.
- **L40S (48 GB) cannot host LLM + RT-Embed shared at FP16.** Move to a 2-GPU host (LLM on its own GPU) or pick FP8 LLM. Then the VLM placement question still applies; on 2× L40S, both GPUs are taken by RT-Embed and LLM/VLM, so RT-CV gets a 3rd GPU — escalate per Path A if not available.
- **Edge platforms (DGX Spark / Thor) are not supported for `search` yet** — track upstream blueprint for support. Use SBSA image tags (`-sbsa-`) when they land.
- **`RESERVED_DEVICE_IDS` and `FIXED_SHARED_DEVICE_IDS` come from defaults** in `dev-profile-search/.env` (`'0'` and `'1'` respectively). They tell `dev-profile.sh` which devices not to reassign — the skill works at the env-file level, so leave them as-is unless changing the layout meaningfully (e.g. swapping which GPU hosts RT-CV vs RT-Embed).
- **`/v1` quirk** — `LLM_BASE_URL` / `VLM_BASE_URL` no `/v1` (agent appends). RT-VLM-style `RTVI_VLM_ENDPOINT` (only relevant if you use RT-VLM as the critique VLM) yes `/v1`.

## Key capabilities

- Upload videos; embeddings are generated automatically by RT-Embed.
- Natural language queries (e.g. "find all instances of forklifts") use Cosmos-Embed1's joint video/text embedding space.
- Filter results by similarity score, time range, video name, description, source.
- Timestamped results with clip playback in the UI.
- Critique agent re-checks top retrieval results via the VLM (default-on; toggle in the UI sidebar).

## Endpoints (after deploy)

See [`base.md` — Endpoints](base.md#endpoints-after-deploy) for how `${PUBLIC}` is resolved and Brev secure-link behavior. Rows marked *(direct)* are on-host only, not browser-reachable on Brev.

| Service | URL to report (through ingress) |
|---|---|
| Agent UI | `${PUBLIC}/` |
| Agent REST API | `${PUBLIC}/api` |
| Kibana | `${PUBLIC}/kibana` |
| Phoenix | `${PUBLIC}/phoenix` |
| nvstreamer | own secure link `https://31000-<id>.brevlab.com` on Brev (see [`brev.md`](brev.md)); else `http://<HOST_IP>:31000/` |
| RT-Embed (direct) | `http://<HOST_IP>:8017/` |
| Elasticsearch (direct) | `http://<HOST_IP>:9200/` |
| VLM (direct, Path B/C) | `http://<HOST_IP>:30082/v1/` (NIM) or `http://<HOST_IP>:8018/v1/` (RT-VLM) |

## Env file location

```
deploy/docker/developer-profiles/dev-profile-search/.env
deploy/docker/developer-profiles/dev-profile-search/generated.env
```

## Stage perception models (RT-DETR warehouse)

**MUST run before `docker compose --env-file <env> -f resolved.yml up -d`.** The compose's `perception-2d-init` container only fetches the SigLIP vision encoder. The RT-DETR detector model that RT-CV needs is staged separately by `dev-profile.sh` — and since this skill doesn't run that script, the agent must stage it directly.

Symptom if skipped: RT-CV starts but its TensorRT engine build fails because `${VSS_DATA_DIR}/models/rtdetr_warehouse_v1.0.2.fp16.onnx` is missing. (User-confirmed on 2026-05-10.)

```bash
# Source: deploy/docker/scripts/dev-profile.sh (search profile, model staging block)
# Requires NGC_CLI_API_KEY exported and ngc CLI on PATH (see references/ngc.md).

DATA="$VSS_DATA_DIR"                                     # e.g. <repo>/data
mkdir -p "$DATA/data_log/vss_video_analytics_api" "$DATA/models"

NGC_CLI_API_KEY="${NGC_CLI_API_KEY}" ngc registry model \
    download-version \
    nvidia/tao/rtdetr_2d_warehouse:deployable_rn50_v1.0.2 \
    --org nvidia

mv rtdetr_2d_warehouse_vdeployable_rn50_v1.0.2/rtdetr_warehouse_v1.0.2.fp16.onnx \
    "$DATA/models/rtdetr_warehouse_v1.0.2.fp16.onnx"
rm -rf rtdetr_2d_warehouse_vdeployable_rn50_v1.0.2

chmod -R 777 "$DATA/models"
```

**Verify** before deploying:

```bash
ls -l "$VSS_DATA_DIR/models/rtdetr_warehouse_v1.0.2.fp16.onnx"
# expected: ~30–50 MB onnx file, mode 777
```

After RT-CV starts, it builds a TensorRT engine from this ONNX (3–5 min on
first start). Note that engine caches live alongside the ONNX files under
`$VSS_DATA_DIR/models/` here, not under `$VSS_APPS_DIR/engines/` like the
alerts profile — see [`alerts.md` § Stage perception models](alerts.md#stage-perception-models-rtdetr-its--gdino) for the alerts-profile path.

## First-run note

RT-Embed downloads Cosmos-Embed1 weights from Hugging Face on first start; RT-CV's `perception-2d-init` downloads `siglip_v2` from NGC, then builds a TensorRT engine from the ONNX staged in [Stage perception models](#stage-perception-models-rt-detr-warehouse) above. Expect 15–25 min extra on the first deploy.

### HuggingFace token for RT-Embed

RT-Embed downloads the model named in `MODEL_PATH` (default `git:https://huggingface.co/nvidia/Cosmos-Embed1-448p-anomaly-detection`) from Hugging Face on first start. Setting `HF_TOKEN`:

- **speeds up the first-run download** of the default public Cosmos-Embed1 checkpoint, and
- **enables using private or gated HF models** when you repoint `MODEL_PATH` at, e.g., a custom fine-tune hosted in a private org.

Set `HF_TOKEN` in `deploy/docker/developer-profiles/dev-profile-search/.env` (default empty) to a token from https://huggingface.co/settings/tokens — a `read`-scope token is enough. The value wires through to the `rtvi-embed` container's `HF_TOKEN` environment variable via the search profile's `.env` (see `deploy/docker/services/rtvi/rtvi-embed/rtvi-embed-docker-compose.yml` line 64: `HF_TOKEN: "${HF_TOKEN:-}"`). Restart the container after changing it.

## Debugging

- **`docker logs vss-rtvi-embed`** — confirms model load and `Maximum concurrency for X tokens per GPU: Y x` line. If it OOMs, lower `RTVI_EMBED_NUM_VLM_PROCS` (10 → 4) or `NUM_STREAMS`.
- **`docker logs vss-rtvi-cv`** — DeepStream perception pipeline logs. If GPU 0 OOMs in Path B (default, VLM co-located), drop `NUM_STREAMS` first (with user confirmation if going below 8), then revisit VLM `NIM_KVCACHE_PERCENT`.
- **Embedding queries return zero hits** — check shared `logstash` is consuming `mdx-embed-filtered` and that the ES index `mdx-embed-filtered-2025-01-01` exists.
- **Critique returns "no VLM configured"** — confirm `VLM_BASE_URL` resolves and the resolved compose includes a VLM service or `VLM_MODE=remote` is set.
