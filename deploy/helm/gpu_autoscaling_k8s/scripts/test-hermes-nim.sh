#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Optional developer test: Hermes + NIM on one GPU replica, no Kubernetes
# autoscaling and no load test. Not required for HPA. Needs NGC Secrets first —
# see ../README.md#inference-runtimes and ../scripts/README.md.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=agent-common.sh
source "${SCRIPT_DIR}/agent-common.sh"
agent_common_pin_example_pairing hermes nim
export ENABLE_AUTOSCALING=0
# Isolated from the default Ollama release in nemoclaw-gpu.
export NAMESPACE="${NAMESPACE:-nemoclaw-hermes-nim}"
export RELEASE="${RELEASE:-hermes-nim}"
export ENABLE_ENVOY_LB="${ENABLE_ENVOY_LB:-0}"
export USE_EXISTING_PROMETHEUS="${USE_EXISTING_PROMETHEUS:-auto}"
export SKIP_MONITORING="${SKIP_MONITORING:-1}"
# shellcheck source=e2e-common.sh
source "${SCRIPT_DIR}/e2e-common.sh"
