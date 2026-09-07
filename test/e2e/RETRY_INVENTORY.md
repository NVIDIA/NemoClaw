<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Live E2E retry inventory

| Operation | Owner | Limit | Retry condition | Safety basis | Evidence |
| --- | --- | --- | --- | --- | --- |
| `external-gateway-health.tcp-readiness` | `openshell-gateway` | 10 attempts, one second apart | The newly started gateway listener rejects a TCP connection with `ECONNREFUSED` | The probe is read-only. Other errors stop without retry. The Blueprint Runner health operation runs once after the listener opens. | `external-gateway-readiness-retry.json` |
| `mcp-bridge.precleanup-absence` | `mcp-bridge-live-e2e` | 10 attempts, five seconds apart | The single trusted administrator deletion returned, but `openshell sandbox get` still finds the job-owned sandbox while deletion converges | Only the read-only absence observation is retried. The deletion mutation runs once; command errors other than exact not-found stop without retry. Onboarding starts only after absence is confirmed. | `<prefix>-sandbox-absence-retry.json` |
| `mcp-bridge.openclaw-onboard-lifecycle` | `mcp-bridge-live-e2e` | 2 attempts, one second apart | OpenClaw onboarding reports that the new sandbox reached `Ready`, then its first setup command returns the exact OpenShell `phase: Deleting` diagnostic | The retry runs only after trusted deletion, NemoClaw registry reconciliation, and a read-only observation prove the failed sandbox absent. One recreated sandbox is allowed. Signals, timeouts, other phases, missing `Ready` evidence, and all other failures stop without retry. | `openclaw-onboard-lifecycle-retry.json` |
| `mcp-tool-discovery.status` | `mcp-bridge-live-e2e` | 2 attempts, one second apart | `mcp status --tools --json` reports exactly `MCP tool discovery request failed` or `tool discovery timed out after 10s`, and the fixture received no request | Status and tool discovery are read-only. A fixture-visible request, any other detail, a command error, or the second failure stops without retry. | `<agent>-mcp-tool-discovery-retry.json` |
