// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import {
  nativeCompatibleFixture,
  nativeCompatibleRotationFixture,
} from "../inference/native-compatible/switch.test-support";
import { runInferenceSet } from "./inference-set";
import { createDeps } from "./inference-set.test-support";

describe("native compatible switch authority", () => {
  it("restores the shared route and native attachment after a failed departure", async () => {
    const f = await nativeCompatibleRotationFixture();
    f.attachments.delete("beta");
    const deps = createDeps({
      config: {
        agents: { defaults: { model: { primary: "inference/old-model" } } },
        models: { providers: { inference: { api: f.previous.profile.api, models: [] } } },
      },
      entry: {
        name: "alpha",
        agent: "openclaw",
        provider: "compatible-endpoint",
        model: "old-model",
        endpointUrl: f.previous.profile.endpoint,
        credentialEnv: "COMPATIBLE_API_KEY",
        preferredInferenceApi: f.previous.profile.api,
        nativeCompatibleProviderAttachment: f.previous.receipt,
      },
      providerAdapter: f.adapter,
      resolveNativeCompatibleEndpointHost: f.lookup,
    });
    deps.getNativeCompatibleProviderAuthority = (_gateway, profileId) =>
      f.authorities.get(profileId);
    const clear = vi.fn();
    deps.clearNativeCompatibleProviderAuthority = clear;
    deps.updateSandbox = vi.fn(() => false);
    deps.inferenceRouteObserver.observeInferenceRoute = vi.fn(async () => ({
      ok: true as const,
      value: {
        state: "configured" as const,
        route: { provider: "peer-provider", model: "peer-model" },
      },
    }));
    const route = vi.spyOn(deps.inferenceRouteMutator, "setInferenceRoute");
    await expect(
      runInferenceSet(
        { sandboxName: "alpha", provider: "openai", model: "gpt-4o", noVerify: true },
        deps,
      ),
    ).rejects.toThrow("Failed to update NemoClaw registry");
    expect(route).toHaveBeenLastCalledWith(
      expect.objectContaining({ route: { provider: "peer-provider", model: "peer-model" } }),
    );
    expect([...f.attachments.get("alpha")!]).toEqual([f.previous.profile.providerName]);
    expect(clear).not.toHaveBeenCalled();
  });

  it("refuses legacy hosted compatible selection without a receipt before native mutation", async () => {
    const native = await nativeCompatibleFixture(undefined, undefined, false);
    const deps = createDeps({
      config: {},
      entry: {
        name: "alpha",
        agent: "openclaw",
        provider: "compatible-endpoint",
        model: "old",
        endpointUrl: native.profile.endpoint,
        credentialEnv: "COMPATIBLE_API_KEY",
        preferredInferenceApi: "openai-completions",
      },
      providerAdapter: native.providerAdapter,
    });
    await expect(
      runInferenceSet({ provider: "compatible-endpoint", model: "new" }, deps),
    ).rejects.toThrow("Recreate this beta sandbox");
    expect(native.adapter.importProviderProfile).not.toHaveBeenCalled();
    expect(native.adapter.createProvider).not.toHaveBeenCalled();
    expect(native.adapter.attachProvider).not.toHaveBeenCalled();
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
  });

  it("removes an unowned new endpoint when authority persistence fails before attachment", async () => {
    const native = await nativeCompatibleFixture(undefined, undefined, false);
    const deps = createDeps({
      config: {},
      entry: { name: "alpha", agent: "openclaw", provider: "nvidia-prod", model: "old" },
      providerAdapter: native.providerAdapter,
    });
    deps.getNativeCompatibleProviderAuthority = vi.fn(() => undefined);
    deps.setNativeCompatibleProviderAuthority = vi.fn(() => {
      throw new Error("registry write failed");
    });
    await expect(
      runInferenceSet(
        {
          provider: "compatible-endpoint",
          model: "new",
          endpointUrl: native.profile.endpoint,
          credentialEnv: "COMPATIBLE_API_KEY",
          inferenceApi: "openai-completions",
        },
        deps,
      ),
    ).rejects.toThrow("newly created provider was removed");
    expect(native.adapter.createProvider).toHaveBeenCalledOnce();
    expect(native.adapter.deleteProvider).toHaveBeenCalledOnce();
    expect(native.adapter.attachProvider).not.toHaveBeenCalled();
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
    expect(
      deps.getNativeCompatibleProviderAuthority("nemoclaw", native.receipt.profileId),
    ).toBeUndefined();
  });
});
