// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { llamaCppHostLocalInferenceReceipt } from "../../../../../test/helpers/host-local-inference-receipt";
import { createSession } from "../../../state/onboard-session";
import type {
  HostLocalInferenceStartupSelection,
  HostLocalInferenceStartupSelectionInput,
} from "../../runtime-provider/host-local-inference-routing";
import {
  handleProviderInferenceState,
  type ProviderInferenceStateOptions,
} from "./provider-inference";
import {
  baseOptions,
  baseSelection,
  createDeps,
  type Agent,
  type Gpu,
  type Host,
} from "./provider-inference.test-support";

type TestProviderInferenceOptions = ProviderInferenceStateOptions<Gpu, Agent, Host>;

function refuseExternalPolicy(): never {
  throw new Error("external policy authority must supply the selected route");
}

function publishedLlamaCppSelection(
  input: HostLocalInferenceStartupSelectionInput,
): HostLocalInferenceStartupSelection {
  return {
    runtimeProviderId: "mxc",
    request: {
      application: input.application,
      service: "llama-cpp",
      adapter: {
        gatewayPort: 8080,
        runtimeOwnerSandboxName: "llama-owner",
        model: input.model,
        operation: {} as never,
        receipt: llamaCppHostLocalInferenceReceipt("mxc"),
        runtime: {} as never,
        prepareStartup: vi.fn() as never,
      },
      requireToolCalling: input.requireToolCalling ?? true,
      publishedRoute: true,
    },
    resolveRuntimeProvider: () => null,
    prepareGatewayMutation: async () => ({ commit: () => {}, rollback: () => {} }),
  };
}

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

  it("rechecks after routed provider upsert before reserving the route (#9833)", async () => {
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

  it("rechecks before local inference provider preparation (#9833)", async () => {
    const setupNim = vi.fn<TestProviderInferenceOptions["deps"]["setupNim"]>(
      async (
        _gpu,
        _sandboxName,
        _agent,
        _allowRecordedProviderRecovery,
        _gatewayName,
        _assertRouteCompatible,
        _canProbeRoute,
        _recoverySessionId,
        revalidatePolicyRequirements,
      ) => {
        const selection = {
          ...baseSelection,
          provider: "ollama-local",
          model: "llama3.1",
          endpointUrl: "http://127.0.0.1:11434/v1",
          credentialEnv: null,
        };
        expect(revalidatePolicyRequirements).toBeTypeOf("function");
        revalidatePolicyRequirements!(selection, "install managed local runtime");
        return selection;
      },
    );
    const preflightPolicyRequirements = vi.fn((requirements: { operation: string }) =>
      requirements.operation === "install managed local runtime"
        ? refuseExternalPolicy()
        : undefined,
    );
    const { deps, calls } = createDeps({ setupNim, preflightPolicyRequirements });

    await expect(handleProviderInferenceState(baseOptions(deps))).rejects.toThrow(
      /external policy authority must supply/u,
    );

    expect(setupNim).toHaveBeenCalledOnce();
    expect(calls.prepareLocalProviderForInference).not.toHaveBeenCalled();
    expect(calls.setupInference).not.toHaveBeenCalled();
    expect(calls.updateSandbox).not.toHaveBeenCalled();
  });

  it("withholds inference success after a deferred selection loses authority (#9833)", async () => {
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
    expect(calls.complete).not.toHaveBeenCalledWith("provider_selection", expect.any(Object));
    expect(calls.complete).not.toHaveBeenCalledWith("inference", expect.any(Object));
  });

  it("withholds durable inference success when final policy authority changes (#9833)", async () => {
    const preflightPolicyRequirements = vi.fn((requirements: { operation: string }) =>
      requirements.operation === "record successful inference configuration"
        ? refuseExternalPolicy()
        : undefined,
    );
    const { deps, calls } = createDeps({ preflightPolicyRequirements });

    await expect(handleProviderInferenceState(baseOptions(deps))).rejects.toThrow(
      /external policy authority must supply/u,
    );

    expect(calls.setupInference).toHaveBeenCalledOnce();
    expect(calls.complete).not.toHaveBeenCalledWith("inference", expect.any(Object));
  });

  it("withholds resumed provider reuse output when policy authority changes (#9833)", async () => {
    const session = createSession({
      provider: "ollama-local",
      model: "llama3.1",
      credentialEnv: null,
    });
    session.steps.provider_selection.status = "complete";
    const refuseReusePublication = () => {
      throw new Error("policy authority changed");
    };
    const policyChecks = new Map([["record resumed provider selection", refuseReusePublication]]);
    const { deps, calls } = createDeps({
      isInferenceRouteReady: vi.fn(() => true),
      preflightPolicyRequirements: (input) => policyChecks.get(input.operation)?.(),
    });

    await expect(
      handleProviderInferenceState({
        ...baseOptions(deps, session),
        resume: true,
        sandboxName: "my-assistant",
      }),
    ).rejects.toThrow("policy authority changed");

    expect(calls.skipped).not.toHaveBeenCalled();
    expect(calls.log).not.toHaveBeenCalledWith(expect.stringContaining("Reusing sandbox name"));
    expect(calls.recordSkip).not.toHaveBeenCalled();
  });

  it("loads resumed route-only authority before the first policy preflight (#9833)", async () => {
    const session = createSession({
      sandboxName: "my-assistant",
      provider: "llama-cpp-local",
      model: "persisted-served-alias",
      endpointUrl: null,
      credentialEnv: null,
      preferredInferenceApi: "openai-completions",
      sandboxPromptProgress: {
        sandboxName: true,
        webSearch: false,
        messaging: false,
        resourceProfile: false,
      },
    });
    session.steps.provider_selection.status = "complete";
    const preflightPolicyRequirements = vi.fn(
      (input: { hostLocalInferenceRouteOnly?: boolean }) => {
        expect(input.hostLocalInferenceRouteOnly).toBe(true);
      },
    );
    const resolver = vi.fn(publishedLlamaCppSelection);
    const { deps } = createDeps({
      preflightPolicyRequirements,
      resolveHostLocalInferenceStartupSelection: resolver,
    });

    await expect(
      handleProviderInferenceState({
        ...baseOptions(deps, session),
        resume: true,
        sandboxName: "my-assistant",
      }),
    ).resolves.toMatchObject({ hostLocalInferenceRouteOnly: true });

    expect(preflightPolicyRequirements).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        operation: "select an inference provider",
        hostLocalInferenceRouteOnly: true,
      }),
    );
    expect(resolver).toHaveBeenCalledOnce();
  });

  it("does not treat a saved host-local endpoint as route-only proof (#9833)", async () => {
    const session = createSession({
      sandboxName: "my-assistant",
      provider: "llama-cpp-local",
      model: "persisted-served-alias",
      endpointUrl: "https://inference.local/v1",
      credentialEnv: null,
      preferredInferenceApi: "openai-completions",
      sandboxPromptProgress: {
        sandboxName: true,
        webSearch: false,
        messaging: false,
        resourceProfile: false,
      },
    });
    session.steps.provider_selection.status = "complete";
    const preflightPolicyRequirements = vi.fn(
      (input: { hostLocalInferenceRouteOnly?: boolean }) => {
        expect(input.hostLocalInferenceRouteOnly).toBe(false);
        throw new Error("external policy authority must supply local-inference");
      },
    );
    const { deps, calls } = createDeps({ preflightPolicyRequirements });
    const options = baseOptions(deps, session);

    await expect(
      handleProviderInferenceState({
        ...options,
        initial: { ...options.initial, endpointSource: "inference-set" },
        resume: true,
        sandboxName: "my-assistant",
      }),
    ).rejects.toThrow("external policy authority must supply local-inference");

    expect(preflightPolicyRequirements).toHaveBeenCalledOnce();
    expect(calls.resolveHostLocalInferenceStartupSelection).toHaveBeenCalledOnce();
    expect(calls.setupInference).not.toHaveBeenCalled();
  });
});
