// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setProviderCommandRuntimeHooksForTest } from "../../adapters/openshell/provider-command";
import type { McpBridgeEntry } from "../../state/registry";

const mocks = vi.hoisted(() => ({
  getSandboxOrThrow: vi.fn(),
  runOpenshell: vi.fn(),
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

const runtimeSelection = { gatewayName: "nemoclaw-8091", workspace: "default" };

describe("Hermes MCP recovery guidance", () => {
  beforeEach(() => {
    vi.stubEnv("NEMOCLAW_INVOKED_AS", "nemohermes");
    mocks.getSandboxOrThrow.mockReset().mockReturnValue({
      agent: "hermes",
      gatewayName: "nemoclaw-8091",
      name: "alpha",
    });
    mocks.runOpenshell.mockReset().mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "Hermes gateway is not running under the managed service lifecycle",
    });
    setProviderCommandRuntimeHooksForTest({ runOpenshell: mocks.runOpenshell });
  });

  afterEach(() => {
    setProviderCommandRuntimeHooksForTest({});
    vi.unstubAllEnvs();
  });

  it("uses the invoked CLI name when the managed lifecycle is unavailable", () => {
    expect(() => assertHermesMcpMutationRuntimeCapability("alpha", runtimeSelection)).toThrow(
      "Run `nemohermes alpha recover` and retry.",
    );
  });

  it("pins Hermes MCP lifecycle commands to the recorded runtime target (#10514)", () => {
    vi.stubEnv("OPENSHELL_GATEWAY", "ambient-gateway");
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://ambient.invalid");
    vi.stubEnv("OPENSHELL_GATEWAY_INSECURE", "true");
    vi.stubEnv("OPENSHELL_LOCAL_TLS_DIR", "/ambient/tls");
    vi.stubEnv("OPENSHELL_TOKEN", "ambient-token");
    vi.stubEnv("OPENSHELL_WORKSPACE", "ambient-workspace");
    mocks.runOpenshell.mockImplementation((_args, options) => {
      expect(options).toEqual(
        expect.objectContaining({
          env: expect.objectContaining({
            OPENSHELL_GATEWAY: "nemoclaw-8091",
            OPENSHELL_WORKSPACE: "default",
          }),
          replaceEnv: true,
        }),
      );
      expect(options?.env).not.toHaveProperty("OPENSHELL_GATEWAY_ENDPOINT");
      expect(options?.env).not.toHaveProperty("OPENSHELL_GATEWAY_INSECURE");
      expect(options?.env).not.toHaveProperty("OPENSHELL_LOCAL_TLS_DIR");
      expect(options?.env).not.toHaveProperty("OPENSHELL_TOKEN");
      return {
        status: 0,
        stdout: JSON.stringify({ changed: true, ok: true, reloaded: true }),
        stderr: "",
      };
    });

    expect(() =>
      assertHermesMcpMutationRuntimeCapability("alpha", runtimeSelection),
    ).not.toThrow();
    expect(() => unregisterHermesAdapter("alpha", entry, runtimeSelection)).not.toThrow();
    expect(mocks.runOpenshell).toHaveBeenCalledTimes(2);
  });

  it("refuses host-local recovery when the selected Hermes gateway is not ready (#10514)", () => {
    mocks.runOpenshell.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "Hermes gateway is not running for managed MCP reload",
    });

    expect(() => assertHermesMcpMutationRuntimeCapability("alpha", runtimeSelection)).toThrow(
      "NemoClaw did not attempt host-local supervisor recovery.",
    );
    expect(mocks.runOpenshell).toHaveBeenCalledTimes(3);
  });
});
