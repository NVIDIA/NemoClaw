// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { PolicyAuthorityRefusalError } from "../../adapters/openshell/policy-authority";
import type { VllmProfile } from "../../inference/vllm";
import { makeDeps, makeHostState } from "../__test-helpers__/setup-nim-flow";
import { createSetupNim, type SetupNimFlowDeps } from "../setup-nim-flow";

function refusePolicyChange(): never {
  throw new Error("external policy authority must supply the selected provider entry");
}

describe("provider selection policy authority", () => {
  it("stops before a remote provider can register credentials (#9833)", async () => {
    const handleRemoteProviderSelection =
      vi.fn<SetupNimFlowDeps["handleRemoteProviderSelection"]>();
    const setupNim = createSetupNim(
      makeDeps({
        isNonInteractive: () => true,
        getNonInteractiveProvider: () => "build",
        handleRemoteProviderSelection,
      }),
    );

    await expect(
      setupNim(
        null,
        null,
        null,
        true,
        null,
        "nemoclaw",
        undefined,
        undefined,
        null,
        refusePolicyChange,
      ),
    ).rejects.toThrow(/external policy authority must supply/u);

    expect(handleRemoteProviderSelection).not.toHaveBeenCalled();
  });

  it("stops before a managed llama.cpp installer resolves its runtime (#9833)", async () => {
    const selection = {
      recipe: {
        metadata: { id: "test.llama.recipe" },
        spec: { model: { servedName: "nvidia-nemotron-3-nano-30b-a3b" } },
      },
    } as never;
    const installManagedLlamaCpp = vi.fn();
    const getRuntimeProvider = vi.fn(() => makeDeps().getRuntimeProvider());
    const setupNim = createSetupNim(
      makeDeps({
        isNonInteractive: () => true,
        getNonInteractiveProvider: () => "install-llama-cpp",
        resolveManagedLlamaCppSelection: () => ({ kind: "selected", selection }),
        installManagedLlamaCpp: installManagedLlamaCpp as never,
        getRuntimeProvider,
      }),
    );
    const revalidatePolicyRequirements = vi.fn((_route, operation: string) =>
      operation === "install managed llama.cpp runtime" ? refusePolicyChange() : undefined,
    );

    await expect(
      setupNim(
        { platform: "spark" } as never,
        "spark-agent",
        null,
        true,
        null,
        "nemoclaw",
        undefined,
        undefined,
        null,
        revalidatePolicyRequirements,
      ),
    ).rejects.toThrow(/external policy authority must supply/u);

    expect(getRuntimeProvider).not.toHaveBeenCalled();
    expect(installManagedLlamaCpp).not.toHaveBeenCalled();
  });

  it("stops a managed vLLM install after model planning and before install effects (#9833)", async () => {
    const profile = { name: "DGX Spark" } as VllmProfile;
    const installEffect = vi.fn();
    const installVllm = vi.fn<SetupNimFlowDeps["installVllm"]>(async (_profile, options) => {
      options.beforeInstall?.("vllm-model");
      installEffect();
      return { ok: true };
    });
    const handleVllmSelection = vi.fn<SetupNimFlowDeps["handleVllmSelection"]>();
    const setupNim = createSetupNim(
      makeDeps({
        isNonInteractive: () => true,
        getNonInteractiveProvider: () => "install-vllm",
        detectInferenceProviderHostState: () =>
          makeHostState({
            vllmProfile: profile,
            hasVllmImage: true,
            vllmEntries: [{ key: "install-vllm", label: "Start vLLM (DGX Spark)" }],
          }),
        installVllm,
        handleVllmSelection,
      }),
    );
    const revalidatePolicyRequirements = vi.fn((_route, operation: string) =>
      operation === "install managed vLLM runtime" ? refusePolicyChange() : undefined,
    );

    await expect(
      setupNim(
        null,
        null,
        null,
        true,
        null,
        "nemoclaw",
        undefined,
        undefined,
        null,
        revalidatePolicyRequirements,
      ),
    ).rejects.toThrow(/external policy authority must supply/u);

    expect(installEffect).not.toHaveBeenCalled();
    expect(handleVllmSelection).not.toHaveBeenCalled();
  });

  it("does not retry selection after a typed llama.cpp activation refusal (#9833)", async () => {
    const selection = {
      recipe: {
        metadata: { id: "test.llama.recipe" },
        spec: { model: { servedName: "nvidia-nemotron-3-nano-30b-a3b" } },
      },
    } as never;
    const installManagedLlamaCpp = vi.fn(async (_selection, options) => {
      options.revalidatePolicyRequirements?.("activate the managed llama.cpp runtime");
      throw new PolicyAuthorityRefusalError(
        "External policy authority must supply the managed llama.cpp entry.",
      );
    });
    const setupNim = createSetupNim(
      makeDeps({
        isNonInteractive: () => true,
        getNonInteractiveProvider: () => "install-llama-cpp",
        resolveManagedLlamaCppSelection: () => ({ kind: "selected", selection }),
        installManagedLlamaCpp: installManagedLlamaCpp as never,
      }),
    );
    const revalidatePolicyRequirements = vi.fn();

    await expect(
      setupNim(
        { platform: "spark" } as never,
        "spark-agent",
        null,
        true,
        null,
        "nemoclaw",
        undefined,
        undefined,
        null,
        revalidatePolicyRequirements,
      ),
    ).rejects.toBeInstanceOf(PolicyAuthorityRefusalError);

    expect(installManagedLlamaCpp).toHaveBeenCalledOnce();
    expect(revalidatePolicyRequirements).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "llama-cpp-local" }),
      "activate the managed llama.cpp runtime",
    );
  });
});
