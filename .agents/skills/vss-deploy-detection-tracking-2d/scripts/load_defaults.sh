#!/usr/bin/env bash

# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# load_defaults.sh resolves platform and per-use-case deployment defaults.
#
# Licensed under Apache-2.0 (full text: http://www.apache.org/licenses/LICENSE-2.0).

# load_defaults.sh — Single bash call that detects the host platform AND
# resolves the per-usecase defaults from assets/deploy-defaults.yml.
#
# One invocation = one permission prompt. The skill (SKILL.md Step 1.b/1.c)
# runs this right after the use case is identified in 1.a, then captures
# the KEY=VALUE output and feeds the values directly into the 3-question
# AskUserQuestion in 1.d.
#
# Usage
# -----
#   load_defaults.sh <usecase>
#
#   <usecase> ∈ { warehouse-2d | warehouse-3d | smartcity-rtdetr | smartcity-gdino }
#
# Output (stdout, KEY=VALUE per line, eval-safe)
# ----------------------------------------------
#   USECASE=<usecase>
#   PLATFORM=<x86-dgpu|jetson|sbsa|unknown>
#   ARCH=<x86_64|aarch64|...>
#   IS_JETSON=<0|1>
#   GPU=<quoted GPU name + memory, may be empty>
#   DEFAULT_GPU_ID=<runtime.gpu_id from YAML, default 0>
#   DEFAULT_IMAGE=<docker_image.<arch_key>>
#   DEFAULT_MODEL_SOURCE=<ngc_resources key>
#   DEFAULT_MODEL_NGC_REF=<full org/team/name:tag>
#   DEFAULT_MODEL_PATH=<path relative to extract_dir>
#   DEFAULT_MODEL_EXTRACT_DIR=<extract_dir for the model resource>
#   DEFAULT_VIDEOS_SOURCE=...
#   DEFAULT_VIDEOS_NGC_REF=...
#   DEFAULT_VIDEOS_PATH=...
#   DEFAULT_VIDEOS_EXTRACT_DIR=...
#   # Optional roles (warehouse-3d only): DEFAULT_LABELS_*, DEFAULT_ANCHOR_*
#
# Capture pattern
# ---------------
#   eval "$(scripts/load_defaults.sh smartcity-gdino)"
#
# Exit codes
# ----------
#   0  success
#   1  missing/invalid <usecase> argument
#   2  assets/deploy-defaults.yml not found
#   3  usecase not declared in the YAML
#   4  python3 / PyYAML not available
#
set -euo pipefail

USECASE="${1:-}"
case "$USECASE" in
    -h|--help|help)
        sed -n '18,46p' "$0"
        exit 0
        ;;
esac
if [[ -z "$USECASE" ]]; then
    echo "ERROR: usage: $0 <usecase>   (run with --help for full doc)" >&2
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULTS_YAML="${SCRIPT_DIR}/../assets/deploy-defaults.yml"

if [[ ! -f "$DEFAULTS_YAML" ]]; then
    echo "ERROR: $DEFAULTS_YAML not found" >&2
    exit 2
fi

# 1. Detect platform.
ARCH=$(uname -m)
IS_JETSON=0
[[ -f /etc/nv_tegra_release ]] && IS_JETSON=1
GPU=$(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null | head -n1 || true)

if [[ "$ARCH" == "x86_64" && "$IS_JETSON" -eq 0 ]]; then
    PLATFORM=x86-dgpu;  ARCH_KEY=multi_arch
elif [[ "$ARCH" == "aarch64" && "$IS_JETSON" -eq 1 ]]; then
    PLATFORM=jetson;    ARCH_KEY=multi_arch
elif [[ "$ARCH" == "aarch64" && "$IS_JETSON" -eq 0 ]]; then
    PLATFORM=sbsa;      ARCH_KEY=sbsa
else
    PLATFORM=unknown;   ARCH_KEY=multi_arch
fi

# 2. Emit platform-derived values first (so YAML failures still leave the
#    skill with usable detection results).
printf 'USECASE=%s\n'   "$USECASE"
printf 'PLATFORM=%s\n'  "$PLATFORM"
printf 'ARCH=%s\n'      "$ARCH"
printf 'IS_JETSON=%s\n' "$IS_JETSON"
printf 'GPU=%q\n'       "$GPU"

# 3. Resolve YAML defaults via python (PyYAML is in every NVIDIA image we ship).
if ! command -v python3 >/dev/null 2>&1; then
    echo "ERROR: python3 not found — cannot parse $DEFAULTS_YAML" >&2
    exit 4
fi

python3 - "$DEFAULTS_YAML" "$USECASE" "$ARCH_KEY" <<'PY'
import sys
try:
    import yaml
except ImportError:
    print("ERROR: PyYAML not installed (pip install pyyaml)", file=sys.stderr)
    sys.exit(4)

defaults_path, usecase, arch_key = sys.argv[1], sys.argv[2], sys.argv[3]
with open(defaults_path) as f:
    d = yaml.safe_load(f)

if usecase not in d.get("usecases", {}):
    print(f"ERROR: usecase '{usecase}' not declared in {defaults_path}", file=sys.stderr)
    sys.exit(3)

uc = d["usecases"][usecase]
ngc_resources = d.get("ngc_resources", {})

# Runtime knobs (apply to every deploy regardless of usecase).
gpu_id = d.get("runtime", {}).get("gpu_id", 0)
print(f"DEFAULT_GPU_ID={gpu_id}")

# Container image for this platform.
img = d.get("docker_image", {}).get(arch_key)
if not img:
    print(f"ERROR: docker_image.{arch_key} missing in {defaults_path}", file=sys.stderr)
    sys.exit(3)
print(f"DEFAULT_IMAGE={img}")

# NGC asset roles. `model` and `videos` are universal; `labels` / `anchor`
# only apply to warehouse-3d.
for role in ("model", "videos", "labels", "anchor"):
    asset = uc.get(role)
    if not asset or not isinstance(asset, dict):
        continue
    src = asset.get("source")
    rel = asset.get("path", "")
    if not src or src not in ngc_resources:
        print(
            f"ERROR: usecase {usecase}.{role}.source='{src}' not in ngc_resources",
            file=sys.stderr,
        )
        sys.exit(3)
    R = role.upper()
    print(f"DEFAULT_{R}_SOURCE={src}")
    print(f"DEFAULT_{R}_NGC_REF={ngc_resources[src]['ref']}")
    print(f"DEFAULT_{R}_PATH={rel}")
    print(f"DEFAULT_{R}_EXTRACT_DIR={ngc_resources[src]['extract_dir']}")
    print(f"DEFAULT_{R}_KIND={ngc_resources[src].get('kind', 'resource')}")
PY
