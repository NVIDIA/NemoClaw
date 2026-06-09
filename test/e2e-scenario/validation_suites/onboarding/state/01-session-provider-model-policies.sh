#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../../runtime/lib/context.sh
. "${SCRIPT_DIR}/../../../runtime/lib/context.sh"
# shellcheck source=../../../runtime/lib/onboard-state.sh
. "${SCRIPT_DIR}/../../../runtime/lib/onboard-state.sh"

CTX_FILE="$(e2e_context_path)"
# shellcheck disable=SC1090
. "${CTX_FILE}"

session_file="${HOME}/.nemoclaw/onboard-session.json"
model="${E2E_ONBOARDING_MODEL:-nvidia/nemotron-3-ultra-550b-a55b}"
provider="${E2E_ONBOARDING_REGISTRY_PROVIDER:-nvidia-prod}"
presets="${E2E_ONBOARDING_POLICY_PRESETS:-npm,pypi}"

e2e_onboard_state_assert_session "${session_file}" "${E2E_SANDBOX_NAME}" "${provider}" "${model}" "${presets}"
echo "PASS: onboarding-state.session-provider-model-policies"
