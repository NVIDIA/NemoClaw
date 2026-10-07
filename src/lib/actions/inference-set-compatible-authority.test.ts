// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { nativeCompatibleFixture } from "../inference/native-compatible/switch.test-support";
import { runInferenceSet } from "./inference-set";
import { createDeps } from "./inference-set.test-support";

describe("native compatible switch authority", () => {
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
