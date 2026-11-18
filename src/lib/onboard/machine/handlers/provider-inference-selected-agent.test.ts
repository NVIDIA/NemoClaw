// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it, vi } from "vitest";

import { createDirectSetupInferenceHarness } from "../../../../../test/helpers/onboard-split-context";
import { createSession } from "../../../state/onboard-session";
import { createSetupInference, type SetupInferenceDeps } from "../../setup-inference";
import { handleProviderInferenceState } from "./provider-inference";
import { baseOptions, baseSelection, createDeps } from "./provider-inference.test-support";

it.each([
  {
    name: "langchain-deepagents-code",
    provider: "ollama-local",
    endpointUrl: "http://host.openshell.internal:11434/v1",
  },
  { name: "pi", provider: "ollama-local", endpointUrl: "http://host.openshell.internal:11434/v1" },
  {
    name: "pi",
    provider: "compatible-endpoint",
    endpointUrl: "http://host.openshell.internal:12345/v1",
  },
])(
  "admits selected $name $provider inference when the prior registration was Hermes",
  async ({ name, provider, endpointUrl }) => {
    const { deps, calls } = createDeps();
    const session = createSession();
    calls.setupNim.mockResolvedValue({
      ...baseSelection,
      provider,
      model: "local-model",
      endpointUrl,
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

it.each(["openclaw", "hermes"])(
  "passes the selected %s agent to local inference setup",
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

    expect(calls.setupInference).toHaveBeenCalledOnce();
    expect(calls.setupInference.mock.calls[0]?.[7]).toEqual(
      expect.objectContaining({ agentName: name }),
    );
  },
);

it.each(["openclaw", "langchain-deepagents-code"])(
  "registers selected %s Local NIM with its native sentinel credential",
  async (name) => {
    const nim = require("../../../inference/nim.ts") as typeof import("../../../inference/nim");
    vi.spyOn(nim, "getServedModelId").mockReturnValue("nim-model");
    const getManagedVllmProviderBinding = vi.fn(() => {
      throw new Error("Local NIM must not read standalone vLLM credentials");
    });
    const harness = createDirectSetupInferenceHarness({
      overrides: {
        applyLocalInferenceRoute: undefined,
        getManagedVllmProviderBinding,
        getSandbox: () => ({
          name: "nim-sandbox",
          agent: name,
          provider: "vllm-local",
          model: "prior-nim-model",
          endpointUrl: "http://host.openshell.internal:8000/v1",
          nimContainer: "nemoclaw-nim-owned",
          pendingRouteReservation: true,
        }),
      },
    });
    const { deps, calls } = createDeps({ setupInference: harness.setupInference });
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
    const attachment = [...harness.native.authorities.values()][0];
    expect(attachment).toMatchObject({
      provider: "vllm-local",
      authMode: "sentinel",
      endpointUrl: "http://host.openshell.internal:8000/v1",
      sandboxName: "nim-sandbox",
      gatewayName: "nemoclaw",
      credentialEnv: "NEMOCLAW_LOCAL_INFERENCE_TOKEN",
    });
    expect(attachment.agent).toBe(name === "openclaw" ? name : undefined);
    expect(harness.native.adapter.createProvider).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        type: attachment.profileId,
        credentials: [{ name: "NEMOCLAW_LOCAL_INFERENCE_TOKEN", value: "dummy" }],
      }),
    );
    expect(harness.native.profiles).toHaveLength(1);
    expect(getManagedVllmProviderBinding).not.toHaveBeenCalled();
    expect(harness.commands.some(({ command }) => command.startsWith("inference set"))).toBe(false);
  },
);
