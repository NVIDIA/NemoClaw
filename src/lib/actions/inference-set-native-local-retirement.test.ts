// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { retireUnselectedNativeLocalProviders } from "../inference/native-local/selection";
import type { OpenShellProviderAdapter } from "../adapters/openshell/provider-adapter";
import { runInferenceSet } from "./inference-set";
import { createDeps, nativeLocalTestReceipt } from "./inference-set.test-support";
import type { NativeLocalProviderAttachment } from "../inference/native-local/contract";

function fixture() {
  const previous = {
    ...nativeLocalTestReceipt("ollama-local", "http://host.openshell.internal:11434/v1"),
    providerId: "previous-id",
  };
  const selected = nativeLocalTestReceipt();
  const authorities = new Map([
    [previous.providerName, previous],
    [selected.providerName, selected],
  ]);
  const providers = new Map(authorities);
  const deps = createDeps({ config: {}, entry: { name: "alpha", agent: "openclaw" } });
  const entry = deps.getSandbox("alpha")!;
  deps.calls.updateSandbox.mockImplementation((_name, updates) => {
    Object.assign(entry, updates);
    return true;
  });
  const getProvider = vi.fn(async ({ providerName }: { providerName: string }) => {
    const found = providers.get(providerName);
    return found
      ? {
          ok: true as const,
          value: {
            name: found.providerName,
            type: found.profileId,
            credentialKeys: [found.credentialEnv],
            configKeys: [],
            revision: { id: found.providerId, resourceVersion: 1 },
          },
        }
      : {
          ok: false as const,
          error: { kind: "command" as const, reason: "not_found" as const, message: "absent" },
        };
  });
  const deleteProvider = vi.fn<OpenShellProviderAdapter["deleteProvider"]>(
    async ({ providerName }: { providerName: string }) => {
      providers.delete(providerName);
      return { ok: true as const };
    },
  );
  const listNativeLocalProviderAuthorities = vi.fn(() => [...authorities.values()]);
  const clearNativeLocalProviderAuthority = vi.fn((receipt: NativeLocalProviderAttachment) => {
    authorities.delete(receipt.providerName);
  });
  return {
    previous,
    selected,
    authorities,
    providers,
    entry,
    getProvider,
    deleteProvider,
    deps: {
      ...deps,
      providerAdapter: { ...deps.providerAdapter, getProvider, deleteProvider },
      listNativeLocalProviderAuthorities,
      clearNativeLocalProviderAuthority,
    },
  };
}

describe("committed native selection provider cleanup", () => {
  it("retires previously detached providers after committing the selected route (#12558)", async () => {
    const f = fixture();
    await runInferenceSet({ provider: "ollama-local", model: "model-a" }, f.deps);
    expect(f.entry.nativeLocalProviderAttachment).toEqual(f.selected);
    expect(f.deleteProvider).toHaveBeenCalledExactlyOnceWith({
      target: { kind: "named", gatewayName: "nemoclaw" },
      providerName: f.previous.providerName,
    });
    expect([...f.authorities.keys()]).toEqual([f.selected.providerName]);
    expect([...f.providers.keys()]).toEqual([f.selected.providerName]);
  });
  it("does not retire providers before registry publication commits (#12558)", async () => {
    const f = fixture();
    f.deps.calls.updateSandbox.mockReturnValue(false);
    await expect(
      runInferenceSet({ provider: "ollama-local", model: "model-a" }, f.deps),
    ).rejects.toThrow("Failed to update NemoClaw registry");
    expect(f.deleteProvider).not.toHaveBeenCalled();
    expect([...f.authorities.keys()]).toEqual([f.previous.providerName, f.selected.providerName]);
  });

  it("retains committed selection and cleanup authority after uncertain deletion, then reconciles absence (#12558)", async () => {
    const f = fixture();
    f.deleteProvider.mockImplementationOnce(async ({ providerName }) => {
      f.providers.delete(providerName);
      f.getProvider.mockResolvedValueOnce({
        ok: false,
        error: { kind: "command", reason: "not_found", message: "absent" },
      });
      throw new Error("delete response lost");
    });
    await expect(
      runInferenceSet({ provider: "ollama-local", model: "model-a" }, f.deps),
    ).rejects.toThrow("delete response lost");
    expect(f.entry.nativeLocalProviderAttachment).toEqual(f.selected);
    expect(f.authorities.has(f.previous.providerName)).toBe(true);
    await runInferenceSet({ provider: "ollama-local", model: "model-a" }, f.deps);
    expect(f.deleteProvider).toHaveBeenCalledTimes(1);
    expect([...f.authorities.keys()]).toEqual([f.selected.providerName]);
  });

  it("retains authority and rejects cleanup when a provider identity changed (#12558)", async () => {
    const f = fixture();
    f.providers.set(f.previous.providerName, { ...f.previous, providerId: "replacement-id" });
    await expect(
      runInferenceSet({ provider: "ollama-local", model: "model-a" }, f.deps),
    ).rejects.toThrow("identity changed");
    expect(f.deleteProvider).not.toHaveBeenCalled();
    expect(f.authorities.has(f.previous.providerName)).toBe(true);
    expect(f.entry.nativeLocalProviderAttachment).toEqual(f.selected);
  });

  it("clears confirmed absent provider authority without another delete (#12558)", async () => {
    const f = fixture();
    f.providers.delete(f.previous.providerName);
    await runInferenceSet({ provider: "ollama-local", model: "model-a" }, f.deps);
    expect(f.deleteProvider).not.toHaveBeenCalled();
    expect([...f.authorities.keys()]).toEqual([f.selected.providerName]);
  });

  it("retains authority when OpenShell still observes the old provider attached (#12558)", async () => {
    const f = fixture();
    f.deleteProvider.mockResolvedValueOnce({
      ok: false,
      error: { kind: "command", reason: "attached", message: "still attached" },
    });
    await expect(
      runInferenceSet({ provider: "ollama-local", model: "model-a" }, f.deps),
    ).rejects.toThrow("remains attached");
    expect(f.authorities.has(f.previous.providerName)).toBe(true);
    expect(f.providers.has(f.previous.providerName)).toBe(true);
    expect(f.entry.nativeLocalProviderAttachment).toEqual(f.selected);
  });

  it("retires current and retained authorities after confirmed sandbox destruction (#12558)", async () => {
    const f = fixture();
    await retireUnselectedNativeLocalProviders({
      adapter: f.deps.providerAdapter,
      sandboxName: "alpha",
      gatewayName: "nemoclaw",
      destroyedAttachment: f.selected,
      listAuthorities: f.deps.listNativeLocalProviderAuthorities,
      clearAuthority: f.deps.clearNativeLocalProviderAuthority,
    });
    expect(f.deleteProvider).toHaveBeenCalledTimes(2);
    expect(f.authorities.size).toBe(0);
    expect(f.providers.size).toBe(0);
  });
});
