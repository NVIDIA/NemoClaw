<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Live E2E retry inventory

| Operation | Owner | Limit | Retry condition | Safety basis | Evidence |
| --- | --- | --- | --- | --- | --- |
| `external-gateway-health.tcp-readiness` | `openshell-gateway` | 10 attempts, one second apart | The newly started gateway listener rejects a TCP connection with `ECONNREFUSED` | The probe is read-only. Other errors stop without retry. The Blueprint Runner health operation runs once after the listener opens. | `external-gateway-readiness-retry.json` |
| `mcp-bridge.tool-discovery` | `test/e2e/live/mcp-bridge-tool-discovery.ts` | 2 attempts, one second apart | Discovery reports `failureClass: connection` before any request reaches the fixture | The operation lists tools without calling them. Any fixture request or other failure class stops the retry. | First-attempt and `retry-2` command artifacts plus `*-mcp-tool-discovery-diagnostics.json` |
