// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { McpBridgeEntry } from "../../state/registry";

const mocks = vi.hoisted(() => ({
  getSandboxOrThrow: vi.fn(),
  isShieldsDown: vi.fn(),
  runOpenshellProviderCommand: vi.fn(),
}));

vi.mock("../../adapters/openshell/provider-command", () => ({
  runOpenshellProviderCommand: mocks.runOpenshellProviderCommand,
}));

vi.mock("../../shields", () => ({
  isShieldsDown: mocks.isShieldsDown,
}));

vi.mock("./mcp-bridge-state", () => ({
  getSandboxOrThrow: mocks.getSandboxOrThrow,
}));

import {
  assertHermesMcpMutationRuntimeCapability,
  unregisterHermesAdapter,
} from "./mcp-bridge-adapter-hermes";

const entry: McpBridgeEntry = {
  server: "github",
  agent: "hermes",
  adapter: "hermes-config",
  url: "https://api.githubcopilot.com/mcp/",
  env: ["GITHUB_TOKEN"],
  providerName: "alpha-mcp-github",
  providerId: "11111111-2222-4333-8444-555555555555",
  policyName: "mcp-bridge-github",
  addedAt: new Date(0).toISOString(),
};

describe("Hermes MCP recovery guidance", () => {
  beforeEach(() => {
    vi.stubEnv("NEMOCLAW_INVOKED_AS", "nemohermes");
    mocks.getSandboxOrThrow.mockReset().mockReturnValue({
      agent: "hermes",
      gatewayName: "nemoclaw-8091",
      name: "alpha",
    });
    mocks.isShieldsDown.mockReset().mockReturnValue(true);
    mocks.runOpenshellProviderCommand.mockReset().mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "Hermes gateway is not running under the managed service lifecycle",
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the invoked CLI name when the managed lifecycle is unavailable", () => {
    expect(() => assertHermesMcpMutationRuntimeCapability("alpha")).toThrow(
      "Run `nemohermes alpha recover` and retry.",
    );
  });

  it("pins Hermes MCP lifecycle commands to the recorded runtime target (#10514)", () => {
    vi.stubEnv("OPENSHELL_GATEWAY", "ambient-gateway");
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://ambient.invalid");
    vi.stubEnv("OPENSHELL_GATEWAY_INSECURE", "true");
    vi.stubEnv("OPENSHELL_WORKSPACE", "ambient-workspace");
    mocks.runOpenshellProviderCommand.mockImplementation((_args, options) => {
      expect(options?.runtimeSelection).toEqual({
        gatewayName: "nemoclaw-8091",
        workspace: "default",
      });
      return {
        status: 0,
        stdout: JSON.stringify({ changed: true, ok: true, reloaded: true }),
        stderr: "",
      };
    });

    expect(() => assertHermesMcpMutationRuntimeCapability("alpha")).not.toThrow();
    expect(() => unregisterHermesAdapter("alpha", entry)).not.toThrow();
    expect(mocks.runOpenshellProviderCommand).toHaveBeenCalledTimes(2);
  });
});
