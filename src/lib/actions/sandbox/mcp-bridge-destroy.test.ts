// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSandbox: vi.fn(),
  inspectCurrent: vi.fn(),
  inspectLegacy: vi.fn(),
  runtimeSelection: vi.fn(),
}));

vi.mock("./mcp-bridge-state", () => ({
  getSandboxOrThrow: mocks.getSandbox,
}));
vi.mock("./mcp-bridge-provider", () => ({
  getMcpProviderInspectionRuntimeSelection: mocks.runtimeSelection,
}));
vi.mock("./mcp-bridge-source", () => ({
  inspectSourceBridgeState: mocks.inspectCurrent,
  inspectLegacyBridgeState: mocks.inspectLegacy,
}));

import { prepareMcpBridgesForDestroy } from "./mcp-bridge-destroy";

const runtimeSelection = {
  gatewayName: "nemoclaw-19080",
  workspace: "default",
  localTlsDir: "/authority/tls",
};
const entry = {
  server: "github",
  agent: "openclaw",
  adapter: "openclaw-config" as const,
  url: "https://api.githubcopilot.com/mcp/",
  env: ["GITHUB_TOKEN"],
  providerName: "alpha-mcp-github",
  providerId: "11111111-2222-4333-8444-555555555555",
  policyName: "mcp-bridge-github",
};

describe("source-backed MCP destroy preparation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSandbox.mockReturnValue({ name: "alpha", agent: "openclaw" });
    mocks.runtimeSelection.mockReturnValue(runtimeSelection);
    mocks.inspectCurrent.mockReturnValue({
      bridges: { github: entry },
      sources: { native: { github: entry }, legacy: {} },
    });
  });

  it("derives a fresh destroy inventory directly from current sources", async () => {
    await expect(prepareMcpBridgesForDestroy("alpha")).resolves.toEqual({
      entries: [entry],
      runtimeSelection,
    });
    expect(mocks.inspectCurrent).toHaveBeenCalledWith(
      expect.objectContaining({ name: "alpha" }),
      runtimeSelection,
    );
    expect(mocks.inspectLegacy).not.toHaveBeenCalled();
  });

  it("includes legacy-only source state so retained providers are still reported", async () => {
    mocks.inspectCurrent.mockReturnValue({
      bridges: {},
      sources: { native: {}, legacy: { github: { ...entry, source: "legacy" } } },
    });
    mocks.inspectLegacy.mockReturnValue({
      bridges: { github: { ...entry, source: "legacy" } },
      sources: { native: {}, legacy: { github: { ...entry, source: "legacy" } } },
    });

    await expect(prepareMcpBridgesForDestroy("alpha")).resolves.toMatchObject({
      entries: [{ server: "github", source: "legacy" }],
    });
  });

  it("retains providers implicitly when an unreachable sandbox cannot expose source state", async () => {
    mocks.inspectCurrent.mockImplementationOnce(() => {
      throw new Error("sandbox unreachable");
    });

    await expect(prepareMcpBridgesForDestroy("alpha")).resolves.toEqual({ entries: [] });
  });

  it("preserves an explicitly supplied runtime target for empty cleanup", async () => {
    mocks.inspectCurrent.mockImplementationOnce(() => {
      throw new Error("sandbox unreachable");
    });

    await expect(prepareMcpBridgesForDestroy("alpha", { runtimeSelection })).resolves.toEqual({
      entries: [],
      runtimeSelection,
    });
  });

  it("continues conservative destroy when runtime authority is unavailable", async () => {
    mocks.runtimeSelection.mockImplementationOnce(() => {
      throw new Error("gateway unavailable");
    });

    await expect(prepareMcpBridgesForDestroy("alpha")).resolves.toEqual({ entries: [] });
    expect(mocks.inspectCurrent).not.toHaveBeenCalled();
  });
});
