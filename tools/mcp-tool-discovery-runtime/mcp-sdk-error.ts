// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

import { ToolDiscoveryRuntimeError } from "./tool-discovery-core.ts";

export function normalizeMcpSdkError(error: unknown): unknown {
  return error instanceof McpError && error.code === ErrorCode.RequestTimeout
    ? new ToolDiscoveryRuntimeError("timeout")
    : error;
}
