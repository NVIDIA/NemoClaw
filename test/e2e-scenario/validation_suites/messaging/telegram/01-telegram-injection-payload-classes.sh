#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/lib/messaging_providers.sh"
e2e_messaging_load_context
# shellcheck disable=SC2016 # Literal backtick payload under test.
e2e_messaging_assert_literal_payload \
  "post-onboard.security.telegram-injection.backtick-blocked" \
  '`touch /tmp/nemoclaw-telegram-backtick-proof`' \
  "$(e2e_context_get E2E_MESSAGING_TELEGRAM_OBSERVED_BACKTICK)"
# shellcheck disable=SC2016 # Literal variable-expansion payload under test.
e2e_messaging_assert_literal_payload \
  "post-onboard.security.telegram-injection.variable-expansion-blocked" \
  '${HOME}' \
  "$(e2e_context_get E2E_MESSAGING_TELEGRAM_OBSERVED_VARIABLE_EXPANSION)"
e2e_messaging_assert_literal_payload \
  "post-onboard.security.telegram-injection.shell-metacharacter-blocked" \
  'hello; touch /tmp/nemoclaw-telegram-metachar-proof' \
  "$(e2e_context_get E2E_MESSAGING_TELEGRAM_OBSERVED_SHELL_METACHARACTER)"
