#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Renderer contract for step 6d: 2 OpenClaw sandboxes and 6 Hermes sandboxes,
# each pointed at its own GPU chart Service.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

rendered="$("${SCRIPT_DIR}/render-mixed-sandboxes.sh")"

python3 -c '
import sys
import yaml

doc = yaml.safe_load(sys.stdin.read())
spec = doc["spec"]
namespace = spec["gateway"]["kubernetes"]["namespace"]
if namespace != "nemoclaw-v1-gpu-autoscaling-mixed":
    raise SystemExit(f"namespace {namespace}")
providers = spec["inferenceProviders"]
ollama = providers["gpu-ollama"]["endpoint"]
vllm = providers["gpu-vllm"]["endpoint"]
if ollama != "http://nemoclaw-gpu-ollama-metrics-proxy.nemoclaw-gpu-ollama.svc.cluster.local:8081/v1":
    raise SystemExit(f"ollama endpoint {ollama}")
if vllm != "http://nemoclaw-gpu-vllm-metrics-proxy.nemoclaw-gpu-vllm.svc.cluster.local:8081/v1":
    raise SystemExit(f"vllm endpoint {vllm}")
if providers["gpu-ollama"]["credential"]["env"] != "GPU_OLLAMA_API_KEY":
    raise SystemExit("ollama credential env")
if providers["gpu-vllm"]["credential"]["env"] != "GPU_VLLM_API_KEY":
    raise SystemExit("vllm credential env")
sandboxes = spec["sandboxes"]
if list(sandboxes) != [f"user-{i:04d}" for i in range(8)]:
    raise SystemExit(f"sandbox names {list(sandboxes)}")
for name in ("user-0000", "user-0001"):
    sandbox = sandboxes[name]
    if sandbox["harness"]["kind"] != "nvidia.fabric.openclaw":
        raise SystemExit(f"{name} harness")
    if sandbox["image"]["metadata"]["env"] != "NEMOCLAW_OPENCLAW_IMAGE_METADATA":
        raise SystemExit(f"{name} metadata")
    if sandbox["agent"]["inference"]["routes"][0]["providerRef"] != "gpu-ollama":
        raise SystemExit(f"{name} provider")
    if sandbox["agent"]["inference"]["routes"][0]["overrides"]["model"] != "llama3.2:3b":
        raise SystemExit(f"{name} model")
for index in range(2, 8):
    name = f"user-{index:04d}"
    sandbox = sandboxes[name]
    if sandbox["harness"]["kind"] != "nvidia.fabric.hermes":
        raise SystemExit(f"{name} harness")
    if sandbox["image"]["metadata"]["env"] != "NEMOCLAW_HERMES_IMAGE_METADATA":
        raise SystemExit(f"{name} metadata")
    if sandbox["agent"]["inference"]["routes"][0]["providerRef"] != "gpu-vllm":
        raise SystemExit(f"{name} provider")
    if sandbox["agent"]["inference"]["routes"][0]["overrides"]["model"] != "nvidia/NVIDIA-Nemotron-3-Nano-4B-FP8":
        raise SystemExit(f"{name} model")
' <<<"${rendered}"

echo "OK: 2 OpenClaw sandboxes and 6 Hermes sandboxes use separate inference Services"
