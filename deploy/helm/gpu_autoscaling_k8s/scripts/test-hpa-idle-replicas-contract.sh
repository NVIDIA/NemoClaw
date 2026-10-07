#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Local contract: idle latency HPA 1/0 is a ready baseline. Leftover load
# (current/desired above 1) is not.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=hpa-common.sh
source "${SCRIPT_DIR}/hpa-common.sh"

hpa_common_replicas_at_want 1 1 1
hpa_common_replicas_at_want 1 0 1
hpa_common_replicas_at_want 1 "" 1
! hpa_common_replicas_at_want 1 2 1
! hpa_common_replicas_at_want 5 6 1
! hpa_common_replicas_at_want 5 1 1
hpa_common_replicas_at_want 8 8 8
! hpa_common_replicas_at_want 8 0 8

ready="$(hpa_common_replicas_ready_message ns hpa 1 0)"
[[ "${ready}" == *"desired 0 until the latency metric exists"* ]]
ready="$(hpa_common_replicas_ready_message ns hpa 1 1)"
[[ "${ready}" == *"1 current / 1 desired"* ]]

echo "OK: idle HPA 1/0 is a ready baseline; leftover 5/6 is not"
