// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession } from "../../../state/onboard-session";
import { handleProviderInferenceState } from "./provider-inference";
import { baseOptions, baseSelection, createDeps } from "./provider-inference.test-support";

function refuseExternalPolicy(): never {
  throw new Error("external policy authority must supply the selected route");
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
    const setupNim = vi.fn(async (...args: unknown[]) => {
      const revalidatePolicyRequirements = args[8] as (
        route: {
          provider: string;
          model: string;
          endpointUrl: string | null;
          credentialEnv: string | null;
          preferredInferenceApi: string | null;
        },
        operation: string,
      ) => void;
      revalidatePolicyRequirements(
        {
          provider: "ollama-local",
          model: "llama3.1",
          endpointUrl: "http://127.0.0.1:11434/v1",
          credentialEnv: null,
          preferredInferenceApi: "openai-completions",
        },
        "install managed local runtime",
      );
      return {
        ...baseSelection,
        provider: "ollama-local",
        model: "llama3.1",
        endpointUrl: "http://127.0.0.1:11434/v1",
        credentialEnv: null,
      };
    });
    const policyChecks = new Map([["install managed local runtime", refuseExternalPolicy]]);
    const preflightPolicyRequirements = vi.fn((requirements: { operation: string }) =>
      policyChecks.get(requirements.operation)?.(),
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

  it("withholds inference success when authority changes after deferred selection (#9833)", async () => {
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
      requirements.operation === "record successful inference configuration"
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

    expect(calls.complete).toHaveBeenCalledWith("provider_selection", expect.any(Object));
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
});
