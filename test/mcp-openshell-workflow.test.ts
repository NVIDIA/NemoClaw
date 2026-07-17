// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { describe, expect, it } from "vitest";

import credentialBoundaryManifest from "../src/lib/actions/sandbox/openshell-child-visible-credentials.v0.0.85.json";
import { validateMcpOpenShellWorkflowBoundary } from "../tools/e2e/mcp-workflow-boundary.mts";

describe("MCP OpenShell workflow boundary", () => {
  // source-shape-contract: compatibility -- Setup guidance must advertise the pinned runtime compatibility boundary
  it("keeps the setup docs aligned with the stable default", () => {
    const setupDocs = fs.readFileSync("docs/deployment/set-up-mcp-bridge.mdx", "utf8");

    expect(setupDocs).toContain(
      `Current NemoClaw builds default to the pinned stable OpenShell \`${credentialBoundaryManifest.openshellVersion}\` release`,
    );
    expect(setupDocs).toContain(
      "The optional OpenShell development channel is compatibility evidence only and is not a shipping target.",
    );
    expect(setupDocs).not.toContain("requires an OpenShell build from current main");
  });

  it("validates the unified stable and explicit-dev MCP workflow contract", () => {
    expect(validateMcpOpenShellWorkflowBoundary()).toEqual([]);
  });
});
