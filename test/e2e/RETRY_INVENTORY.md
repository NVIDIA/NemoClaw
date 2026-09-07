<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Live E2E retry inventory

| Operation | Owner | Limit | Retry condition | Safety basis | Evidence |
| --- | --- | --- | --- | --- | --- |
| `external-gateway-health.tcp-readiness` | `openshell-gateway` | 10 attempts, one second apart | The newly started gateway listener rejects a TCP connection with `ECONNREFUSED` | The probe is read-only. Other errors stop without retry. The Blueprint Runner health operation runs once after the listener opens. | `external-gateway-readiness-retry.json` |
| `mcp-tool-discovery.status` | `mcp-bridge-live-e2e` | 2 attempts, one second apart | `mcp status --tools --json` reports exactly `MCP tool discovery request failed` or `tool discovery timed out after 10s`, and the fixture received no request | Status and tool discovery are read-only. A fixture-visible request, any other detail, a command error, or the second failure stops without retry. | `<agent>-mcp-tool-discovery-retry.json` |
