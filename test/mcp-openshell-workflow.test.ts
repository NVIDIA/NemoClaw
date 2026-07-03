// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { describe, expect, it } from "vitest";

import credentialBoundaryManifest from "../src/lib/actions/sandbox/openshell-child-visible-credentials.v0.0.72.json";
import { validateMcpOpenShellWorkflowBoundary } from "../tools/e2e/mcp-workflow-boundary.mts";
import { readYaml } from "./helpers/e2e-workflow-contract";

type Blueprint = {
  min_openshell_version?: string;
  max_openshell_version?: string;
};

type E2eWorkflow = {
  jobs?: Record<string, { env?: Record<string, unknown> }>;
};

describe("MCP OpenShell workflow boundary", () => {
  it("keeps the setup docs aligned with the stable default", () => {
    const setupDocs = fs.readFileSync("docs/deployment/set-up-mcp-bridge.mdx", "utf8");

    expect(setupDocs).toContain(
      `NemoClaw v0.0.74 defaults to the pinned stable OpenShell \`${credentialBoundaryManifest.openshellVersion}\` release`,
    );
    expect(setupDocs).toContain(
      "The optional OpenShell development channel is compatibility evidence only and is not a shipping target.",
    );
    expect(setupDocs).not.toContain("requires an OpenShell build from current main");
  });

  it("validates the unified stable and explicit-dev MCP workflow contract", () => {
    expect(validateMcpOpenShellWorkflowBoundary()).toEqual([]);
  });

  it("keeps the credential manifest aligned with every shipping OpenShell version pin", () => {
    const expected = credentialBoundaryManifest.openshellVersion;
    const blueprint = readYaml<Blueprint>("nemoclaw-blueprint/blueprint.yaml");
    const workflow = readYaml<E2eWorkflow>(".github/workflows/e2e.yaml");

    expect(blueprint.min_openshell_version).toBe(expected);
    expect(blueprint.max_openshell_version).toBe(expected);
    expect(
      workflow.jobs?.["openshell-gateway-auth-contract"]?.env?.NEMOCLAW_OPENSHELL_PIN_VERSION,
    ).toBe(expected);
  });
});
