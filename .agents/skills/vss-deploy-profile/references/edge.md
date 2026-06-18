# Edge Deployment Reference (DGX Spark, AGX Thor, IGX Thor)

Base-profile deployment guidance for edge platforms.

On **DGX Spark**, use **NVIDIA-Nemotron-Nano-9B-v2-DGX-Spark** as the
LLM. This is a DGX Spark-only NIM container:

```text
nvcr.io/nim/nvidia/nvidia-nemotron-nano-9b-v2-dgx-spark:1.0.0-variant
```

Do not use the standard `nvcr.io/nim/nvidia/nvidia-nemotron-nano-9b-v2:1`
image on DGX Spark. That image has had an arm64 manifest problem in this
blueprint context, and it is not the DGX Spark optimized NIM.

The DGX Spark NIM is **not wired into the blueprint compose graph yet**.
Until `deploy/docker/services/nim/nvidia-nemotron-nano-9b-v2-dgx-spark/`
exists, run the LLM NIM as a standalone local service on port `30081` and
point the VSS agent at it with `LLM_MODE=remote`.

On **AGX Thor / IGX Thor**, this skill does not have a verified Nano 9B
DGX Spark NIM replacement. Keep using the Thor Edge 4B standalone vLLM path
below unless a Thor-supported NIM is confirmed.

## Ask first — the local edge LLM is latency-limited

The edge local LLM — **Edge 4B** (AGX/IGX Thor) or **Nano 9B Nemotron** (DGX Spark) — runs on the device's shared/unified memory and is **slow** (on DGX Spark it is the main latency bottleneck). **Before deploying, ask the user:**

> The local edge LLM (Edge 4B on Thor, Nano 9B Nemotron on DGX Spark) runs on the device and is latency-limited. If you have a **remote LLM endpoint** (build.nvidia.com / NVIDIA API catalog, or your own OpenAI-compatible server), using it gives noticeably better latency. Use a remote LLM, or run the local one?

- **Remote (recommended for latency):** the user supplies the endpoint + model. Set `LLM_MODE=remote`, `LLM_NAME_SLUG=none`, `LLM_BASE_URL=<endpoint, no trailing /v1>`, `LLM_NAME=<model the endpoint serves>`, and `NVIDIA_API_KEY=<key>` if required; probe `<endpoint>/v1/models` first (see [`credentials.md`](credentials.md)). Only the LLM goes remote; the VLM still deploys locally per the platform's VLM recipe below.
- **Local:** proceed with the platform recipe below; expect higher latency.

## When to pick which

| Situation | LLM path |
|---|---|
| DGX Spark shared mode | NVIDIA-Nemotron-Nano-9B-v2-DGX-Spark NIM, standalone on `localhost:30081` |
| DGX Spark remote-LLM mode | External endpoint; no local LLM needed |
| AGX/IGX Thor shared mode | Edge 4B standalone vLLM fallback |
| Non-edge hardware (H100, L40S, RTX PRO) | Standard Nano 9B v2 NIM compose path |

## Prerequisites

- `NGC_API_KEY` or `NGC_CLI_API_KEY` for the DGX Spark NIM container.
- Docker login to NGC before pulling private NIM images:

  ```bash
  export NGC_API_KEY="${NGC_API_KEY:-$NGC_CLI_API_KEY}"
  echo "$NGC_API_KEY" | docker login nvcr.io --username '$oauthtoken' --password-stdin
  ```

- `HF_TOKEN` is required only for the Thor Edge 4B fallback path.
- `NVIDIA_API_KEY` for agent-side NVIDIA API calls when the profile uses them.
- GPU freed: `docker ps` should show no running VSS, NIM, or LLM containers
  before starting. Reboot the device if in doubt.
