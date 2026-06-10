#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# DEPRECATED — CPU and GPU are separate deployments.

set -euo pipefail

cat <<'EOF'
uninstall-both.sh is deprecated.

Uninstall the chart you installed:

  CPU:  helm uninstall nemoclaw -n nemoclaw
        kubectl delete namespace nemoclaw --ignore-not-found

  GPU:  helm uninstall nemoclaw-gpu -n nemoclaw-gpu
        kubectl delete namespace nemoclaw-gpu --ignore-not-found

Docs: deploy/README-cpu.md · deploy/README-gpu.md
EOF
exit 1
