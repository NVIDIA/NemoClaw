// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { describe, expect, it } from "vitest";

import { validateMcpOpenShellWorkflowBoundary } from "../tools/e2e/mcp-workflow-boundary.mts";

describe("MCP OpenShell workflow boundary", () => {
  it("keeps the setup docs aligned with the stable default", () => {
    const setupDocs = fs.readFileSync("docs/deployment/set-up-mcp-bridge.mdx", "utf8");

    expect(setupDocs).toContain("defaults to the pinned OpenShell v0.0.72 stable release");
    expect(setupDocs).toContain(
      "The explicit dev channel is reserved for current-main compatibility coverage.",
    );
    expect(setupDocs).not.toContain("requires an OpenShell build from current main");
  });

  it("validates the unified stable and explicit-dev MCP workflow contract", () => {
    expect(validateMcpOpenShellWorkflowBoundary()).toEqual([]);
  });
});
