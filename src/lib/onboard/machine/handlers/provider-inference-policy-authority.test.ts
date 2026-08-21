// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession } from "../../../state/onboard-session";
import { handleProviderInferenceState } from "./provider-inference";
import { baseOptions, baseSelection, createDeps } from "./provider-inference.test-support";

const refuseExternalPolicy = (): never => {
  throw new Error("external policy authority must supply the selected route");
};

describe("provider inference policy authority", () => {
  it("stops before provider setup when policy requirements are not met (#9833)", async () => {
    const preflightPolicyRequirements = vi.fn(refuseExternalPolicy);
    const { deps, calls } = createDeps({ preflightPolicyRequirements });

    await expect(handleProviderInferenceState(baseOptions(deps))).rejects.toThrow(
      /external policy authority must supply/u,
    );

    expect(preflightPolicyRequirements).toHaveBeenCalledOnce();
    expect(calls.startStep).not.toHaveBeenCalled();
    expect(calls.setupNim).not.toHaveBeenCalled();
    expect(calls.setupInference).not.toHaveBeenCalled();
  });

  it("rechecks before recording a fresh provider selection start (#9833)", async () => {
    const preflightPolicyRequirements = vi.fn((requirements: { operation: string }) =>
      requirements.operation === "record provider selection start"
        ? refuseExternalPolicy()
        : undefined,
    );
    const { deps, calls } = createDeps({ preflightPolicyRequirements });

    await expect(handleProviderInferenceState(baseOptions(deps))).rejects.toThrow(
      /external policy authority must supply/u,
    );

    expect(calls.startStep).not.toHaveBeenCalled();
    expect(calls.setupNim).not.toHaveBeenCalled();
  });

  it("rechecks final provider requirements immediately before setup (#9833)", async () => {
    const events: string[] = [];
    const preflightPolicyRequirements = vi.fn((requirements: { provider: string | null }) => {
      events.push(`preflight:${requirements.provider ?? "none"}`);
    });
    const setupInference = vi.fn(async () => {
      events.push("setup");
      return { ok: true as const };
    });
    const { deps, calls } = createDeps({ preflightPolicyRequirements, setupInference });
    const session = createSession({
      observabilityEnabled: true,
      webSearchConfig: { provider: "tavily", fetchEnabled: true },
    });

    await handleProviderInferenceState(baseOptions(deps, session));

    expect(preflightPolicyRequirements).toHaveBeenLastCalledWith(
      expect.objectContaining({
        provider: "nvidia-prod",
        webSearchConfig: { provider: "tavily", fetchEnabled: true },
        observabilityEnabled: true,
      }),
    );
    expect(events).toEqual(expect.arrayContaining(["preflight:nvidia-prod", "setup"]));
    expect(calls.setupNim).toHaveBeenCalledOnce();
  });

  it("does not register a provider when the final requirements are missing (#9833)", async () => {
    const preflightPolicyRequirements = vi.fn((requirements: { operation: string }) =>
      requirements.operation.startsWith("configure inference provider")
        ? refuseExternalPolicy()
        : undefined,
    );
    const { deps, calls } = createDeps({ preflightPolicyRequirements });

    await expect(handleProviderInferenceState(baseOptions(deps))).rejects.toThrow(
      /external policy authority must supply/u,
    );

    expect(preflightPolicyRequirements).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: expect.stringMatching(/^configure inference provider/u),
      }),
    );
    expect(calls.setupNim).toHaveBeenCalledOnce();
    expect(calls.setupInference).not.toHaveBeenCalled();
    expect(calls.complete).not.toHaveBeenCalled();
    expect(calls.updateSandbox).not.toHaveBeenCalled();
  });

  it("rechecks policy requirements at the inference registration edge (#9833)", async () => {
    const configureOperations: string[] = [];
    const preflightPolicyRequirements = vi.fn((requirements: { operation: string }) =>
      requirements.operation.startsWith("configure inference provider") &&
      configureOperations.push(requirements.operation) === 2
        ? refuseExternalPolicy()
        : undefined,
    );
    const { deps, calls } = createDeps({ preflightPolicyRequirements });

    await expect(handleProviderInferenceState(baseOptions(deps))).rejects.toThrow(
      /external policy authority must supply/u,
    );

    expect(calls.setupInference).not.toHaveBeenCalled();
    expect(calls.reupsertRoutedProvider).not.toHaveBeenCalled();
    expect(calls.reserveRoute).not.toHaveBeenCalled();
    expect(calls.updateSandbox).not.toHaveBeenCalled();
  });

  it("rechecks after router reconciliation before routed mutations (#9833)", async () => {
    const session = createSession({
      sandboxName: "router-sandbox",
      provider: "nvidia-router",
      model: "router/model",
    });
    session.steps.provider_selection.status = "complete";
    const preflightPolicyRequirements = vi.fn((requirements: { operation: string }) =>
      requirements.operation.startsWith("update routed inference provider")
        ? refuseExternalPolicy()
        : undefined,
    );
    const { deps, calls } = createDeps({
      isInferenceRouteReady: vi.fn(() => true),
      preflightPolicyRequirements,
    });

    await expect(
      handleProviderInferenceState({
        ...baseOptions(deps, session),
        resume: true,
        sandboxName: "router-sandbox",
      }),
    ).rejects.toThrow(/external policy authority must supply/u);

    expect(calls.reconcileRouter).toHaveBeenCalledOnce();
    expect(calls.reupsertRoutedProvider).not.toHaveBeenCalled();
    expect(calls.reserveRoute).not.toHaveBeenCalled();
    expect(calls.updateSandbox).not.toHaveBeenCalled();
  });

  it("rechecks after routed provider upsert before reserving the resume route (#9833)", async () => {
    const session = createSession({
      sandboxName: "router-sandbox",
      provider: "nvidia-router",
      model: "router/model",
    });
    session.steps.provider_selection.status = "complete";
    const preflightPolicyRequirements = vi.fn((requirements: { operation: string }) =>
      requirements.operation.startsWith("reserve routed inference route")
        ? refuseExternalPolicy()
        : undefined,
    );
    const { deps, calls } = createDeps({
      isInferenceRouteReady: vi.fn(() => true),
      preflightPolicyRequirements,
    });

    await expect(
      handleProviderInferenceState({
        ...baseOptions(deps, session),
        resume: true,
        sandboxName: "router-sandbox",
      }),
    ).rejects.toThrow(/external policy authority must supply/u);

    expect(calls.reupsertRoutedProvider).toHaveBeenCalledOnce();
    expect(calls.reserveRoute).not.toHaveBeenCalled();
    expect(calls.updateSandbox).not.toHaveBeenCalled();
  });

  it("rechecks inside both route locks before router reconciliation (#9833)", async () => {
    const session = createSession({
      sandboxName: "router-sandbox",
      provider: "nvidia-router",
      model: "router/model",
    });
    session.steps.provider_selection.status = "complete";
    const preflightPolicyRequirements = vi.fn((requirements: { operation: string }) =>
      requirements.operation.startsWith("reconcile model router")
        ? refuseExternalPolicy()
        : undefined,
    );
    const { deps, calls } = createDeps({
      isInferenceRouteReady: vi.fn(() => true),
      preflightPolicyRequirements,
    });

    await expect(
      handleProviderInferenceState({
        ...baseOptions(deps, session),
        resume: true,
        sandboxName: "router-sandbox",
      }),
    ).rejects.toThrow(/external policy authority must supply/u);

    expect(calls.reconcileRouter).not.toHaveBeenCalled();
    expect(calls.reupsertRoutedProvider).not.toHaveBeenCalled();
    expect(calls.reserveRoute).not.toHaveBeenCalled();
    expect(calls.updateSandbox).not.toHaveBeenCalled();
  });

  it("rechecks inside the gateway lock before route reservation (#9833)", async () => {
    const session = createSession({
      sandboxName: "saved-sandbox",
      provider: "nvidia-prod",
      model: "nvidia/nemotron-test",
      endpointUrl: "https://integrate.api.nvidia.com/v1",
      credentialEnv: "NVIDIA_INFERENCE_API_KEY",
      preferredInferenceApi: "openai-responses",
    });
    session.steps.provider_selection.status = "complete";
    const preflightPolicyRequirements = vi.fn((requirements: { operation: string }) =>
      requirements.operation.startsWith("reserve inference route")
        ? refuseExternalPolicy()
        : undefined,
    );
    const { deps, calls } = createDeps({
      isInferenceRouteReady: vi.fn(() => true),
      preflightPolicyRequirements,
    });

    await expect(
      handleProviderInferenceState({
        ...baseOptions(deps, session),
        resume: true,
        sandboxName: "saved-sandbox",
      }),
    ).rejects.toThrow(/external policy authority must supply/u);

    expect(calls.reserveRoute).not.toHaveBeenCalled();
    expect(calls.setupInference).not.toHaveBeenCalled();
    expect(calls.reupsertRoutedProvider).not.toHaveBeenCalled();
    expect(calls.updateSandbox).not.toHaveBeenCalled();
  });

  it("rechecks before local inference provider preparation (#9833)", async () => {
    const setupNim = vi.fn(async () => ({
      ...baseSelection,
      provider: "ollama-local",
      model: "llama3.1",
      endpointUrl: "http://127.0.0.1:11434/v1",
      credentialEnv: null,
    }));
    const preflightPolicyRequirements = vi.fn((requirements: { operation: string }) =>
      requirements.operation.startsWith("prepare local inference provider")
        ? refuseExternalPolicy()
        : undefined,
    );
    const { deps, calls } = createDeps({ setupNim, preflightPolicyRequirements });

    await expect(handleProviderInferenceState(baseOptions(deps))).rejects.toThrow(
      /external policy authority must supply/u,
    );

    expect(calls.prepareLocalProviderForInference).not.toHaveBeenCalled();
    expect(calls.setupInference).not.toHaveBeenCalled();
    expect(calls.reupsertRoutedProvider).not.toHaveBeenCalled();
    expect(calls.reserveRoute).not.toHaveBeenCalled();
    expect(calls.updateSandbox).not.toHaveBeenCalled();
  });

  it("rechecks after legacy llama.cpp readiness before provider recovery (#9833)", async () => {
    const session = createSession({
      sandboxName: "alpha",
      provider: "llama-cpp-local",
      model: "managed/model",
      credentialEnv: "NEMOCLAW_LLAMACPP_LOCAL_TOKEN",
    });
    session.steps.provider_selection.status = "complete";
    const preflightPolicyRequirements = vi.fn((requirements: { operation: string }) =>
      requirements.operation.startsWith("recover inference provider")
        ? refuseExternalPolicy()
        : undefined,
    );
    const { deps, calls } = createDeps({
      isInferenceRouteReady: vi.fn(() => true),
      preflightPolicyRequirements,
    });

    await expect(
      handleProviderInferenceState({
        ...baseOptions(deps, session),
        resume: true,
        sandboxName: "alpha",
      }),
    ).rejects.toThrow(/external policy authority must supply/u);

    expect(calls.recoverManagedLlamaCpp).toHaveBeenCalledOnce();
    expect(calls.recoverProvider).not.toHaveBeenCalled();
    expect(calls.setupInference).not.toHaveBeenCalled();
  });

  it("rechecks after resume state awaits before local inference repair (#9833)", async () => {
    const session = createSession({
      sandboxName: "alpha",
      provider: "ollama-local",
      model: "llama3.1",
    });
    session.steps.provider_selection.status = "complete";
    const preflightPolicyRequirements = vi.fn((requirements: { operation: string }) =>
      requirements.operation.startsWith("repair local inference provider")
        ? refuseExternalPolicy()
        : undefined,
    );
    const { deps, calls } = createDeps({
      isInferenceRouteReady: vi.fn(() => true),
      preflightPolicyRequirements,
    });

    await expect(
      handleProviderInferenceState({
        ...baseOptions(deps, session),
        resume: true,
        sandboxName: "alpha",
      }),
    ).rejects.toThrow(/external policy authority must supply/u);

    expect(calls.recordSkip).toHaveBeenCalledWith("provider_selection", expect.any(Object));
    expect(calls.repair).not.toHaveBeenCalled();
    expect(calls.setupInference).not.toHaveBeenCalled();
  });

  it("rechecks before recording resumed provider selection state (#9833)", async () => {
    const session = createSession({
      sandboxName: "alpha",
      provider: "ollama-local",
      model: "llama3.1",
    });
    session.steps.provider_selection.status = "complete";
    const preflightPolicyRequirements = vi.fn((requirements: { operation: string }) =>
      requirements.operation === "record resumed provider selection"
        ? refuseExternalPolicy()
        : undefined,
    );
    const { deps, calls } = createDeps({
      isInferenceRouteReady: vi.fn(() => true),
      preflightPolicyRequirements,
    });

    await expect(
      handleProviderInferenceState({
        ...baseOptions(deps, session),
        resume: true,
        sandboxName: "alpha",
      }),
    ).rejects.toThrow(/external policy authority must supply/u);

    expect(calls.recordSkip).not.toHaveBeenCalled();
    expect(calls.repair).not.toHaveBeenCalled();
  });

  it("rechecks before recording reused inference state (#9833)", async () => {
    const session = createSession({
      sandboxName: "alpha",
      provider: "nvidia-prod",
      model: "nvidia/model",
    });
    session.steps.provider_selection.status = "complete";
    const preflightPolicyRequirements = vi.fn((requirements: { operation: string }) =>
      requirements.operation === "record reused inference setup"
        ? refuseExternalPolicy()
        : undefined,
    );
    const { deps, calls } = createDeps({
      isInferenceRouteReady: vi.fn(() => true),
      preflightPolicyRequirements,
    });

    await expect(
      handleProviderInferenceState({
        ...baseOptions(deps, session),
        resume: true,
        sandboxName: "alpha",
      }),
    ).rejects.toThrow(/external policy authority must supply/u);

    expect(calls.recordSkip).not.toHaveBeenCalledWith("inference", expect.any(Object));
    expect(calls.complete).not.toHaveBeenCalledWith("inference", expect.any(Object));
  });

  it("rechecks after provider review before recording the selection (#9833)", async () => {
    const preflightPolicyRequirements = vi.fn((requirements: { operation: string }) =>
      requirements.operation === "record reviewed provider selection"
        ? refuseExternalPolicy()
        : undefined,
    );
    const { deps, calls } = createDeps({ preflightPolicyRequirements });

    await expect(handleProviderInferenceState(baseOptions(deps))).rejects.toThrow(
      /external policy authority must supply/u,
    );

    expect(calls.complete).not.toHaveBeenCalledWith("provider_selection", expect.any(Object));
    expect(calls.prepareLocalProviderForInference).not.toHaveBeenCalled();
    expect(calls.setupInference).not.toHaveBeenCalled();
  });

  it("rechecks after local provider preparation before recording inference start (#9833)", async () => {
    const setupNim = vi.fn(async () => ({
      ...baseSelection,
      provider: "ollama-local",
      model: "llama3.1",
      endpointUrl: "http://127.0.0.1:11434/v1",
      credentialEnv: null,
    }));
    const preflightPolicyRequirements = vi.fn((requirements: { operation: string }) =>
      requirements.operation === "record inference setup start"
        ? refuseExternalPolicy()
        : undefined,
    );
    const { deps, calls } = createDeps({ setupNim, preflightPolicyRequirements });

    await expect(handleProviderInferenceState(baseOptions(deps))).rejects.toThrow(
      /external policy authority must supply/u,
    );

    expect(calls.prepareLocalProviderForInference).toHaveBeenCalledOnce();
    expect(calls.startStep).not.toHaveBeenCalledWith("inference", expect.any(Object));
    expect(calls.setupInference).not.toHaveBeenCalled();
  });

  it("rechecks after recording successful resumed Hermes inference (#9833)", async () => {
    const session = createSession({
      sandboxName: "alpha",
      provider: "hermes-provider",
      model: "hermes/model",
      credentialEnv: "NOUS_API_KEY",
    });
    session.steps.provider_selection.status = "complete";
    const preflightPolicyRequirements = vi.fn((requirements: { operation: string }) =>
      requirements.operation.startsWith("finish successful resumed inference")
        ? refuseExternalPolicy()
        : undefined,
    );
    const { deps, calls } = createDeps({
      isInferenceRouteReady: vi.fn(() => true),
      preflightPolicyRequirements,
    });

    await expect(
      handleProviderInferenceState({
        ...baseOptions(deps, session),
        resume: true,
        sandboxName: "alpha",
      }),
    ).rejects.toThrow(/external policy authority must supply/u);

    expect(calls.setupInference).toHaveBeenCalledOnce();
    expect(calls.complete).toHaveBeenCalledWith("inference", expect.any(Object));
  });

  it("rechecks after recording successful reused non-Hermes inference (#9833)", async () => {
    const session = createSession({
      sandboxName: "alpha",
      provider: "nvidia-prod",
      model: "nvidia/model",
    });
    session.steps.provider_selection.status = "complete";
    const preflightPolicyRequirements = vi.fn((requirements: { operation: string }) =>
      requirements.operation.startsWith("finish successful reused inference")
        ? refuseExternalPolicy()
        : undefined,
    );
    const { deps, calls } = createDeps({
      isInferenceRouteReady: vi.fn(() => true),
      preflightPolicyRequirements,
    });

    await expect(
      handleProviderInferenceState({
        ...baseOptions(deps, session),
        resume: true,
        sandboxName: "alpha",
      }),
    ).rejects.toThrow(/external policy authority must supply/u);

    expect(calls.recordSkip).toHaveBeenCalledWith("inference", expect.any(Object));
    expect(calls.complete).toHaveBeenCalledWith("inference", expect.any(Object));
  });

  it("rechecks after recording a deferred provider selection before inference success (#9833)", async () => {
    const session = createSession({
      sandboxName: "alpha",
      provider: "nvidia-prod",
      model: "nvidia/model",
      sandboxPromptProgress: {
        sandboxName: true,
        webSearch: false,
        messaging: false,
        resourceProfile: false,
      },
    });
    session.steps.provider_selection.status = "failed";
    const preflightPolicyRequirements = vi.fn((requirements: { operation: string }) =>
      requirements.operation.startsWith("record successful deferred provider selection")
        ? refuseExternalPolicy()
        : undefined,
    );
    const { deps, calls } = createDeps({ preflightPolicyRequirements });

    await expect(
      handleProviderInferenceState({
        ...baseOptions(deps, session),
        sandboxName: "alpha",
      }),
    ).rejects.toThrow(/external policy authority must supply/u);

    expect(calls.setupInference).toHaveBeenCalledOnce();
    expect(calls.complete).toHaveBeenCalledWith("provider_selection", expect.any(Object));
    expect(calls.complete).not.toHaveBeenCalledWith("inference", expect.any(Object));
  });
});
