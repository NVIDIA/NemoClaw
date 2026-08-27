// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession } from "../../../state/onboard-session";
import { handleProviderInferenceState } from "./provider-inference";
import { baseOptions, createDeps } from "./provider-inference.test-support";

describe("Pi hosted inference selection", () => {
  it("keeps Pi on NVIDIA hosted inference without extending host-local support", async () => {
    const resolver = vi.fn(() => null);
    const { deps, calls } = createDeps({
      resolveHostLocalInferenceStartupSelection: resolver,
    });
    const session = createSession();
    calls.complete.mockResolvedValue(session);

    const result = await handleProviderInferenceState({
      ...baseOptions(deps, session),
      agent: { name: "pi" },
    });

    expect(resolver).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      provider: "nvidia-prod",
      endpointUrl: "https://integrate.api.nvidia.com/v1",
      hostLocalInferenceRouteOnly: false,
      hostLocalInferenceSandboxProofAuthority: null,
    });
  });

  it("keeps Pi host-local inference outside the accepted application boundary", async () => {
    const session = createSession({
      provider: "vllm-local",
      model: "pi-local-model",
      preferredInferenceApi: "openai-completions",
    });
    session.steps.provider_selection.status = "complete";
    const resolver = vi.fn(() => null);
    const { deps, calls } = createDeps({
      resolveHostLocalInferenceStartupSelection: resolver,
    });

    await expect(
      handleProviderInferenceState({
        ...baseOptions(deps, session),
        resume: true,
        sandboxName: "pi-local",
        agent: { name: "pi" },
      }),
    ).rejects.toThrow("Unsupported host-local inference application 'pi'.");

    expect(resolver).not.toHaveBeenCalled();
    expect(calls.setupNim).not.toHaveBeenCalled();
    expect(calls.setupInference).not.toHaveBeenCalled();
  });
});
