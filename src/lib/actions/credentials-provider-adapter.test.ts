// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OpenShellProviderAdapter } from "../adapters/openshell/provider-adapter";
import { setGlobalCliActionRuntimeHooksForTest } from "./global";
import { runCredentialsAddAction } from "./credentials-add";
import { runCredentialsListAction } from "./credentials/list";
import { runCredentialsResetAction } from "./credentials/reset";

vi.mock("../onboard/gateway-teardown-authority", () => ({
  resolveGatewayCredentialMutationAuthority: vi.fn(() => ({})),
}));

vi.mock("../state/mcp-lifecycle-lock/credential-ownership", () => ({
  withMcpCredentialOwnershipLock: <T>(operation: () => Promise<T> | T) => operation(),
}));

function providerAdapter(
  overrides: Partial<OpenShellProviderAdapter> = {},
): OpenShellProviderAdapter {
  const listProviders: OpenShellProviderAdapter["listProviders"] = async () => ({
    ok: true,
    value: { names: [] },
  });
  const createProvider: OpenShellProviderAdapter["createProvider"] = async () => ({
    ok: true,
    value: { state: "created" },
  });
  const importProviderProfile: OpenShellProviderAdapter["importProviderProfile"] = async () => ({
    ok: true,
    value: { state: "imported" },
  });
  const inspectProviderProfile: OpenShellProviderAdapter["inspectProviderProfile"] = async () => ({
    ok: true,
    value: { credentialKeys: [] },
  });
  const deleteProvider: OpenShellProviderAdapter["deleteProvider"] = async () => ({
    ok: true,
    value: { state: "deleted" },
  });
  const detachProvider: OpenShellProviderAdapter["detachProvider"] = async () => ({
    ok: true,
    value: { state: "detached" },
  });
  return {
    listProviders: vi.fn(listProviders),
    createProvider: vi.fn(createProvider),
    importProviderProfile: vi.fn(importProviderProfile),
    inspectProviderProfile: vi.fn(inspectProviderProfile),
    deleteProvider: vi.fn(deleteProvider),
    detachProvider: vi.fn(detachProvider),
    ...overrides,
  };
}

describe("credential actions use typed OpenShell provider results", () => {
  beforeEach(() => {
    setGlobalCliActionRuntimeHooksForTest({
      recoverNamedGatewayRuntime: async () => ({ recovered: true }),
      recordExtraProvider: () => true,
      forgetExtraProvider: () => true,
      listManagedMcpCredentialReservations: () => [],
    });
  });

  afterEach(() => {
    setGlobalCliActionRuntimeHooksForTest({});
    vi.unstubAllEnvs();
  });

  it("registers validated credential material without returning its value (#9806)", async () => {
    vi.stubEnv("CUSTOM_TOKEN", "credential-value");
    const adapter = providerAdapter();

    const result = await runCredentialsAddAction(
      {
        provider: "custom-provider",
        type: "generic",
        credentials: ["CUSTOM_TOKEN"],
        configPairs: ["region=us-west"],
        fromExisting: false,
      },
      { providerAdapter: adapter },
    );

    expect(result.exitCode).toBe(0);
    expect(adapter.createProvider).toHaveBeenCalledWith({
      target: { kind: "selected" },
      name: "custom-provider",
      type: "generic",
      credentials: [{ name: "CUSTOM_TOKEN", value: "credential-value" }],
      config: [{ key: "region", value: "us-west" }],
      fromExisting: false,
      timeoutMs: 30_000,
    });
    expect(JSON.stringify(result)).not.toContain("credential-value");
  });

  it("lists credentials separately from messaging bridge providers (#9806)", async () => {
    const listProviders: OpenShellProviderAdapter["listProviders"] = async () => ({
      ok: true,
      value: { names: ["alpha-telegram-bridge", "zeta", "alpha"] },
    });
    const adapter = providerAdapter({
      listProviders: vi.fn(listProviders),
    });

    const result = await runCredentialsListAction("nemoclaw", { providerAdapter: adapter });

    expect(result.exitCode).toBe(0);
    expect(result.outputLines).toContain("    alpha");
    expect(result.outputLines).toContain("    zeta");
    expect(result.outputLines.join("\n")).not.toContain("alpha-telegram-bridge");
  });

  it("preserves detach-before-delete recovery with typed failures (#9806)", async () => {
    const operations: string[] = [];
    const deleteProvider = vi
      .fn<OpenShellProviderAdapter["deleteProvider"]>()
      .mockImplementationOnce(async () => {
        operations.push("delete:first");
        return {
          ok: false,
          error: {
            kind: "command",
            reason: "attached",
            message: "provider remains attached",
            attachedSandboxes: ["alpha"],
          },
        };
      })
      .mockImplementationOnce(async () => {
        operations.push("delete:retry");
        return { ok: true, value: { state: "deleted" } };
      });
    const detachProvider = vi.fn<OpenShellProviderAdapter["detachProvider"]>(async () => {
      operations.push("detach:alpha");
      return { ok: true, value: { state: "detached" } };
    });
    const adapter = providerAdapter({ deleteProvider, detachProvider });

    const result = await runCredentialsResetAction(
      { provider: "custom-provider", confirmed: true },
      { providerAdapter: adapter },
    );

    expect(result.exitCode).toBe(0);
    expect(operations).toEqual(["delete:first", "detach:alpha", "delete:retry"]);
    expect(detachProvider).toHaveBeenCalledWith({
      target: { kind: "selected" },
      providerName: "custom-provider",
      sandboxName: "alpha",
      timeoutMs: 30_000,
    });
  });
});
