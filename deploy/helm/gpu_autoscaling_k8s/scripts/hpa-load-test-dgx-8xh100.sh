#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# Run the full GPU HPA test for a DGX-class node with 8×H100 80GB GPUs.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ -n "${TARGET_PODS:-}" && "${TARGET_PODS}" != "8" ]]; then
  echo "hpa-load-test-dgx-8xh100.sh always tests 8 pods; use hpa-load-test.sh for a different target." >&2
  exit 1
fi

export TARGET_PODS=8
export HPA_LOAD_PROFILE=dgx-8xh100
exec "${SCRIPT_DIR}/hpa-load-test.sh"
