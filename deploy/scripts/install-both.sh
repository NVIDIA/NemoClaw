#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# DEPRECATED — CPU and GPU are separate deployments. Use chart install scripts instead.

set -euo pipefail

cat <<'EOF'
install-both.sh is deprecated.

Install CPU and GPU independently (do not use a combined install):

  CPU:  cd deploy/helm/nemoclaw-cpu && source ~/.nemoclaw/secrets.env && ./scripts/install-hpa.sh
  GPU:  cd deploy/helm/nemoclaw-gpu && MAX_REPLICAS=4 ./scripts/install-hpa.sh

Docs: deploy/README-cpu.md · deploy/README-gpu.md
EOF
exit 1
