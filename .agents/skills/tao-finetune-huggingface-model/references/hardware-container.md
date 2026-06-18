<!--
Copyright (c) 2026, NVIDIA CORPORATION.  All rights reserved.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
-->

# Hardware Audit & Container Selection Reference

Used in Phases 1–2 of tao-finetune-huggingface-model skill.

---

## GPU Detection Commands

```bash
# Full GPU summary
nvidia-smi --query-gpu=index,name,driver_version,memory.total,memory.free,compute_cap \
  --format=csv,noheader,nounits

# Driver version only
nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -1

# Count GPUs
nvidia-smi --list-gpus | wc -l

# CUDA toolkit version (may differ from driver CUDA version)
nvcc --version 2>/dev/null || cat /usr/local/cuda/version.txt 2>/dev/null || echo "nvcc not found"
```

Parse driver version as float for comparison:
```bash
DRIVER=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -1)
DRIVER_MAJOR=$(echo $DRIVER | cut -d. -f1)
echo "Driver: $DRIVER, Major: $DRIVER_MAJOR"
```

---

## NGC Base Image Selection — Live Lookup

**Do NOT use a hardcoded table.** NGC releases new PyTorch containers monthly; a static list
goes stale and can point to alpha/dev builds (e.g. 24.11-py3 ships PyTorch 2.6.0a0, which
breaks transformers imports) without the agent knowing.

### Step: web search for the current support matrix

Use WebSearch or WebFetch to retrieve the live NVIDIA support matrix:

```
URL: https://docs.nvidia.com/deeplearning/frameworks/support-matrix/index.html
```

From that page, find the **PyTorch NGC container** rows and select the **highest-versioned
image whose minimum driver version ≤ the detected driver**. That is the latest compatible
image for this hardware.

Key columns to read: **Container version**, **Min driver**, **CUDA version**, **Framework version**.

### What to look for in the result

- Filter to rows where `Min driver ≤ DRIVER` (from nvidia-smi)
- Among those, pick the row with the **newest container version** (highest YY.MM number)
- Note the **Framework version** (PyTorch X.Y.Z) — write it into `phase1_hardware.yaml`
- Note: **all NGC PyTorch containers ship `a0` builds** (e.g. `2.5.0a0+b465a5843b`). NVIDIA
  always builds from source with custom CUDA kernels, so `a0` is normal — it does not indicate
  unstable software. Do NOT exclude containers based on the `a0` suffix.
- Instead check the **container release notes** for known issues. If transformers or other
  libraries fail to import, that is a specific incompatibility — add it to the compat registry.

### Write the result to phase1_hardware.yaml

```yaml
ngc_image: "nvcr.io/nvidia/pytorch:25.03-py3"   # example — use actual lookup result
pytorch_version: "2.7.0"                           # from support matrix, not guessed
```

### Fallback if web search is unavailable

If the web search fails (no network, timeout), use the last-known-good image that matches
the driver floor. The only verified-in-production image is:

```
driver ≥ 555 → nvcr.io/nvidia/pytorch:24.09-py3  (PyTorch 2.5.0, CUDA 12.6, Python 3.10)
driver ≥ 535 → nvcr.io/nvidia/pytorch:24.01-py3  (PyTorch 2.3.0, CUDA 12.3, Python 3.10)
```

Log a warning in PROGRESS.md when falling back.

---

## VRAM Budget Guide

Use this to advise users on batch sizes and LoRA vs full finetune decisions:

| GPU | VRAM | Recommendation |
|-----|------|---------------|
| RTX 3090 / 4090 | 24 GB | Small-medium models; LoRA for VLMs > 7B |
| RTX 6000 Ada | 48 GB | Medium models; full finetune up to ~13B with LoRA |
| A100 40GB | 40 GB | Medium-large; LoRA for 13B+ VLMs |
| A100 80GB | 80 GB | Large models; full finetune up to 7B; LoRA for 70B+ |
| H100 80GB | 80 GB | Same as A100 80GB but faster compute |
| H100 NVL | 94 GB | Largest local GPU; full finetune up to 13B |

**Decision rule:**
- `model_params_M * 2 bytes (bf16) > vram_gb * 0.6` → use LoRA
- Otherwise → full finetune is viable

