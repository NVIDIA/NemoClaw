#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/lib/messaging_providers.sh"
e2e_messaging_load_context
content="$(e2e_messaging_read_config_surface)"
e2e_messaging_assert_no_secret_leak "${content}" "$(e2e_context_get E2E_MESSAGING_RAW_TOKEN)"
