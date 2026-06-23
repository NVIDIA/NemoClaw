#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Extract human-readable assistant text from `openclaw agent --json` output.
# OpenClaw's JSON envelope has moved between result.payloads[] and top-level
# payloads[]; keep E2E assertions focused on visible reply/provenance text
# instead of one exact envelope shape. This also tolerates wrapper output before
# the JSON blob while preserving failed-tool and untrusted-child provenance so
# plausible assistant text cannot hide incomplete or unverified work.
parse_openclaw_agent_text() {
  local helper_dir
  helper_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  python3 "${helper_dir}/openclaw-agent-json.py"
}
