#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# Run the original Brev AWS GPU HPA test for 4×L40S GPUs.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ -n "${TARGET_PODS:-}" && "${TARGET_PODS}" != "4" ]]; then
  echo "hpa-load-test-brev-4xl40s.sh always tests 4 pods; use hpa-load-test.sh for a different target." >&2
  exit 1
fi

export TARGET_PODS=4
export HPA_LOAD_PROFILE=brev-4xl40s
exec "${SCRIPT_DIR}/hpa-load-test.sh"
