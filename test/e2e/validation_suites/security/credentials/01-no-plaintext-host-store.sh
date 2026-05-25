#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# credentials step: no-plaintext-host-store

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../lib/security_policy_credentials.sh
. "${SCRIPT_DIR}/../../lib/security_policy_credentials.sh"

echo "credentials:no-plaintext-host-store"
spc_assert_no_plaintext_host_store
