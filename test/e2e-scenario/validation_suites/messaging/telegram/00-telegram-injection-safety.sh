#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/lib/messaging_providers.sh"
e2e_messaging_load_context
# shellcheck disable=SC2016 # Literal command-substitution payload under test.
payload='$(touch /tmp/nemoclaw-telegram-injection-proof)'
observed="$(e2e_context_get E2E_MESSAGING_TELEGRAM_OBSERVED_COMMAND_SUBSTITUTION)"
e2e_messaging_assert_literal_payload "post-onboard.security.telegram-injection.command-substitution-blocked" "${payload}" "${observed}"
