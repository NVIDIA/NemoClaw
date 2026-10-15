// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it, vi } from "vitest";

import { createSession } from "../../../state/onboard-session";
import { createSetupInference, type SetupInferenceDeps } from "../../setup-inference";
import { handleProviderInferenceState } from "./provider-inference";
import { baseOptions, baseSelection, createDeps } from "./provider-inference.test-support";

it.each(["langchain-deepagents-code"])(
  "admits selected %s local inference when the prior registration was Hermes",
  async (name) => {
    const { deps, calls } = createDeps();
    const session = createSession();
    calls.setupNim.mockResolvedValue({
      ...baseSelection,
      provider: "ollama-local",
      model: "local-model",
      endpointUrl: "http://host.openshell.internal:11434/v1",
      credentialEnv: null,
    });
    await handleProviderInferenceState({
      ...baseOptions(deps, session),
      sandboxName: "same-sandbox",
      agent: { name },
    });

    // Stop at the next real boundary after agent admission, before provider mutation.
    const policyFailure = new Error("fixture policy unavailable");
    const requireNativeProviderPolicy = vi.fn(async () => {
      throw policyFailure;
    });
    const setup = createSetupInference({
      getGatewayName: () => "nemoclaw",
      getSandbox: () => ({ agent: "hermes" }),
      requireNativeProviderPolicy,
      withSandboxMutationLock: (_name: string, operation: () => unknown) => operation(),
    } as unknown as SetupInferenceDeps);
    expect(calls.setupInference).toHaveBeenCalledOnce();
    await expect(setup(...calls.setupInference.mock.calls[0]!)).rejects.toBe(policyFailure);
    expect(requireNativeProviderPolicy).toHaveBeenCalledWith("nemoclaw");
  },
);

it.each(["openclaw", "pi", "hermes"])(
  "keeps selected %s local inference on the existing shared route",
  async (name) => {
    const { deps, calls } = createDeps();
    const session = createSession();
    calls.setupNim.mockResolvedValue({
      ...baseSelection,
      provider: name === "pi" ? "compatible-endpoint" : "ollama-local",
      model: "local-model",
      endpointUrl: "http://host.openshell.internal:11434/v1",
      credentialEnv: null,
    });

    await handleProviderInferenceState({
      ...baseOptions(deps, session),
      sandboxName: "same-sandbox",
      agent: { name },
    });

    expect(calls.setupInference).toHaveBeenCalledOnce();
    expect(calls.setupInference.mock.calls[0]?.[7]).toEqual(
      expect.objectContaining({ agentName: name }),
    );
  },
);

it.each(["openclaw", "langchain-deepagents-code"])(
  "keeps selected %s Local NIM on its owned shared route",
  async (name) => {
    const { deps, calls } = createDeps();
    calls.setupNim.mockResolvedValue({
      ...baseSelection,
      provider: "vllm-local",
      model: "nim-model",
      endpointUrl: "http://host.openshell.internal:8000/v1",
      nimContainer: "nemoclaw-nim-owned",
    });

    await handleProviderInferenceState({
      ...baseOptions(deps, createSession()),
      sandboxName: "nim-sandbox",
      agent: { name },
    });

    expect(calls.setupInference).toHaveBeenCalledOnce();
    expect(calls.setupInference.mock.calls[0]?.[7]).toEqual(
      expect.objectContaining({ agentName: name, localNimSelected: true }),
    );
    const policyFailure = new Error("native policy must not run for NIM");
    const requireNativeProviderPolicy = vi.fn(async () => {
      throw policyFailure;
    });
    const setup = createSetupInference({
      getGatewayName: () => "nemoclaw",
      getSandbox: () => ({ agent: name, nimContainer: "nemoclaw-nim-owned" }),
      requireNativeProviderPolicy,
      withSandboxMutationLock: (_name: string, operation: () => unknown) => operation(),
      withGatewayRouteMutationLock: () => {
        throw new Error("reached the existing shared route");
      },
    } as unknown as SetupInferenceDeps);
    await expect(setup(...calls.setupInference.mock.calls[0]!)).rejects.toThrow(
      "reached the existing shared route",
    );
    expect(requireNativeProviderPolicy).not.toHaveBeenCalled();
  },
);
