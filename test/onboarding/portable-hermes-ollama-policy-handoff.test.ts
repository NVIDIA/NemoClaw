// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { parseHostLocalInferenceReceipt } from "../../src/lib/onboard/runtime-provider/host-local-inference";
import type { SetupInference, SetupInferenceDeps } from "../../src/lib/onboard/setup-inference";
import { createDirectSetupInferenceHarnessFactory } from "../support/setup-inference-test-harness";
import { createHermesPortableInferenceFixture } from "../helpers/hermes-portable-onboarding-fixture";
import {
  createPhases as createCorePhases,
  context,
} from "../../src/lib/onboard/machine/core-flow-phases-test-fixtures";
import { createPhases as createFinalPhases } from "../helpers/onboard-final-flow-phases";
import { createHermesPortableOllamaInferenceResolver } from "../../src/lib/onboard/experimental/hermes-portable-ollama-inference";
import { createSession, type SessionUpdates } from "../../src/lib/state/onboard-session";
import {
  finalizeSandboxRouteReservation,
  getSandbox,
  registerSandbox,
  removeSandbox,
  reserveSandboxInferenceRoute,
  updateSandbox,
} from "../../src/lib/state/registry";

const onboard = require("../../src/lib/onboard") as {
  createSetupInference: (overrides?: Partial<SetupInferenceDeps>) => SetupInference;
};
const createHarness = createDirectSetupInferenceHarnessFactory(onboard.createSetupInference);

describe("Portable Hermes Ollama onboarding", () => {
  it("carries a Portable Hermes Ollama receipt from provider setup through sandbox and policy phases (#13653)", async () => {
    const portable = createHermesPortableInferenceFixture();
    const session = createSession();
    const sandboxName = "portable-hermes";
    const model = "qwen3-vl:4b";
    const gpu = { platform: "linux", type: "nvidia" };
    const resolver = createHermesPortableOllamaInferenceResolver({
      ...portable.resolverOptions,
      getReservationSessionId: () => session.sessionId,
    });
    const recordStepComplete = async (_step: string, updates: SessionUpdates = {}) => {
      Object.assign(session, updates);
      return session;
    };
    const harness = createHarness({
      overrides: {
        applyLocalInferenceRoute: undefined,
        getSandbox,
        updateSandbox: reserveSandboxInferenceRoute,
        isNonInteractive: () => true,
      },
    });
    const phases = createCorePhases({
      providerDeps: {
        setupNim: async () => ({
          model,
          provider: "ollama-local",
          endpointUrl: null,
          credentialEnv: null,
          hermesAuthMethod: null,
          hermesToolGateways: [],
          preferredInferenceApi: "openai-completions",
          compatibleEndpointReasoning: null,
          compatibleEndpointReasoningEffort: null,
          nimContainer: null,
        }),
        resolveHostLocalInferenceStartupSelection: resolver,
        setupInference: harness.setupInference,
        recordStepComplete,
        promptValidatedSandboxName: async () => sandboxName,
      },
      sandboxOptions: { hermesPortableLifecycle: true },
      sandboxDeps: {
        promptValidatedSandboxName: async () => sandboxName,
        loadSession: () => session,
        updateSession: (mutator) => mutator(session) ?? session,
        setupMessagingChannels: async () => [],
        getSandboxRegistryEntry: getSandbox,
        createSandbox: async () => {
          // The external create boundary supplies the Portable profile; keep registry persistence real.
          registerSandbox(
            {
              ...getSandbox(sandboxName)!,
              name: sandboxName,
              agent: "hermes",
              portableLifecycleProfile: "hermes",
            },
            undefined,
            { pending: true, reservationSessionId: session.sessionId },
          );
          return sandboxName;
        },
        finalizeSandboxRouteReservation,
        reserveSandboxInferenceRoute,
        updateSandboxRegistry: updateSandbox,
        recordStepComplete,
      },
    });
    const setupPolicies = vi.fn(async () => [] as string[]);
    const [, policyPhase] = createFinalPhases("agent_setup", [], {
      getActiveSandbox: () => getSandbox(sandboxName),
      setupPoliciesWithSelection: setupPolicies,
    });
    try {
      const providerResult = await phases.providerInference.run(
        context({
          fresh: true,
          gpu,
          session,
          sandboxName,
          agent: { name: "hermes" },
          selectedMessagingChannels: [],
        }),
      );
      const sandboxResult = await phases.sandbox.run(providerResult.context);
      const recorded = getSandbox(sandboxName);
      expect(recorded).toMatchObject({
        agent: "hermes",
        portableLifecycleProfile: "hermes",
        provider: "ollama-local",
        model,
        endpointUrl: "https://inference.local/v1",
      });
      expect(recorded?.pendingRouteReservation).not.toBe(true);
      expect(recorded?.nativeLocalProviderAttachment).toBeUndefined();
      expect(parseHostLocalInferenceReceipt(recorded!.hostLocalInferenceReceipt!)).toMatchObject({
        providerId: "podman",
        service: "ollama",
        inference: { model },
        runtime: { kind: "container" },
      });
      const policyResult = await policyPhase.run(sandboxResult.context);
      expect(policyResult.result).toMatchObject({ type: "transition", next: "finalizing" });
      expect(setupPolicies).toHaveBeenCalledWith(
        sandboxName,
        expect.objectContaining({
          provider: null,
          excludedPresets: ["local-inference"],
        }),
      );
    } finally {
      removeSandbox(sandboxName);
    }
  });
});
