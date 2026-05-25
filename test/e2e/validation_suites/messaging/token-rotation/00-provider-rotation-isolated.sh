#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/lib/messaging_providers.sh"
e2e_messaging_load_context
rotated="$(e2e_context_get E2E_ROTATED_MESSAGING_PROVIDER)"
provider="$(e2e_messaging_provider_name)"
if [[ -z "${rotated}" ]]; then
  rotated="${provider}"
fi
case " ${rotated} " in
  *" ${provider} "*) e2e_pass "post-onboard.messaging.token-rotation.${provider}-isolated only ${provider} rotation signal detected" ;;
  *) e2e_fail "post-onboard.messaging.token-rotation.${provider}-isolated unexpected rotation signal: ${rotated}" ;;
esac
