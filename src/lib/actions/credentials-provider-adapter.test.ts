// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import readline from "node:readline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCliOpenShellProviderAdapter } from "../adapters/openshell/provider-adapter-cli";
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
  });
  const importProviderProfile: OpenShellProviderAdapter["importProviderProfile"] = async () => ({
    ok: true,
  });
  const ensureEndpointlessProviderProfile: OpenShellProviderAdapter["ensureEndpointlessProviderProfile"] =
    async () => ({ ok: true });
  const inspectProviderProfile: OpenShellProviderAdapter["inspectProviderProfile"] = async () => ({
    ok: true,
    value: { credentialKeys: [] },
  });
  const deleteProvider: OpenShellProviderAdapter["deleteProvider"] = async () => ({
    ok: true,
  });
  const detachProvider: OpenShellProviderAdapter["detachProvider"] = async () => ({
    ok: true,
  });
  return {
    listProviders: vi.fn(listProviders),
    createProvider: vi.fn(createProvider),
    importProviderProfile: vi.fn(importProviderProfile),
    ensureEndpointlessProviderProfile: vi.fn(ensureEndpointlessProviderProfile),
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

  it("reconciles the OpenAI profile through the injected provider adapter (#9806)", async () => {
    vi.stubEnv("OPENAI_API_KEY", "host-only-value");
    const adapter = providerAdapter();

    const result = await runCredentialsAddAction(
      {
        provider: "openai-prod",
        type: "openai",
        credentials: ["OPENAI_API_KEY"],
        configPairs: [],
        fromExisting: false,
      },
      { providerAdapter: adapter },
    );

    expect(result.exitCode).toBe(0);
    expect(adapter.ensureEndpointlessProviderProfile).toHaveBeenCalledWith({
      target: { kind: "selected" },
      profileType: "openai",
      profilePath: expect.stringMatching(/provider-profiles\/openai\.yaml$/u),
      inferenceCapable: true,
      timeoutMs: 30_000,
    });
    expect(adapter.createProvider).toHaveBeenCalledOnce();
  });

  it("does not create an OpenAI provider after incompatible profile reconciliation (#9806)", async () => {
    vi.stubEnv("OPENAI_API_KEY", "host-only-value");
    const ensureEndpointlessProviderProfile: OpenShellProviderAdapter["ensureEndpointlessProviderProfile"] =
      async () => ({
        ok: false,
        error: {
          kind: "command",
          reason: "profile_incompatible",
          message: "The installed endpointless profile does not match.",
        },
      });
    const adapter = providerAdapter({
      ensureEndpointlessProviderProfile: vi.fn(ensureEndpointlessProviderProfile),
    });

    const result = await runCredentialsAddAction(
      {
        provider: "openai-prod",
        type: "openai",
        credentials: ["OPENAI_API_KEY"],
        configPairs: [],
        fromExisting: false,
      },
      { providerAdapter: adapter },
    );

    expect(result.exitCode).toBe(1);
    expect(adapter.createProvider).not.toHaveBeenCalled();
  });

  it("does not create a provider from an incompatible bundled profile (#9806)", async () => {
    vi.stubEnv("TAVILY_API_KEY", "host-only-value");
    const importProviderProfile: OpenShellProviderAdapter["importProviderProfile"] = async () => ({
      ok: false,
      error: {
        kind: "command",
        reason: "profile_incompatible",
        message: "The OpenShell provider profile does not match the checked-in boundary.",
      },
    });
    const adapter = providerAdapter({ importProviderProfile: vi.fn(importProviderProfile) });

    const result = await runCredentialsAddAction(
      {
        provider: "tavily-prod",
        type: "tavily",
        credentials: ["TAVILY_API_KEY"],
        configPairs: [],
        fromExisting: false,
      },
      { providerAdapter: adapter },
    );

    expect(result.exitCode).toBe(1);
    expect(result.failureLines).toContain(
      "  OpenShell provider profile 'tavily' does not match NemoClaw's checked-in credential boundary.",
    );
    expect(adapter.createProvider).not.toHaveBeenCalled();
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
    expect(result.outputLines).toContain("    Inspect: `nemoclaw <sandbox> channels list`");
    expect(result.outputLines).toContain(
      "    Retire and clear credentials: `nemoclaw <sandbox> channels remove <channel>`",
    );
    expect(result.outputLines).toContain(
      "    Pause without clearing credentials: `nemoclaw <sandbox> channels stop <channel>`",
    );
  });

  it.each([
    ["OSC control", "alpha\n\u001b]52;c;YXR0YWNr\u0007"],
    ["invalid name", "alpha\nbad/name"],
  ])("does not render an unsafe gateway provider inventory: %s (#9806)", async (_case, output) => {
    const adapter = createCliOpenShellProviderAdapter({
      run: () => ({ status: 0, stdout: output }),
    });

    const result = await runCredentialsListAction("nemoclaw", { providerAdapter: adapter });

    expect(result.exitCode).toBe(1);
    expect(result.failureLines).toContain("  OpenShell returned an invalid provider inventory.");
    expect(result.outputLines).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(output);
  });

  it.each([
    [
      "authentication",
      "OpenShell could not authenticate the provider operation.",
      false,
      undefined,
    ],
    ["schema", "The OpenShell CLI and gateway provider schemas do not match.", false, undefined],
    ["timeout", "The OpenShell provider operation timed out.", false, undefined],
    ["command", "OpenShell rejected the provider query.", false, undefined],
    ["transport", "OpenShell could not start the provider operation.", false, "process_start"],
    [
      "transport",
      "The selected OpenShell gateway identity does not match the recorded identity.",
      false,
      "identity_mismatch",
    ],
    ["transport", "OpenShell could not reach the selected gateway.", true, "unreachable"],
  ] as const)(
    "uses the typed %s provider-list failure for recovery guidance (#9806)",
    async (kind, message, includesStartGuidance, reason) => {
      const listProviders: OpenShellProviderAdapter["listProviders"] = async () => ({
        ok: false,
        error:
          kind === "command"
            ? { kind, reason: "failed", message }
            : kind === "transport"
              ? { kind, reason, message }
              : { kind, message },
      });
      const adapter = providerAdapter({ listProviders: vi.fn(listProviders) });

      const result = await runCredentialsListAction("nemoclaw", { providerAdapter: adapter });
      const failure = result.failureLines.join("\n");

      expect(result.exitCode).toBe(1);
      expect(failure).toContain(message);
      expect(result.failureLines).toHaveLength(includesStartGuidance ? 3 : 2);
    },
  );

  it("rejects an invalid reset provider before prompting or gateway mutation (#9806)", async () => {
    const recoverNamedGatewayRuntime = vi.fn(async () => ({ recovered: true }));
    setGlobalCliActionRuntimeHooksForTest({
      recoverNamedGatewayRuntime,
      recordExtraProvider: () => true,
      forgetExtraProvider: () => true,
      listManagedMcpCredentialReservations: () => [],
    });
    const promptSpy = vi.spyOn(readline, "createInterface").mockImplementation(() => {
      throw new Error("credentials reset prompted for an invalid provider name");
    });
    const adapter = providerAdapter();

    try {
      const result = await runCredentialsResetAction(
        { provider: "bad name/with*chars", confirmed: false },
        { providerAdapter: adapter },
      );

      expect(result).toEqual({
        exitCode: 1,
        outputLines: [],
        failureLines: [
          "  Provider name must be 1-128 chars, start with a letter, and use only letters, digits, '.', '_', or '-'.",
        ],
      });
      expect(promptSpy).not.toHaveBeenCalled();
      expect(recoverNamedGatewayRuntime).not.toHaveBeenCalled();
      expect(adapter.deleteProvider).not.toHaveBeenCalled();
    } finally {
      promptSpy.mockRestore();
    }
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
        return { ok: true };
      });
    const detachProvider = vi.fn<OpenShellProviderAdapter["detachProvider"]>(async () => {
      operations.push("detach:alpha");
      return { ok: true };
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

  it("reports recovery for sandboxes detached before final deletion fails (#9806)", async () => {
    const deleteProvider = vi
      .fn<OpenShellProviderAdapter["deleteProvider"]>()
      .mockResolvedValueOnce({
        ok: false,
        error: {
          kind: "command",
          reason: "attached",
          message: "provider remains attached",
          attachedSandboxes: ["alpha", "beta"],
        },
      })
      .mockResolvedValueOnce({
        ok: false,
        error: {
          kind: "transport",
          reason: "unreachable",
          message: "OpenShell could not reach the selected gateway.",
        },
      });
    const detachProvider = vi.fn<OpenShellProviderAdapter["detachProvider"]>(async () => ({
      ok: true,
    }));
    const adapter = providerAdapter({ deleteProvider, detachProvider });

    const result = await runCredentialsResetAction(
      { provider: "custom-provider", confirmed: true },
      { providerAdapter: adapter },
    );

    const failure = result.failureLines.join("\n");
    expect(result.exitCode).toBe(1);
    expect(failure).toContain(
      "Provider 'custom-provider' was detached from sandbox(es): alpha, beta, but provider removal was not confirmed.",
    );
    expect(failure).toContain(
      "Re-run 'nemoclaw credentials reset custom-provider' to complete provider removal.",
    );
    expect(failure).toContain("nemoclaw alpha rebuild");
    expect(failure).toContain("nemoclaw beta rebuild");
  });

  it("reports the typed detach failure that blocks provider removal (#9806)", async () => {
    const deleteProvider = vi
      .fn<OpenShellProviderAdapter["deleteProvider"]>()
      .mockResolvedValueOnce({
        ok: false,
        error: {
          kind: "command",
          reason: "attached",
          message: "provider remains attached",
          attachedSandboxes: ["alpha"],
        },
      })
      .mockResolvedValueOnce({
        ok: false,
        error: { kind: "command", reason: "failed", message: "provider deletion failed" },
      });
    const detachProvider = vi.fn<OpenShellProviderAdapter["detachProvider"]>(async () => ({
      ok: false,
      error: {
        kind: "authentication",
        message: "OpenShell could not authenticate the provider operation.",
      },
    }));
    const adapter = providerAdapter({ deleteProvider, detachProvider });

    const result = await runCredentialsResetAction(
      { provider: "custom-provider", confirmed: true },
      { providerAdapter: adapter },
    );

    expect(result.exitCode).toBe(1);
    expect(result.failureLines).toContain(
      "  Could not detach provider 'custom-provider' from sandbox 'alpha': OpenShell could not authenticate the provider operation.",
    );
    expect(result.failureLines).toContain("  provider deletion failed");
  });

  it("cleans local state when concurrent deletion settles detach recovery (#9806)", async () => {
    const forgetExtraProvider = vi.fn(() => true);
    setGlobalCliActionRuntimeHooksForTest({
      recoverNamedGatewayRuntime: async () => ({ recovered: true }),
      recordExtraProvider: () => true,
      forgetExtraProvider,
      listManagedMcpCredentialReservations: () => [],
    });
    const deleteProvider = vi
      .fn<OpenShellProviderAdapter["deleteProvider"]>()
      .mockResolvedValueOnce({
        ok: false,
        error: {
          kind: "command",
          reason: "attached",
          message: "provider remains attached",
          attachedSandboxes: ["alpha"],
        },
      })
      .mockResolvedValueOnce({
        ok: false,
        error: { kind: "command", reason: "not_found", message: "provider not found" },
      });
    const detachProvider = vi.fn<OpenShellProviderAdapter["detachProvider"]>(async () => ({
      ok: false,
      error: {
        kind: "authentication",
        message: "OpenShell could not authenticate the provider operation.",
      },
    }));
    const adapter = providerAdapter({ deleteProvider, detachProvider });

    const result = await runCredentialsResetAction(
      { provider: "custom-provider", confirmed: true },
      { providerAdapter: adapter },
    );

    expect(result.exitCode).toBe(0);
    expect(result.outputLines).toContain(
      "  Provider 'custom-provider' is already absent from the OpenShell gateway. Local state was cleaned up.",
    );
    expect(result.outputLines.join("\n")).not.toContain("Detach it with");
    expect(detachProvider).toHaveBeenCalledOnce();
    expect(forgetExtraProvider).toHaveBeenCalledWith("custom-provider");
  });

  it("reports final attachments after successful detach recovery (#9806)", async () => {
    const deleteProvider = vi
      .fn<OpenShellProviderAdapter["deleteProvider"]>()
      .mockResolvedValueOnce({
        ok: false,
        error: {
          kind: "command",
          reason: "attached",
          message: "provider remains attached",
          attachedSandboxes: ["alpha"],
        },
      })
      .mockResolvedValueOnce({
        ok: false,
        error: {
          kind: "command",
          reason: "attached",
          message: "provider has a new attachment",
          attachedSandboxes: ["beta"],
        },
      });
    const detachProvider = vi.fn<OpenShellProviderAdapter["detachProvider"]>(async () => ({
      ok: true,
    }));
    const adapter = providerAdapter({ deleteProvider, detachProvider });

    const result = await runCredentialsResetAction(
      { provider: "custom-provider", confirmed: true },
      { providerAdapter: adapter },
    );

    expect(result.exitCode).toBe(1);
    expect(result.failureLines).toContain(
      "  'custom-provider' is still attached to sandbox(es): beta.",
    );
    expect(result.failureLines).toContain(
      "  Detach it with 'openshell sandbox provider detach <sandbox> custom-provider'",
    );
    expect(result.failureLines).toContain(
      "  for each, then re-run 'nemoclaw credentials reset custom-provider'.",
    );
  });

  it.each([
    ["absent", undefined],
    ["empty", []],
  ] as const)(
    "does not detach an unvalidated %s attachment list (#9806)",
    async (_label, attachedSandboxes) => {
      const deleteProvider = vi.fn<OpenShellProviderAdapter["deleteProvider"]>().mockResolvedValue({
        ok: false,
        error: {
          kind: "command",
          reason: "attached",
          message: "provider remains attached",
          ...(attachedSandboxes ? { attachedSandboxes: [...attachedSandboxes] } : {}),
        },
      });
      const detachProvider = vi.fn<OpenShellProviderAdapter["detachProvider"]>();
      const adapter = providerAdapter({ deleteProvider, detachProvider });

      const result = await runCredentialsResetAction(
        { provider: "custom-provider", confirmed: true },
        { providerAdapter: adapter },
      );

      expect(result.exitCode).toBe(1);
      expect(deleteProvider).toHaveBeenCalledOnce();
      expect(detachProvider).not.toHaveBeenCalled();
    },
  );

  it("does not partially detach a mixed valid and invalid attachment list (#9806)", async () => {
    const deleteProvider = vi.fn<OpenShellProviderAdapter["deleteProvider"]>().mockResolvedValue({
      ok: false,
      error: {
        kind: "command",
        reason: "attached",
        message: "provider remains attached",
        attachedSandboxes: ["alpha", "invalid/name"],
      },
    });
    const detachProvider = vi.fn<OpenShellProviderAdapter["detachProvider"]>();
    const adapter = providerAdapter({ deleteProvider, detachProvider });

    const result = await runCredentialsResetAction(
      { provider: "custom-provider", confirmed: true },
      { providerAdapter: adapter },
    );

    expect(result.exitCode).toBe(1);
    expect(deleteProvider).toHaveBeenCalledOnce();
    expect(detachProvider).not.toHaveBeenCalled();
  });
});
