// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { validateMcpOpenShellWorkflowBoundary } from "../../tools/e2e/mcp-workflow-boundary.mts";

describe("MCP OpenShell workflow boundary", () => {
  it("validates the unified stable and explicit-dev MCP workflow contract", () => {
    expect(validateMcpOpenShellWorkflowBoundary()).toEqual([]);
  });
});
