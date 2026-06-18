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

# Step 2 Hardware Audit & NGC Image Selection

The Step 2a audit script, the live NGC image-selection rules, and the
hardware-dependent compat re-evaluation. Offline NGC fallback rules and the
GPU/VRAM detection reference live in `hardware-container.md`.

---

## 2a. Audit (hard gate)

The GPU host runtime check is owned by the `tao-setup-nvidia-gpu-host` skill
(driver branch 580, CUDA Toolkit 13.0, NVIDIA Container Toolkit 1.19.0).
Invoke it in `--check-only` mode; on failure, ask the user to authorize the
install, then re-run. Credentials come from the SessionStart hook
(`~/.config/tao/.env`) — only check the ones the current run actually needs.

```bash
# 1) GPU host runtime — delegated to tao-setup-nvidia-gpu-host
TAO_SKILL_BANK_ROOT="${TAO_SKILL_BANK_PATH:-${TAO_SKILL_BANK_ROOT:-$PWD}}"
SETUP_SCRIPT="${TAO_SKILL_BANK_ROOT}/platform/tao-setup-nvidia-gpu-host/scripts/setup-nvidia-gpu-host.sh"
[ -x "$SETUP_SCRIPT" ] || SETUP_SCRIPT="${TAO_SKILL_BANK_ROOT}/skills/tao-setup-nvidia-gpu-host/scripts/setup-nvidia-gpu-host.sh"

bash "$SETUP_SCRIPT" --backend docker --check-only || {
  echo "MISSING: TAO GPU host runtime not ready."
  echo "After user approval, run: bash \"$SETUP_SCRIPT\" --backend docker --install --yes"
  exit 1
}

# 2) Free-disk soft-warn (override via MIN_DISK_GB; default 100 GB)
min_disk_gb="${MIN_DISK_GB:-100}"
disk_free_gb=$(df -BG / | awk 'NR==2 {print $4}' | tr -d G)
if [ "${disk_free_gb:-0}" -lt "$min_disk_gb" ]; then
  echo "WARN: only ${disk_free_gb}G free on /; recommend ≥ ${min_disk_gb}G for NGC base (~20G) + HF cache + checkpoints + dataset." >&2
fi

# 3) Conditional credential presence checks (no values are read)
#    HF_TOKEN: only when the model/dataset is gated, or push_to_hub is on.
#    WANDB_*:  only when WandB logging is enabled in config.yaml.
```

**Do not proceed to Step 4 on a hard-fail** — Step 4's `docker build` pulls a
20+ GB NGC base image, and a missing `nvidia-container-toolkit` only surfaces
at `prepare_data.py` time as the cryptic `could not select device driver ""
with capabilities: [[gpu]]`.

Record `gpu_count`, `gpu_name`, `driver_major`, `vram_gb_per_gpu` in
`config.yaml`.

---

## 2b. Pick NGC image (live)

```
WebFetch https://docs.nvidia.com/deeplearning/frameworks/support-matrix/index.html
```

Find the **PyTorch NGC container** section. Pick the highest-versioned image
where:
- `Min driver ≤ detected driver_major`
- Container CUDA is `≤` host CUDA Toolkit version (drivers are forward-
  compatible, but match closely so cuDNN / TensorRT versions line up with
  the host toolchain).

Do **not** reject an image because its PyTorch version carries an `aN` /
`bN` / `rcN` suffix. Every recent NGC PyTorch image ships a near-head
PyTorch build (`2.10.0a0`, `2.11.0a0`, …) — NVIDIA validates the full image
end-to-end (CUDA / cuDNN / TensorRT / NCCL / drivers / Python stack), so
the `aN` reflects upstream PyTorch's tag, not NGC instability. Treating
`aN` as disqualifying would force every run onto a ~year-old image. Pick
the newest CUDA-aligned image and let real compat workarounds
(`compat-workarounds.md`) handle any per-version issue.

If WebFetch fails: fallback rules in `hardware-container.md`. Default
fallback: `nvcr.io/nvidia/pytorch:24.09-py3` (driver ≥ 545; SDPA+GQA bug — if
the model has `num_key_value_heads < num_attention_heads`, set
`attn_implementation: "eager"` in config).

Record `ngc_image` in `config.yaml`.

---

## 2c. Re-evaluate hardware-dependent compat rules

Re-run the `compat-workarounds.md` walk for entries whose `detect` expression
needs `hw`. Update `applicable_workarounds:` in place.

---

## 2d. Model-fit check

Estimate `param_bytes ≈ 2×param_count` (bf16). If > 60% of
`vram_gb_per_gpu × 1e9`, recommend LoRA in the user-facing summary.
