#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# DEPRECATED — CPU and GPU are separate deployments.

set -euo pipefail

cat <<'EOF'
status-both.sh is deprecated.

Check the chart you installed:

  CPU:  kubectl get hpa,deploy,pods -n nemoclaw
  GPU:  kubectl get hpa,deploy,pods -n nemoclaw-gpu

Docs: deploy/README-cpu.md · deploy/README-gpu.md
EOF
exit 1
