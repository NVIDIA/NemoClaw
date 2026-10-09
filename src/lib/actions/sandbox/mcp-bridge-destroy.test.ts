// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSandbox: vi.fn(),
  inspectCurrent: vi.fn(),
  joinEntries: vi.fn(),
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
  joinMcpEntriesToOpenShell: mocks.joinEntries,
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
    expect(mocks.joinEntries).not.toHaveBeenCalled();
  });

  it("includes legacy-only source state so retained providers are still reported", async () => {
    const legacy = { github: { ...entry, source: "legacy" } };
    mocks.inspectCurrent.mockReturnValue({
      bridges: {},
      sources: { native: {}, legacy },
    });
    mocks.joinEntries.mockReturnValue({ github: { ...entry, source: "legacy" } });

    await expect(prepareMcpBridgesForDestroy("alpha")).resolves.toMatchObject({
      entries: [{ server: "github", source: "legacy" }],
    });
    expect(mocks.joinEntries).toHaveBeenCalledWith(
      expect.objectContaining({ name: "alpha" }),
      legacy,
      runtimeSelection,
      "inspect legacy MCP destroy state",
    );
    expect(mocks.joinEntries.mock.calls[0]?.[1]).toBe(legacy);
  });

  it("retains providers implicitly when an unreachable sandbox cannot expose source state", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.inspectCurrent.mockImplementationOnce(() => {
      throw new Error("sandbox unreachable with Authorization: Bearer host-secret");
    });

    await expect(prepareMcpBridgesForDestroy("alpha")).resolves.toEqual({ entries: [] });
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("MCP source inventory is incomplete"),
    );
    expect(warning.mock.calls.flat().join("\n")).not.toContain("host-secret");
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
