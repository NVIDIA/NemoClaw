<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# E2E Retry Inventory

This inventory records bounded operation retries in live E2E tests.

| Operation | Owner | Retry condition | Limit | Idempotence and reconciliation | Evidence |
|---|---|---|---:|---|---|
| OpenClaw MCP tool discovery | `mcp-bridge-live-e2e` | `mcp status --tools --json` reports `MCP tool discovery request failed`, and the fixture received no request | 2 attempts | The status operation is read-only. Before attempt 2, `mcp restart fake` reconciles the committed provider and policy without a host credential. | `openclaw-mcp-tool-discovery-diagnostics.json` records the failure class, reconciliation result, and each attempt. |
