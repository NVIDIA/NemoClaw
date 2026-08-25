// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { McpBridgeEntry, SandboxEntry } from "../../state/registry";

const mocks = vi.hoisted(() => ({
  observeMcpCredentialRevision: vi.fn(),
  registerAgentAdapter: vi.fn(),
  unregisterAgentAdapter: vi.fn(),
}));

vi.mock("./mcp-bridge-adapters", () => ({
  registerAgentAdapter: mocks.registerAgentAdapter,
  unregisterAgentAdapter: mocks.unregisterAgentAdapter,
}));

vi.mock("./mcp-bridge-provider-readiness", () => ({
  observeMcpCredentialRevision: mocks.observeMcpCredentialRevision,
}));

import {
  rollbackScrubbedMcpAdapters,
  scrubManagedMcpAdapterOrThrow,
} from "./mcp-bridge-adapter-teardown";

const sandbox = { agent: "hermes" } as SandboxEntry;
const entry: McpBridgeEntry = {
  server: "github",
  agent: "hermes",
  adapter: "hermes-config",
  url: "https://api.githubcopilot.com/mcp/",
  env: ["GITHUB_TOKEN"],
  providerName: "alpha-mcp-github",
  policyName: "mcp-bridge-github",
  addedAt: new Date(0).toISOString(),
};

describe("MCP adapter teardown rollback", () => {
  beforeEach(() => {
    mocks.observeMcpCredentialRevision.mockReset().mockReturnValue("v12");
    mocks.registerAgentAdapter.mockReset();
    mocks.unregisterAgentAdapter.mockReset().mockReturnValue("removed");
  });

  it("restores the revision observed before a later teardown step fails (#10155)", () => {
    const rollbackState = scrubManagedMcpAdapterOrThrow("alpha", sandbox, entry);

    expect(mocks.observeMcpCredentialRevision.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.unregisterAgentAdapter.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(rollbackScrubbedMcpAdapters("alpha", sandbox, [rollbackState])).toEqual([]);
    expect(mocks.registerAgentAdapter).toHaveBeenCalledWith(
      "alpha",
      "hermes-config",
      entry,
      {},
      {
        credentialRevision: "v12",
        replaceExisting: true,
        teardownRollback: true,
      },
    );
  });

  it("does not write a canonical placeholder when no attached revision can be proved", () => {
    mocks.observeMcpCredentialRevision.mockReturnValue("absent");

    const rollbackState = scrubManagedMcpAdapterOrThrow("alpha", sandbox, entry);

    expect(rollbackScrubbedMcpAdapters("alpha", sandbox, [rollbackState])).toEqual([
      "Could not prove an attached credential revision while rolling back MCP adapter 'github'.",
    ]);
    expect(mocks.unregisterAgentAdapter).toHaveBeenCalledOnce();
    expect(mocks.registerAgentAdapter).not.toHaveBeenCalled();
  });
});