---

## Container Verification Commands

```bash
NGC_IMAGE="nvcr.io/nvidia/pytorch:25.01-py3"

# 1. Pull (first time only, ~15-25GB)
docker pull $NGC_IMAGE

# 2. GPU access check
docker run --rm --gpus all $NGC_IMAGE \
  python -c "
import torch
print('CUDA available:', torch.cuda.is_available())
print('GPU count:', torch.cuda.device_count())
for i in range(torch.cuda.device_count()):
    print(f'  GPU {i}:', torch.cuda.get_device_name(i),
          f'{torch.cuda.get_device_properties(i).total_memory / 1e9:.1f} GB')
print('PyTorch version:', torch.__version__)
print('CUDA version:', torch.version.cuda)
"

# 3. transformers install check
docker run --rm --gpus all $NGC_IMAGE \
  bash -c "pip install transformers -q && python -c 'import transformers; print(transformers.__version__)'"
```

Expected successful output example:
```
CUDA available: True
GPU count: 2
  GPU 0: NVIDIA A100-SXM4-80GB 79.2 GB
  GPU 1: NVIDIA A100-SXM4-80GB 79.2 GB
PyTorch version: 2.6.0a0+...
CUDA version: 12.7
```

---

## Multi-GPU Configuration

If `gpu_count > 1`, set these in `config.yaml`:
```yaml
# training args
per_device_train_batch_size: 8    # per GPU
gradient_accumulation_steps: 2    # effective batch = 8 * 2 * gpu_count
dataloader_num_workers: 4
```

Launch with torchrun inside container:
```bash
docker run -d --name hft_train \
  --gpus all \
  --shm-size=32g \
  -e MASTER_ADDR=localhost \
  -e MASTER_PORT=29500 \
  ... \
  $NGC_IMAGE \
  "cd /workspace && torchrun --nproc_per_node=2 train.py --config config.yaml 2>&1 | tee logs/train.log"
```

HF Trainer auto-detects torchrun environment via `LOCAL_RANK` env var. No manual DDP setup needed.

---

## Environment Variables for docker run

The canonical training-time flag set lives in `docker-runs.md` (sibling
reference). The conventions there assume the container runs as the host user
(`--user $(id -u):$(id -g)`) with the HF cache pinned into the bind-mounted
`/workspace`, so file ownership in `checkpoints/`, `reports/`, and `logs/`
stays clean on the host.

Always pass:
```bash
-e PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True   # reduces fragmentation OOM
-e NCCL_DEBUG=WARN                                      # suppress verbose NCCL logs
-e HF_HOME=/workspace/.cache/huggingface              # writable by --user; not /root which is locked when UID != 0
```

If you're following the alternate `run.sh` named-volume layout described
in `deliverables.md` (sibling reference — root-inside-container plus
shared docker volumes at `/root/.cache/*`) instead, mirror that
file's `HF_HOME=/root/.cache/huggingface`. Pick one pattern per project
and stay consistent — mixing them produces both a host-user-owned cache
and a `root:root` named volume that the host user cannot purge without
`sudo`.

Optional for faster tokenizer:
```bash
-e TOKENIZERS_PARALLELISM=false   # suppress fork warning with multiple workers
```

---

## NGC Authentication (if image requires login)

Most `nvcr.io/nvidia/pytorch` images are publicly accessible without authentication.
If you get a 401 error:
```bash
docker login nvcr.io
# Username: $oauthtoken
# Password: <your NGC API key from ngc.nvidia.com>
```

---

## write phase1_hardware.yaml

After running detection commands, write:
```yaml
ngc_image: nvcr.io/nvidia/pytorch:25.01-py3
driver_version: "570.86.15"
driver_major: 570
cuda_version: "12.7"
pytorch_version: "2.6.0"
gpu_count: 2
gpu_name: NVIDIA A100-SXM4-80GB
vram_gb_per_gpu: 79.2
total_vram_gb: 158.4
multi_gpu: true
attn_implementation: sdpa
lora_recommended: false   # 79.2 GB * 0.6 = 47.5 GB headroom → full finetune viable for ≤7B
```
