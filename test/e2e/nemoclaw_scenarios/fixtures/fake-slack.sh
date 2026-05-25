#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Local Slack API stub. Removes dependency on slack.com in CI.
# See _fake-http-stub.sh for the shared harness contract.

_E2E_FAKE_SL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_fake-http-stub.sh
. "${_E2E_FAKE_SL_DIR}/_fake-http-stub.sh"

_E2E_FAKE_SLACK_PID=""

fake_slack_start() {
  _fake_http_stub_start slack _E2E_FAKE_SLACK_PID FAKE_SLACK_PORT
}

fake_slack_stop() {
  _fake_http_stub_stop _E2E_FAKE_SLACK_PID
  unset FAKE_SLACK_PORT FAKE_SLACK_PID FAKE_SLACK_URL
}
