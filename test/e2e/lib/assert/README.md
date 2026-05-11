<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Assertion helpers

Outcome checks that multiple suites share. Each helper prints a one-line
PASS/FAIL status and returns 0 on success, non-zero on failure.

## Current

| Helper | What it asserts |
|---|---|
| `gateway-alive.sh` | Gateway container is present and HTTP-healthy at `E2E_GATEWAY_URL`. |
| `sandbox-alive.sh` | Named sandbox is registered and in `Running` phase. |

## Planned (from UAT/NV QA hotspot analysis)

| Helper | First consumer | Purpose |
|---|---|---|
| `inference-works.sh` | `inference/cloud/`, `inference/ollama-gpu/` | Single round-trip chat-completion assertion against whichever gateway route is active. |
| `no-credentials-leaked.sh` | `security/credentials/`, `security/rebuild-preserves-presets/` | Scan migration bundle + blueprint digest + sandbox filesystem for credential patterns. Covers the UAT #1912 / credential-sanitization class. |
| `policy-preset-applied.sh` | `security/shields/`, `security/rebuild-preserves-presets/` | Verify the declared policy presets are actually in the gateway's active policy (UAT #1952, #2010 class). |
