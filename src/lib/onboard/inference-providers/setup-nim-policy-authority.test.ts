// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { PolicyAuthorityRefusalError } from "../../adapters/openshell/policy-authority";
import { makeDeps } from "../__test-helpers__/setup-nim-flow";
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
