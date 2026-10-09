// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OpenShellProviderAdapter } from "../adapters/openshell/provider-adapter";
import { setGlobalCliActionRuntimeHooksForTest } from "./global";
import { runCredentialsResetAction } from "./credentials/reset";

vi.mock("../onboard/gateway-teardown-authority", () => ({
  resolveGatewayCredentialMutationAuthority: vi.fn(() => ({})),
}));

function adapter(
  deleteProvider: OpenShellProviderAdapter["deleteProvider"],
): OpenShellProviderAdapter {
  return {
    getProvider: vi.fn(async () => ({
      ok: false,
      error: { kind: "command", reason: "not_found", message: "absent" },
    })),
    deleteProvider: vi.fn(deleteProvider),
  } as unknown as OpenShellProviderAdapter;
}

describe("native NVIDIA credential reset ownership", () => {
  beforeEach(() => {
    setGlobalCliActionRuntimeHooksForTest({
      recoverNamedGatewayRuntime: async () => ({ recovered: true }),
      forgetExtraProvider: () => true,
    });
  });

  afterEach(() => setGlobalCliActionRuntimeHooksForTest({}));

  it.each([
    ["present", { ok: true as const }],
    [
      "absent",
      {
        ok: false as const,
        error: {
          kind: "command" as const,
          reason: "not_found" as const,
          message: "provider not found",
        },
      },
    ],
  ])(
    "blocks reset when a recorded sandbox remains and the provider is %s (#12562)",
    async (_providerState, deleteResult) => {
      const operations: string[] = [];
      const deleteProvider = vi.fn<OpenShellProviderAdapter["deleteProvider"]>(async () => {
        operations.push("delete");
        return deleteResult;
      });
      const clearNativeNvidiaProviderAuthority = vi.fn(() => operations.push("clear-authority"));
      const listNativeNvidiaProviderAttachmentSandboxNames = vi.fn((gatewayName: string) =>
        gatewayName === "nemoclaw" ? ["alpha"] : [],
      );

      const result = await runCredentialsResetAction(
        { provider: "nvidia-prod", confirmed: true },
        {
          providerAdapter: adapter(deleteProvider),
          clearNativeNvidiaProviderAuthority,
          listNativeNvidiaProviderAttachmentSandboxNames,
          withGatewayRouteMutationLock: async (_gatewayName, operation) => {
            operations.push("lock");
            return operation();
          },
        },
      );

      expect(result.exitCode).toBe(1);
      expect(operations).toEqual(["lock"]);
      expect(listNativeNvidiaProviderAttachmentSandboxNames).toHaveBeenCalledExactlyOnceWith(
        "nemoclaw",
      );
      expect(deleteProvider).not.toHaveBeenCalled();
      expect(clearNativeNvidiaProviderAuthority).not.toHaveBeenCalled();
      expect(result.failureLines).toContain("  'nvidia-prod' is recorded by sandbox(es): alpha.");
      expect(result.failureLines).toContain("  No provider or ownership authority was changed.");
      expect(result.failureLines).toContain("    nemoclaw alpha destroy");
      expect(result.failureLines.join("\n")).toMatch(
        /Before destroying sandboxes to retry 'nemoclaw credentials reset nvidia-prod',[\s\S]*inspect the legacy 'nvidia-prod' provider with its owner and resolve any ownership conflict[\s\S]*destroy every recorded sandbox/,
      );
    },
  );

  it.each(["present", "timeout", "authentication", "schema"] as const)(
    "preserves providers and native authority when legacy observation is %s",
    async (state) => {
      const deleteProvider = vi.fn<OpenShellProviderAdapter["deleteProvider"]>(async () => ({
        ok: true,
      }));
      const clearNativeNvidiaProviderAuthority = vi.fn();
      const providerAdapter = adapter(deleteProvider);
      providerAdapter.getProvider = vi.fn<OpenShellProviderAdapter["getProvider"]>(async () =>
        state === "present"
          ? {
              ok: true,
              value: {
                name: "nvidia-prod",
                type: "nvidia",
                credentialKeys: ["NVIDIA_API_KEY"],
                configKeys: [],
              },
            }
          : { ok: false, error: { kind: state, message: "observation failed" } },
      );
      const result = await runCredentialsResetAction(
        { provider: "nvidia-prod", confirmed: true },
        {
          providerAdapter,
          clearNativeNvidiaProviderAuthority,
          listNativeNvidiaProviderAttachmentSandboxNames: () => [],
          withGatewayRouteMutationLock: async (_gateway, operation) => operation(),
        },
      );
      expect(result.exitCode).toBe(1);
      expect(providerAdapter.getProvider).toHaveBeenCalledExactlyOnceWith({
        target: { kind: "named", gatewayName: "nemoclaw" },
        providerName: "nvidia-prod",
        timeoutMs: 30_000,
      });
      expect(deleteProvider).not.toHaveBeenCalled();
      expect(clearNativeNvidiaProviderAuthority).not.toHaveBeenCalled();
      expect(result.failureLines.join("\n")).toContain("ownership conflict");
    },
  );

  it("does not let another gateway's attachment block the selected gateway reset", async () => {
    const deleteProvider = vi.fn<OpenShellProviderAdapter["deleteProvider"]>(async () => ({
      ok: true,
    }));
    const clearNativeNvidiaProviderAuthority = vi.fn();
    const listNativeNvidiaProviderAttachmentSandboxNames = vi.fn((gatewayName: string) =>
      gatewayName === "other-gateway" ? ["beta"] : [],
    );

    const result = await runCredentialsResetAction(
      { provider: "nvidia-prod", confirmed: true },
      {
        providerAdapter: adapter(deleteProvider),
        clearNativeNvidiaProviderAuthority,
        listNativeNvidiaProviderAttachmentSandboxNames,
        withGatewayRouteMutationLock: async (_gatewayName, operation) => operation(),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(listNativeNvidiaProviderAttachmentSandboxNames).toHaveBeenCalledExactlyOnceWith(
      "nemoclaw",
    );
    expect(deleteProvider.mock.calls.map(([input]) => input.providerName)).toEqual([
      "nemoclaw-nvidia-prod-v1",
    ]);
    expect(clearNativeNvidiaProviderAuthority).toHaveBeenCalledExactlyOnceWith("nemoclaw");
  });

  it("keeps explicit native identity reset separate from legacy removal", async () => {
    const deleteProvider = vi.fn<OpenShellProviderAdapter["deleteProvider"]>(async () => ({
      ok: true,
    }));
    const providerAdapter = adapter(deleteProvider);
    await runCredentialsResetAction(
      { provider: "nemoclaw-nvidia-prod-v1", confirmed: true },
      {
        providerAdapter,
        clearNativeNvidiaProviderAuthority: vi.fn(),
        listNativeNvidiaProviderAttachmentSandboxNames: () => [],
        withGatewayRouteMutationLock: async (_gateway, operation) => operation(),
      },
    );
    expect(providerAdapter.getProvider).not.toHaveBeenCalled();
    expect(deleteProvider.mock.calls.map(([input]) => input.providerName)).toEqual([
      "nemoclaw-nvidia-prod-v1",
    ]);
  });

  it.each(["nemoclaw-nvidia-prod-v1"])(
    "preserves authority when deleting %s fails",
    async (failedName) => {
      const deleteProvider = vi.fn<OpenShellProviderAdapter["deleteProvider"]>(async (input) =>
        input.providerName === failedName
          ? { ok: false, error: { kind: "command", reason: "failed", message: "delete failed" } }
          : { ok: true },
      );
      const clearNativeNvidiaProviderAuthority = vi.fn();
      const result = await runCredentialsResetAction(
        { provider: "nvidia-prod", confirmed: true },
        {
          providerAdapter: adapter(deleteProvider),
          clearNativeNvidiaProviderAuthority,
          listNativeNvidiaProviderAttachmentSandboxNames: () => [],
          withGatewayRouteMutationLock: async (_gateway, operation) => operation(),
        },
      );
      expect(result.exitCode).toBe(1);
      expect(deleteProvider.mock.calls.map(([input]) => input.providerName)).toEqual([
        "nemoclaw-nvidia-prod-v1",
      ]);
      expect(clearNativeNvidiaProviderAuthority).not.toHaveBeenCalled();
      expect(result.failureLines.join("\n")).toContain("delete failed");
    },
  );

  it("fails closed before reset when registry ownership cannot be read", async () => {
    const deleteProvider = vi.fn<OpenShellProviderAdapter["deleteProvider"]>();
    const clearNativeNvidiaProviderAuthority = vi.fn();

    const result = await runCredentialsResetAction(
      { provider: "nvidia-prod", confirmed: true },
      {
        providerAdapter: adapter(deleteProvider),
        clearNativeNvidiaProviderAuthority,
        listNativeNvidiaProviderAttachmentSandboxNames: () => {
          throw new Error("opaque registry failure");
        },
        withGatewayRouteMutationLock: async (_gatewayName, operation) => operation(),
      },
    );

    expect(result.exitCode).toBe(1);
    expect(deleteProvider).not.toHaveBeenCalled();
    expect(clearNativeNvidiaProviderAuthority).not.toHaveBeenCalled();
    expect(result.failureLines).toEqual([
      "  Could not safely inspect native NVIDIA inference ownership on gateway 'nemoclaw'.",
      "  No provider or ownership authority was changed.",
      "  Repair the existing NemoClaw state and retry.",
    ]);
    expect(JSON.stringify(result)).not.toContain("opaque registry failure");
  });
});
