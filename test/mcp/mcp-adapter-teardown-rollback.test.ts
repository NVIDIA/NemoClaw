// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpBridgeEntry, SandboxEntry } from "../../src/lib/state/registry";

const testState = vi.hoisted(() => ({
  observeCredentialRevision: vi.fn(),
  registerAdapter: vi.fn(),
}));

vi.mock("../../src/lib/actions/sandbox/mcp-bridge-provider-readiness", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/lib/actions/sandbox/mcp-bridge-provider-readiness")
    >();
  return {
    ...actual,
    observeMcpCredentialRevision: testState.observeCredentialRevision,
  };
});

vi.mock("../../src/lib/actions/sandbox/mcp-bridge-adapters", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/lib/actions/sandbox/mcp-bridge-adapters")>();
  return {
    ...actual,
    registerAgentAdapterAtCurrentCredentialRevision: testState.registerAdapter,
  };
});

import { rollbackScrubbedMcpAdapters } from "../../src/lib/actions/sandbox/mcp-bridge-adapter-teardown";

const entry: McpBridgeEntry = {
  server: "github",
  agent: "openclaw",
  adapter: "mcporter",
  url: "https://8.8.8.8/github",
  env: ["GITHUB_TOKEN"],
  providerName: "alpha-mcp-github",
  providerId: "11111111-2222-4333-8444-555555555555",
  policyName: "mcp-bridge-github",
  addedAt: "2026-06-27T00:00:00.000Z",
};
const sandbox: SandboxEntry = { name: "alpha" };
const runtimeSelection = { gatewayName: "nemoclaw-8091", workspace: "default" } as const;

describe("MCP adapter teardown rollback", () => {
  beforeEach(() => {
    testState.observeCredentialRevision.mockReset();
    testState.registerAdapter.mockReset();
  });

  it("restores the adapter with the fresh opaque credential revision (#10300)", () => {
    const opaqueRevision = "v4067750153477477215";
    testState.observeCredentialRevision.mockReturnValue(opaqueRevision);

    const failures = rollbackScrubbedMcpAdapters(
      "alpha",
      sandbox,
      [{ ...entry, credentialRevision: "v1" }],
      runtimeSelection,
    );

    expect(failures).toEqual([]);
    expect(testState.registerAdapter).toHaveBeenCalledWith(
      "alpha",
      "mcporter",
      expect.objectContaining({ server: "github" }),
      runtimeSelection,
      {},
      opaqueRevision,
      { replaceExisting: true, teardownRollback: true },
    );
  });

  it.each(["absent", "canonical"] as const)(
    "reports rollback failure when fresh credential authority is %s (#10300)",
    (observation) => {
      testState.observeCredentialRevision.mockReturnValue(observation);

      const failures = rollbackScrubbedMcpAdapters(
        "alpha",
        sandbox,
        [{ ...entry, credentialRevision: "v4067750153477477215" }],
        runtimeSelection,
      );

      expect(failures).toEqual([
        "Could not restore the managed adapter entry for MCP server 'github' without its observed credential revision.",
      ]);
      expect(testState.registerAdapter).not.toHaveBeenCalled();
    },
  );
});