- System cache cleaner running on DGX Spark / IGX Thor / AGX Thor - see
  [Cache cleaner](#cache-cleaner-every-edge-deploy).

### Cache cleaner (every edge deploy)

Edge platforms (DGX Spark, IGX Thor, AGX Thor) share unified memory between
CPU and GPU. Without periodic `drop_caches`, the kernel's page cache can pin
enough memory that the first inference frame OOMs - most visibly in the
alerts `MODE=2d_cv` path, where Grounding DINO post-processing fails with
`AcceleratorError: CUDA error: out of memory` on the first frame.

This is a platform prerequisite, not a profile-specific one. Every profile
(`base`, `alerts`, `search`, `lvs`, `warehouse`) needs the cleaner running on
edge hardware.

**Install and start (one-time per host):**

```bash
sudo tee /usr/local/bin/sys-cache-cleaner.sh << 'EOF'
#!/bin/bash
set -e
echo 0 | tee /proc/sys/vm/nr_hugepages
echo "Starting cache cleaner"
while true; do
  sync && echo 3 | tee /proc/sys/vm/drop_caches > /dev/null
  sleep 3
done
EOF
sudo chmod +x /usr/local/bin/sys-cache-cleaner.sh
sudo -b /usr/local/bin/sys-cache-cleaner.sh
```

**Verify it is running before any `docker compose up`:**

```bash
pgrep -f sys-cache-cleaner.sh && echo "cache cleaner OK" || echo "cache cleaner NOT RUNNING - start it before deploying"
```

The cleaner is intentionally not a systemd unit, so a `reboot` resets it.
Run this block manually for edge hosts before deployment; the generic
SKILL.md pre-flight smoke test does not install it.

> **IGX Thor only - also boost VIC clocks:**
> ```bash
> sudo nvpmodel -m 0
> sudo jetson_clocks
> # Replace `<VIC_DEVFREQ_PATH>` with the value of `ls /sys/class/devfreq/` that matches `*.vic`
> sudo su -c 'echo performance > <VIC_DEVFREQ_PATH>/governor'
> ```

### Unified-memory GPU budget (reserve ≥ 0.2)
<a id="unified-memory-budget"></a>

On these platforms CPU, GPU, OS page cache, and every container draw from **one**
shared pool, so a GPU-memory *fraction* — `NIM_GPU_MEM_FRACTION` / `NIM_KVCACHE_PERCENT`
for NIM-served models (the DGX-Spark base LLM and Cosmos VLM run as NIMs), or
`RTVI_VLLM_GPU_MEMORY_UTILIZATION` for RT-VLM (alerts / lvs / Thor) — is a slice of
memory that is **not all free**.
vLLM measures *free* at startup and aborts before loading the model if free is
below what the fraction asks for (`desired = util × total`):

```text
ValueError: Free memory on device (X/124.61 GiB) on startup is less than desired
GPU memory utilization (0.8, 99.69 GiB). Decrease GPU memory utilization …
```

which surfaces in VSS as `Engine core initialization failed` /
`Failed to load VLM on GPU 0`.

**Rule:** compute each fraction against *actual free* memory and leave **≥ 0.2 of
total** (~20%) as reserve — `util ≤ free/total − 0.2` — and for co-resident
services keep the **sum** of their fractions `≤ 0.8`:

```bash
# DGX Spark reports free/total via nvidia-smi (Thor/Tegra often reports N/A — see below)
set -- $(nvidia-smi --query-gpu=memory.free,memory.total --format=csv,noheader,nounits | head -1 | tr -d ',')
free=$1; total=$2
awk -v f="$free" -v t="$total" 'BEGIN{u=f/t-0.2; if(u<0)u=0; printf "max util ~ %.2f  (free %d / total %d MiB; 0.2 reserve)\n", u, f, t}'
```

The conservative per-service defaults already aim for this on a clean box (each
fraction ≈ 0.4, so two co-resident services sum to ≤ 0.8): the standalone DGX-Spark
LLM NIM recipe below sets `NIM_GPU_MEM_FRACTION=0.4`, and `dev-profile.sh`'s
`get_rtvi_vllm_gpu_memory_utilization()` returns `0.4` for RT-VLM. If other tenants
are resident (so `free` is lower than the formula's value), **lower the fractions to
fit**. If `nvidia-smi` can't read free (Thor/Tegra often reports `[N/A]`), keep the
conservative ~0.4 and drop by `0.05` on the first `Free … less than desired` abort.

## DGX Spark - Nano 9B v2 DGX Spark NIM + local Cosmos Reason2 VLM

Start the LLM as a standalone local NIM on port `30081`:

```bash
export NGC_API_KEY="${NGC_API_KEY:-$NGC_CLI_API_KEY}"
export LOCAL_NIM_CACHE="${LOCAL_NIM_CACHE:-$HOME/.cache/nim}"
mkdir -p "$LOCAL_NIM_CACHE"
chmod -R a+w "$LOCAL_NIM_CACHE"

docker rm -f nemotron-dgx-spark 2>/dev/null || true

docker run --gpus all -d --name nemotron-dgx-spark -p 30081:8000 \
    --runtime=nvidia \
    --shm-size=16GB \
    -e NGC_API_KEY="$NGC_API_KEY" \
    -e NIM_KVCACHE_PERCENT=0.40 \
    -e NIM_GPU_MEM_FRACTION=0.40 \
    -e NIM_MAX_NUM_SEQS=4 \
    -v "$LOCAL_NIM_CACHE:/opt/nim/.cache" \
    nvcr.io/nim/nvidia/nvidia-nemotron-nano-9b-v2-dgx-spark:1.0.0-variant
```

The conservative starting point is `NIM_KVCACHE_PERCENT=0.40`,
`NIM_GPU_MEM_FRACTION=0.40`, and `NIM_MAX_NUM_SEQS=4`. The DGX Spark NIM
variant does not support `NIM_MAX_MODEL_LEN` or running the container as a
non-default user. If the NIM exits or reports memory pressure, lower
`NIM_MAX_NUM_SEQS` or reduce the memory fraction by `0.05` and retry. The
common memory symptom is:

```text
No available memory for the cache blocks
```

Validate the standalone LLM before starting the VSS stack:

```bash
curl -sf http://localhost:30081/v1/health/ready && echo "LLM NIM ready"
curl -s http://localhost:30081/v1/models | jq -r '.data[].id'
```

Expected model ID is `nvidia/nvidia-nemotron-nano-9b-v2-dgx-spark`. If
`/v1/models` returns a different ID, use the returned ID as `LLM_NAME` in
`generated.env`.

Then apply env overrides to `dev-profile-base/generated.env`:

| Key | Value | Why |
|---|---|---|
| `LLM_MODE` | `remote` | The DGX Spark NIM is standalone until it is wired into compose |
| `LLM_BASE_URL` | `http://localhost:30081` | The local NIM started above |
| `LLM_NAME` | `nvidia/nvidia-nemotron-nano-9b-v2-dgx-spark` | Expected served model ID; verify with `/v1/models` |
| `LLM_NAME_SLUG` | `none` | Remote mode skips local LLM compose services |
| `HARDWARE_PROFILE` | `DGX-SPARK` | Selects the DGX Spark VLM env file |
| `VLM_MODE` | `local_shared` | VLM stays local on the shared edge GPU |
| `VLM_NAME` | `nvidia/cosmos-reason2-8b` | Default local VLM |
| `VLM_NAME_SLUG` | `cosmos-reason2-8b` | Compose-managed VLM service |
| `LLM_DEVICE_ID` | `0` | Edge platforms share GPU 0 |
| `VLM_DEVICE_ID` | `0` | Edge platforms share GPU 0 |

Use the default agent config unless you have evidence this model needs the
Edge 4B-specific prompt:

```text
VSS_AGENT_CONFIG_FILE=./deploy/docker/developer-profiles/dev-profile-base/vss-agent/configs/config.yml
```

Then follow `SKILL.md` Steps 3-5 (resolve compose, normalize, `up -d`). The
`cosmos-reason2-8b` NIM compose automatically loads
`hw-DGX-SPARK-shared.env`, which caps the VLM side for shared edge memory.

## Future compose-supported DGX Spark path

If the repo later adds
`deploy/docker/services/nim/nvidia-nemotron-nano-9b-v2-dgx-spark/`, do not
run the standalone NIM. Instead use the compose-managed local-shared path:

| Key | Value |
|---|---|
| `HARDWARE_PROFILE` | `DGX-SPARK` |
| `LLM_NAME` | `nvidia/nvidia-nemotron-nano-9b-v2-dgx-spark` |
| `LLM_NAME_SLUG` | `nvidia-nemotron-nano-9b-v2-dgx-spark` |
| `LLM_MODE` | `local_shared` |
| `VLM_NAME` | `nvidia/cosmos-reason2-8b` |
| `VLM_NAME_SLUG` | `cosmos-reason2-8b` |
| `VLM_MODE` | `local_shared` |
| `LLM_DEVICE_ID` | `0` |
| `VLM_DEVICE_ID` | `0` |

Before using that path, verify the resolved compose includes the DGX Spark
LLM service and that its env file carries the same conservative cache and
sequence limits from the standalone recipe above.

## AGX Thor / IGX Thor - Edge 4B fallback + rtvi-vlm

On Thor, the VLM falls back to **`rtvi-vlm` serving Cosmos Reason 2
in-process**. The standalone `cosmos-reason2-8b` NIM service does not run on
Thor. `rtvi-vlm` loads `ngc:nim/nvidia/cosmos-reason2-8b:hf-1208` itself and
advertises it at `http://${HOST_IP}:8018/v1` under
`VLM_NAME=nim_nvidia_cosmos-reason2-8b_hf-1208` with
`VLM_NAME_SLUG=none`.

Remote VLM and `--vlm` swaps are not supported on Thor for `base` or
`alerts`; this is the only deployed VLM shape documented by this skill.

The Thor LLM fallback runs from a Jetson-specific vLLM image and requires
`HF_TOKEN` access to the Edge 4B weights.

Before running the deploy, verify the token can reach the Edge 4B repo:

```bash
curl -sf -H "Authorization: Bearer $HF_TOKEN" \
    https://huggingface.co/api/models/nvidia/NVIDIA-Nemotron-Edge-4B-v2.1-EA-020126_FP8 \
    >/dev/null && echo "HF_TOKEN works" || echo "HF_TOKEN missing/invalid/no access"
```

If the model is gated, the token's owner must request access on the HF page.

Start the Thor LLM fallback:

```bash
export HF_TOKEN=$HF_TOKEN

docker rm -f nemotron-edge 2>/dev/null || true

docker run --gpus all -d --name nemotron-edge -p 30081:8000 \
    --runtime=nvidia \
    -e NVIDIA_VISIBLE_DEVICES=0 \
    -e HF_TOKEN="$HF_TOKEN" \
    ghcr.io/nvidia-ai-iot/vllm:latest-jetson-thor \
    python3 -m vllm.entrypoints.openai.api_server \
    --model nvidia/NVIDIA-Nemotron-Edge-4B-v2.1-EA-020126_FP8 \
    --trust-remote-code \
    --gpu-memory-utilization 0.25 \
    --enable-auto-tool-choice \
    --tool-call-parser qwen3_coder \
    --port 8000
```

Then apply env overrides to `dev-profile-base/generated.env`:

| Key | Value |
|---|---|
| `LLM_MODE` | `remote` |
| `LLM_BASE_URL` | `http://localhost:30081` |
| `LLM_NAME` | `nvidia/NVIDIA-Nemotron-Edge-4B-v2.1-EA-020126_FP8` |
| `LLM_NAME_SLUG` | `none` |
| `HARDWARE_PROFILE` | `AGX-THOR` or `IGX-THOR` |
| `LLM_DEVICE_ID` | `0` |
| `VLM_DEVICE_ID` | `0` |
| `VSS_AGENT_CONFIG_FILE` | `./deploy/docker/developer-profiles/dev-profile-base/vss-agent/configs/config_edge.yml` |

Then follow `SKILL.md` Steps 3-5. Thor uses the default 35% GPU budget for
`rtvi-vlm`.

## Caveats

- **DGX Spark needs the `-sbsa` container images.** GB10/DGX Spark runs the dGPU/SBSA
  driver (not Tegra/L4T); the default image tags pull the Tegra DeepStream build, which
  crash-loops on missing `libnvbufsurface.so.1.0.0` / `libnvrm_mem.so`. `dev-profile.sh`
  auto-swaps the `-sbsa` variants for `HARDWARE_PROFILE=DGX-SPARK`. When writing
  `generated.env` directly, set each image tag to its `-sbsa` variant (the commented
  `# …-sbsa` line in the profile's `.env`): `RTVI_VLM_IMAGE_TAG` (RT-VLM),
  `PERCEPTION_TAG` (RT-CV), and `LVS_TAG` (LVS).
- **DGX Spark NIM is local but configured as remote in VSS.** This is only
  because the image is not wired into compose yet. `LLM_MODE=remote` skips the
  local LLM compose service and points the agent at `localhost:30081`.
- **DGX Spark NIM is DGX Spark-only.** Do not use it on H100, L40S, RTX PRO,
  AGX Thor, or IGX Thor unless NVIDIA documents support for that platform.
- **Confirm the served model ID.** The expected ID is
  `nvidia/nvidia-nemotron-nano-9b-v2-dgx-spark`, but `/v1/models` is the
  source of truth for `LLM_NAME`.
- **No `HF_TOKEN` for DGX Spark NIM.** Use `NGC_API_KEY` /
  `NGC_CLI_API_KEY`. `HF_TOKEN` applies only to the Thor Edge 4B fallback.
- **DGX Spark NIM variant limitations.** NVIDIA's variant notes say not to
  use `-u $(id -u)` and that `NIM_MAX_MODEL_LEN` is not supported for this
  container. Tune sequence count and memory fractions instead.
- **Do not point DGX Spark Nano 9B at `config_edge.yml` by default.**
  `config_edge.yml` exists for the smaller Edge 4B fallback and deliberately
  removes clarifying-question behavior. Start with `config.yml` for Nano 9B.
- **Thor Edge 4B skips clarifying questions.** `config_edge.yml` simplifies
  the planning prompt for the smaller fallback model. If ambiguous user
  questions matter on Thor, use a verified remote LLM instead.

## Known ARM64 gotcha

`nvcr.io/nim/nvidia/nvidia-nemotron-nano-9b-v2:1` (the default `base` NIM
tag) has had a broken arm64 manifest in this blueprint context. It declares
arm64 but contains x86_64 binaries. This is why DGX Spark must use the Spark
variant:

```text
nvcr.io/nim/nvidia/nvidia-nemotron-nano-9b-v2-dgx-spark:1.0.0-variant
```

That Spark variant is currently documented here as a standalone NIM because
the blueprint compose files do not yet include it.
