#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Local Telegram API stub. Removes dependency on api.telegram.org in CI.
# See _fake-http-stub.sh for the shared harness contract.

_E2E_FAKE_TG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_fake-http-stub.sh
. "${_E2E_FAKE_TG_DIR}/_fake-http-stub.sh"

_E2E_FAKE_TELEGRAM_PID=""

fake_telegram_start() {
  _fake_http_stub_start telegram _E2E_FAKE_TELEGRAM_PID FAKE_TELEGRAM_PORT
}

fake_telegram_stop() {
  _fake_http_stub_stop _E2E_FAKE_TELEGRAM_PID
  unset FAKE_TELEGRAM_PORT FAKE_TELEGRAM_PID FAKE_TELEGRAM_URL
}
