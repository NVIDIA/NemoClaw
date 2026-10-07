// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter";
import { setGlobalCliActionRuntimeHooksForTest } from "../global";
import { runCredentialsResetAction } from "./reset";
import {
  providerAdapter,
  nativeNvidiaProviderAdapter,
  nativeNvidiaAuthority,
} from "./provider-adapter-test-helpers";

vi.mock("../../onboard/gateway-teardown-authority", () => ({
  resolveGatewayCredentialMutationAuthority: vi.fn(() => ({})),
}));

vi.mock("../../state/mcp-lifecycle-lock/credential-ownership", () => ({
  withMcpCredentialOwnershipLock: <T>(operation: () => Promise<T> | T) => operation(),
}));

vi.mock("../../gateway-start-guidance", () => ({
  gatewayStartGuidance: () => "Start the gateway again with `nemoclaw onboard`.",
}));

describe("native NVIDIA credential reset ownership", () => {
  beforeEach(() => {
    setGlobalCliActionRuntimeHooksForTest({
      recoverNamedGatewayRuntime: async () => ({ recovered: true }),
      recordExtraProvider: () => true,
      forgetExtraProvider: () => true,
    });
  });

  afterEach(() => {
    setGlobalCliActionRuntimeHooksForTest({});
    vi.unstubAllEnvs();
  });

  it.each(["nvidia-prod", "nemoclaw-nvidia-prod-v1"])(
    "preserves attached native NVIDIA providers during credential reset via %s",
    async (provider) => {
      const deleteProvider = vi.fn<OpenShellProviderAdapter["deleteProvider"]>(async () => ({
        ok: false,
        error: {
          kind: "command",
          reason: "attached",
          message: "provider remains attached",
          attachedSandboxes: ["alpha"],
        },
      }));
      const detachProvider = vi.fn<OpenShellProviderAdapter["detachProvider"]>();
      const adapter = { ...nativeNvidiaProviderAdapter(true), deleteProvider, detachProvider };

      const result = await runCredentialsResetAction(
        { provider, confirmed: true },
        { providerAdapter: adapter, getNativeNvidiaProviderAuthority: () => nativeNvidiaAuthority },
      );

      expect(result.exitCode).toBe(1);
      expect(deleteProvider).toHaveBeenCalledOnce();
      expect(deleteProvider).toHaveBeenCalledWith({
        target: { kind: "named", gatewayName: "nemoclaw" },
        providerName: "nemoclaw-nvidia-prod-v1",
        timeoutMs: 30_000,
      });
      expect(detachProvider).not.toHaveBeenCalled();
      expect(result.failureLines).toContain("  No provider attachment was changed.");
      expect(result.failureLines).toContain(
        "  To rotate the credential in place, set NVIDIA_INFERENCE_API_KEY and rerun 'nemoclaw onboard --name <sandbox>'.",
      );
      expect(result.failureLines).toContain("    nemoclaw alpha destroy");
      expect(result.failureLines.join("\n")).not.toContain("rebuild");
      expect(result.failureLines.join("\n")).not.toContain("openshell sandbox provider detach");
    },
  );

  it("clears native NVIDIA gateway authority only after provider deletion is confirmed", async () => {
    const clearNativeNvidiaProviderAuthority = vi.fn();
    const adapter = nativeNvidiaProviderAdapter(true);

    const result = await runCredentialsResetAction(
      { provider: "nvidia-prod", confirmed: true },
      {
        providerAdapter: adapter,
        clearNativeNvidiaProviderAuthority,
        getNativeNvidiaProviderAuthority: () => nativeNvidiaAuthority,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(clearNativeNvidiaProviderAuthority).toHaveBeenCalledWith("nemoclaw");
  });

  it("clears native NVIDIA authority when the provider is already absent", async () => {
    const clearNativeNvidiaProviderAuthority = vi.fn();
    const adapter = nativeNvidiaProviderAdapter();

    const result = await runCredentialsResetAction(
      { provider: "nvidia-prod", confirmed: true },
      { providerAdapter: adapter, clearNativeNvidiaProviderAuthority },
    );

    expect(result.exitCode).toBe(0);
    expect(adapter.deleteProvider).not.toHaveBeenCalled();
    expect(clearNativeNvidiaProviderAuthority).toHaveBeenCalledWith("nemoclaw");
  });

  describe.each(["nvidia-prod", "nemoclaw-nvidia-prod-v1"])("native reset via %s", (provider) => {
    it.each([
      {
        scenario: "missing receipt",
        createAdapter: () => nativeNvidiaProviderAdapter(true),
        authority: undefined,
      },
      {
        scenario: "different identity",
        createAdapter: () => nativeNvidiaProviderAdapter(true),
        authority: { ...nativeNvidiaAuthority, providerId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
      },
      {
        scenario: "wrong profile",
        createAdapter: () => ({
          ...nativeNvidiaProviderAdapter(true),
          getProvider: providerAdapter().getProvider,
        }),
        authority: nativeNvidiaAuthority,
      },
      {
        scenario: "inspection unavailable",
        createAdapter: () => ({
          ...nativeNvidiaProviderAdapter(true),
          getProvider: vi.fn<OpenShellProviderAdapter["getProvider"]>().mockResolvedValue({
            ok: false,
            error: { kind: "transport", reason: "unreachable", message: "gateway unavailable" },
          }),
        }),
        authority: nativeNvidiaAuthority,
      },
    ])(
      "refuses mutation when ownership is unproven: $scenario",
      async ({ createAdapter, authority }) => {
        const adapter = createAdapter();
        const clearAuthority = vi.fn();
        const result = await runCredentialsResetAction(
          { provider, confirmed: true },
          {
            providerAdapter: adapter,
            getNativeNvidiaProviderAuthority: () => authority,
            clearNativeNvidiaProviderAuthority: clearAuthority,
          },
        );
        expect(result.exitCode).toBe(1);
        expect(adapter.deleteProvider).not.toHaveBeenCalled();
        expect(adapter.detachProvider).not.toHaveBeenCalled();
        expect(clearAuthority).not.toHaveBeenCalled();
      },
    );

    it.each(["timeout", "success", "not_found"])(
      "retains ownership when delete reports %s but the provider remains",
      async (outcome) => {
        const adapter = nativeNvidiaProviderAdapter(true);
        const clearAuthority = vi.fn();
        vi.mocked(adapter.deleteProvider).mockResolvedValue(
          outcome === "success"
            ? { ok: true }
            : {
                ok: false,
                error:
                  outcome === "timeout"
                    ? { kind: "transport", reason: "unreachable", message: "connection lost" }
                    : { kind: "command", reason: "not_found", message: "provider not found" },
              },
        );
        const result = await runCredentialsResetAction(
          { provider, confirmed: true },
          {
            providerAdapter: adapter,
            getNativeNvidiaProviderAuthority: () => nativeNvidiaAuthority,
            clearNativeNvidiaProviderAuthority: clearAuthority,
          },
        );
        expect(result.exitCode).toBe(1);
        expect(adapter.deleteProvider).toHaveBeenCalledOnce();
        expect(adapter.getProvider).toHaveBeenCalledTimes(2);
        expect(adapter.detachProvider).not.toHaveBeenCalled();
        expect(clearAuthority).not.toHaveBeenCalled();
      },
    );

    it("reconciles a lost delete response only after observing absence", async () => {
      const adapter = nativeNvidiaProviderAdapter(true);
      const removeProvider = adapter.deleteProvider;
      const clearAuthority = vi.fn();
      adapter.deleteProvider = vi.fn(async (request) => {
        await removeProvider(request);
        return {
          ok: false as const,
          error: {
            kind: "transport" as const,
            reason: "unreachable" as const,
            message: "connection lost",
          },
        };
      });
      const result = await runCredentialsResetAction(
        { provider, confirmed: true },
        {
          providerAdapter: adapter,
          getNativeNvidiaProviderAuthority: () => nativeNvidiaAuthority,
          clearNativeNvidiaProviderAuthority: clearAuthority,
        },
      );
      expect(result.exitCode).toBe(0);
      expect(adapter.deleteProvider).toHaveBeenCalledOnce();
      expect(adapter.getProvider).toHaveBeenCalledTimes(2);
      expect(clearAuthority).toHaveBeenCalledWith("nemoclaw");
    });

    it("retains the receipt when another provider appears after deletion", async () => {
      const adapter = nativeNvidiaProviderAdapter(true);
      const clearAuthority = vi.fn();
      const inspect = adapter.getProvider;
      adapter.getProvider = vi
        .fn()
        .mockImplementationOnce(inspect)
        .mockResolvedValue({
          ok: true,
          value: {
            name: "nemoclaw-nvidia-prod-v1",
            type: "nemoclaw-nvidia-inference-v1",
            credentialKeys: ["NVIDIA_INFERENCE_API_KEY"],
            configKeys: [],
            revision: { id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", resourceVersion: 1 },
          },
        });
      adapter.deleteProvider = vi.fn(async () => ({ ok: true as const }));
      const result = await runCredentialsResetAction(
        { provider, confirmed: true },
        {
          providerAdapter: adapter,
          getNativeNvidiaProviderAuthority: () => nativeNvidiaAuthority,
          clearNativeNvidiaProviderAuthority: clearAuthority,
        },
      );
      expect(result.exitCode).toBe(1);
      expect(adapter.deleteProvider).toHaveBeenCalledOnce();
      expect(clearAuthority).not.toHaveBeenCalled();
    });

    it("retains the receipt when inspection fails after deletion", async () => {
      const adapter = nativeNvidiaProviderAdapter(true);
      const clearAuthority = vi.fn();
      const inspect = adapter.getProvider;
      adapter.getProvider = vi
        .fn()
        .mockImplementationOnce(inspect)
        .mockResolvedValue({
          ok: false,
          error: { kind: "transport", reason: "unreachable", message: "gateway unavailable" },
        });
      const result = await runCredentialsResetAction(
        { provider, confirmed: true },
        {
          providerAdapter: adapter,
          getNativeNvidiaProviderAuthority: () => nativeNvidiaAuthority,
          clearNativeNvidiaProviderAuthority: clearAuthority,
        },
      );
      expect(result.exitCode).toBe(1);
      expect(adapter.deleteProvider).toHaveBeenCalledOnce();
      expect(clearAuthority).not.toHaveBeenCalled();
    });
  });
});
