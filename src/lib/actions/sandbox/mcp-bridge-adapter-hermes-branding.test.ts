// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setProviderCommandRuntimeHooksForTest } from "../../adapters/openshell/provider-command";
import type { McpSourceEntry } from "./mcp-bridge-contracts";

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
import { assertAgentMcpTeardownRuntimeCapability } from "./mcp-bridge-adapters";

const entry: McpSourceEntry = {
  server: "github",
  agent: "hermes",
  adapter: "hermes-config",
  url: "https://api.githubcopilot.com/mcp/",
  env: ["GITHUB_TOKEN"],
  providerName: "alpha-mcp-github",
  providerId: "11111111-2222-4333-8444-555555555555",
  policyName: "mcp-bridge-github",
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
    mocks.runOpenshell.mockImplementation((args, options) => {
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
        stdout: JSON.stringify(
          args.includes("probe")
            ? { capabilities: { reconcile_finality: 1 }, ok: true }
            : { changed: true, ok: true, reloaded: true },
        ),
        stderr: "",
      };
    });

    expect(() => assertHermesMcpMutationRuntimeCapability("alpha", runtimeSelection)).not.toThrow();
    expect(() => unregisterHermesAdapter("alpha", entry, runtimeSelection)).not.toThrow();
    expect(mocks.runOpenshell).toHaveBeenCalledTimes(2);
  });

  it("keeps legacy teardown available while add and restart require finality capability", async () => {
    mocks.runOpenshell.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ ok: true }),
      stderr: "",
    });

    expect(() => assertHermesMcpMutationRuntimeCapability("alpha", runtimeSelection)).toThrow(
      "does not provide managed MCP reconcile-finality capability version 1. Rebuild the sandbox",
    );
    await expect(
      assertAgentMcpTeardownRuntimeCapability("alpha", "hermes-config", runtimeSelection),
    ).resolves.toBeUndefined();
    expect(mocks.runOpenshell).toHaveBeenCalledTimes(2);
  });

  it("rejects an unsupported reconcile-finality capability version", () => {
    mocks.runOpenshell.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ capabilities: { reconcile_finality: 2 }, ok: true }),
      stderr: "",
    });

    expect(() => assertHermesMcpMutationRuntimeCapability("alpha", runtimeSelection)).toThrow(
      "reconcile-finality capability version 1",
    );
    expect(mocks.runOpenshell).toHaveBeenCalledOnce();
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
