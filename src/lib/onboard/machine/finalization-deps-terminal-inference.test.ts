// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { finalizationHandlerDeps, finalizationHandlerRuntime } from "./finalization-deps";

const input = {
  sandboxName: "deep-code",
  agentName: "langchain-deepagents-code",
  provider: "openrouter-api",
  model: "moonshotai/kimi-k2.6",
  preferredInferenceApi: "openai-completions",
};

describe("terminal inference finalization dependency", () => {
  afterEach(() => vi.restoreAllMocks());

  it("uses the sandbox's recorded gateway for the bounded inference probe", async () => {
    vi.spyOn(finalizationHandlerRuntime, "loadRegistryPersistence").mockReturnValue({
      load: () => ({ sandboxes: { "deep-code": { gatewayName: "nemoclaw-19090" } } }),
    } as never);
    const probeOnboardInferenceInvocation = vi.fn(async () => ({ ok: true }));
    vi.spyOn(finalizationHandlerRuntime, "loadVerifyDeployment").mockReturnValue({
      probeOnboardInferenceInvocation,
    } as never);

    await expect(finalizationHandlerDeps.probeTerminalInference(input)).resolves.toEqual({
      ok: true,
    });
    expect(probeOnboardInferenceInvocation).toHaveBeenCalledExactlyOnceWith({
      ...input,
      gatewayName: "nemoclaw-19090",
    });
  });

  it("fails closed when the sandbox gateway identity is unavailable", async () => {
    vi.spyOn(finalizationHandlerRuntime, "loadRegistryPersistence").mockReturnValue({
      load: () => ({ sandboxes: {} }),
    } as never);
    const loadVerifyDeployment = vi.spyOn(finalizationHandlerRuntime, "loadVerifyDeployment");

    await expect(finalizationHandlerDeps.probeTerminalInference(input)).resolves.toEqual({
      ok: false,
      detail: "the sandbox gateway identity is unavailable",
    });
    expect(loadVerifyDeployment).not.toHaveBeenCalled();
  });

  it("fails closed when registry persistence cannot be read", async () => {
    vi.spyOn(finalizationHandlerRuntime, "loadRegistryPersistence").mockReturnValue({
      load: () => {
        throw new Error("registry unavailable");
      },
    } as never);

    await expect(finalizationHandlerDeps.probeTerminalInference(input)).resolves.toEqual({
      ok: false,
      detail: "the sandbox gateway identity is unavailable",
    });
  });
});
