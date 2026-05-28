#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Local Discord API stub. Removes dependency on discord.com in CI.
# See _fake-http-stub.sh for the shared harness contract.

_E2E_FAKE_DC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_fake-http-stub.sh
. "${_E2E_FAKE_DC_DIR}/_fake-http-stub.sh"

_E2E_FAKE_DISCORD_PID=""

fake_discord_start() {
  _fake_http_stub_start discord _E2E_FAKE_DISCORD_PID FAKE_DISCORD_PORT
}

fake_discord_stop() {
  _fake_http_stub_stop _E2E_FAKE_DISCORD_PID
  unset FAKE_DISCORD_PORT FAKE_DISCORD_PID FAKE_DISCORD_URL
}
