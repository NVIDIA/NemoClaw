#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Optional developer test: OpenClaw + Ollama on one GPU replica, no Kubernetes
# autoscaling and no load test. Not required for HPA. See ../scripts/README.md.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=agent-common.sh
source "${SCRIPT_DIR}/agent-common.sh"
agent_common_pin_example_pairing openclaw ollama
export ENABLE_AUTOSCALING=0
# Reuse the existing Ollama release; do not helm-upgrade it onto another runtime.
export NAMESPACE="${NAMESPACE:-nemoclaw-gpu}"
export RELEASE="${RELEASE:-nemoclaw-gpu}"
export ENABLE_ENVOY_LB="${ENABLE_ENVOY_LB:-0}"
export USE_EXISTING_PROMETHEUS="${USE_EXISTING_PROMETHEUS:-auto}"
export SKIP_MONITORING="${SKIP_MONITORING:-1}"
# Reuse the already-running Ollama pod on the DGX H100 node instead of helm-upgrading that release.
export SKIP_INSTALL_HPA="${SKIP_INSTALL_HPA:-1}"
# shellcheck source=e2e-common.sh
source "${SCRIPT_DIR}/e2e-common.sh"
