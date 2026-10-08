// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OpenShellProviderAdapter } from "../adapters/openshell/provider-adapter";
import { setGlobalCliActionRuntimeHooksForTest } from "./global";
import { NATIVE_HOSTED_PROFILES } from "../inference/native-hosted/profiles";
import { runCredentialsResetAction } from "./credentials/reset";

vi.mock("../onboard/gateway-teardown-authority", () => ({
  resolveGatewayCredentialMutationAuthority: vi.fn(() => ({})),
}));

function adapter(
  deleteProvider: OpenShellProviderAdapter["deleteProvider"],
): OpenShellProviderAdapter {
  return {
    getProvider: vi.fn<OpenShellProviderAdapter["getProvider"]>(async () => ({
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
      const listNativeNvidiaProviderAttachmentSandboxNames = vi.fn((gatewayName?: string) =>
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
    },
  );

  it.each(
    NATIVE_HOSTED_PROFILES.flatMap((profile) =>
      (["present", "timeout", "authentication", "schema"] as const).map((state) => ({
        profile,
        state,
      })),
    ),
  )(
    "preserves providers and native authority when legacy observation is $state for $profile.logicalProvider",
    async ({ profile, state }) => {
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
                name: profile.logicalProvider,
                type: "nvidia",
                credentialKeys: ["NVIDIA_API_KEY"],
                configKeys: [],
              },
            }
          : {
              ok: false,
              error: { kind: state, message: "observation failed" },
            },
      );
      const result = await runCredentialsResetAction(
        { provider: profile.logicalProvider, confirmed: true },
        {
          providerAdapter,
          clearNativeNvidiaProviderAuthority,
          clearNativeHostedProviderAuthority: clearNativeNvidiaProviderAuthority,
          listNativeHostedProviderAttachmentSandboxNames: () => [],
          listNativeNvidiaProviderAttachmentSandboxNames: () => [],
          withGatewayRouteMutationLock: async (_gateway, operation) => operation(),
        },
      );
      expect(result.exitCode).toBe(1);
      expect(providerAdapter.getProvider).toHaveBeenCalledExactlyOnceWith({
        target: { kind: "named", gatewayName: "nemoclaw" },
        providerName: profile.logicalProvider,
        timeoutMs: 30_000,
      });
      expect(deleteProvider).not.toHaveBeenCalled();
      expect(clearNativeNvidiaProviderAuthority).not.toHaveBeenCalled();
      expect(result.failureLines.join("\n")).toContain("ownership conflict");
    },
  );

  it("refuses hosted reset for an owned receipt under the gateway lock", async () => {
    const operations: string[] = [];
    const deleteProvider = vi.fn<OpenShellProviderAdapter["deleteProvider"]>();
    const clearNativeHostedProviderAuthority = vi.fn();
    const result = await runCredentialsResetAction(
      { provider: "openai-api", confirmed: true },
      {
        providerAdapter: adapter(deleteProvider),
        clearNativeHostedProviderAuthority,
        listNativeHostedProviderAttachmentSandboxNames: (profileId, gatewayName) => {
          operations.push("inspect");
          expect(profileId).toBe("nemoclaw-openai-inference-v1");
          expect(gatewayName).toBe("nemoclaw");
          return ["alpha"];
        },
        withGatewayRouteMutationLock: async (_gatewayName, operation) => {
          operations.push("lock");
          return operation();
        },
      },
    );
    expect(operations).toEqual(["lock", "inspect"]);
    expect(result.exitCode).toBe(1);
    expect(deleteProvider).not.toHaveBeenCalled();
    expect(clearNativeHostedProviderAuthority).not.toHaveBeenCalled();
    expect(result.failureLines).toContain("  'openai-api' is recorded by sandbox(es): alpha.");
  });

  it.each(NATIVE_HOSTED_PROFILES.filter((profile) => profile.logicalProvider !== "nvidia-prod"))(
    "removes native identity only after legacy absence for $label",
    async (profile) => {
      const deleteProvider = vi.fn<OpenShellProviderAdapter["deleteProvider"]>(async () => ({
        ok: true,
      }));
      const clearNativeHostedProviderAuthority = vi.fn();
      const result = await runCredentialsResetAction(
        { provider: profile.logicalProvider, confirmed: true },
        {
          providerAdapter: adapter(deleteProvider),
          clearNativeHostedProviderAuthority,
          listNativeHostedProviderAttachmentSandboxNames: () => [],
          withGatewayRouteMutationLock: async (_gateway, operation) => operation(),
        },
      );
      expect(result.exitCode).toBe(0);
      expect(deleteProvider.mock.calls.map(([input]) => input.providerName)).toEqual([
        profile.providerName,
      ]);
      expect(clearNativeHostedProviderAuthority).toHaveBeenCalledExactlyOnceWith(
        "nemoclaw",
        profile.profileId,
      );
    },
  );

  it("does not let another gateway's attachment block the selected gateway reset", async () => {
    const deleteProvider = vi.fn<OpenShellProviderAdapter["deleteProvider"]>(async () => ({
      ok: true,
    }));
    const clearNativeNvidiaProviderAuthority = vi.fn();
    const listNativeNvidiaProviderAttachmentSandboxNames = vi.fn((gatewayName?: string) =>
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

  it.each(NATIVE_HOSTED_PROFILES)(
    "keeps explicit $label native identity reset separate from legacy removal",
    async (profile) => {
      const deleteProvider = vi.fn<OpenShellProviderAdapter["deleteProvider"]>(async () => ({
        ok: true,
      }));
      const providerAdapter = adapter(deleteProvider);
      await runCredentialsResetAction(
        { provider: profile.providerName, confirmed: true },
        {
          providerAdapter,
          clearNativeNvidiaProviderAuthority: vi.fn(),
          clearNativeHostedProviderAuthority: vi.fn(),
          listNativeHostedProviderAttachmentSandboxNames: () => [],
          listNativeNvidiaProviderAttachmentSandboxNames: () => [],
          withGatewayRouteMutationLock: async (_gateway, operation) => operation(),
        },
      );
      expect(providerAdapter.getProvider).not.toHaveBeenCalled();
      expect(deleteProvider.mock.calls.map(([input]) => input.providerName)).toEqual([
        profile.providerName,
      ]);
    },
  );

  it.each(["nemoclaw-nvidia-prod-v1"])(
    "preserves authority when deleting %s fails",
    async (failedName) => {
      const deleteProvider = vi.fn<OpenShellProviderAdapter["deleteProvider"]>(async (input) =>
        input.providerName === failedName
          ? {
              ok: false,
              error: {
                kind: "command",
                reason: "failed",
                message: "delete failed",
              },
            }
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
