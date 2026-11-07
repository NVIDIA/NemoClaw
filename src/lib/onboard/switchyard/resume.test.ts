// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { createSwitchyardProviderFixture } from "../../../../test/support/switchyard-provider-adapter";
import {
  createHermesSwitchyardRoutingIntent,
  encodeHermesSwitchyardRoutingIntent,
  encodeSwitchyardProviderBindings,
  HERMES_SWITCHYARD_BINDINGS_ENV,
  HERMES_SWITCHYARD_ROUTING_ENV,
} from "../../hermes-switchyard-routing";
import { createSession, type Session } from "../../state/onboard-session";
import type { SandboxEntry } from "../../state/registry";
import { handleProviderInferenceState } from "../machine/handlers/provider-inference";
import {
  baseOptions as inferenceOptions,
  createDeps as inferenceDeps,
} from "../machine/handlers/provider-inference.test-support";
import { handleSandboxState } from "../machine/handlers/sandbox";
import {
  baseOptions as sandboxOptions,
  createDeps as sandboxDeps,
} from "../machine/handlers/sandbox-test-fixtures";
import { createSetupInference, type SetupInferenceDeps } from "../setup-inference";

// The image-GC host fence is outside this provider-reservation controller regression.
vi.mock("../sandbox-registration", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sandbox-registration")>()),
  withSandboxImageRegistrationFence: async <T>(operation: () => Promise<T> | T) => operation(),
}));

const routing = createHermesSwitchyardRoutingIntent({
  efficient: { provider: "nvidia-prod", model: "efficient-model" },
  capable: { provider: "openai-api", model: "capable-model" },
});

async function interruptedOnboarding() {
  const fixture = createSwitchyardProviderFixture(routing, "nemoclaw", "hermes");
  fixture.input.readCredential = vi.fn(fixture.input.readCredential);
  const env: NodeJS.ProcessEnv = {
    [HERMES_SWITCHYARD_ROUTING_ENV]: encodeHermesSwitchyardRoutingIntent(routing),
  };
  let session = createSession({
    sandboxName: "hermes",
    agent: "hermes",
    provider: routing.capable.provider,
    model: routing.capable.model,
    endpointUrl: "https://api.openai.com/v1",
    credentialEnv: "OPENAI_API_KEY",
    preferredInferenceApi: "openai-completions",
  });
  let entry: SandboxEntry | null = null;
  const setup = createSetupInference({
    environment: env,
    providerAdapter: fixture.input.adapter,
    hydrateCredentialEnv: fixture.input.readCredential,
    updateSandbox: (name: string, route: Parameters<SetupInferenceDeps["updateSandbox"]>[1]) => {
      entry = { name, ...route, pendingRouteReservation: true };
      return true;
    },
    getSandbox: () => entry,
    getGatewayName: () => "nemoclaw",
    isRoutedInferenceProvider: () => false,
    withSandboxMutationLock: async <T>(_name: string, operation: () => Promise<T> | T) =>
      operation(),
    withGatewayRouteMutationLock: async <T>(_name: string, operation: () => Promise<T> | T) =>
      operation(),
    inferenceRouteMutator: { setInferenceRoute: vi.fn() },
    localInference: {
      loadPendingOllamaModelCleanup: () => [],
      loadPersistedOllamaHost: () => null,
    },
    withOllamaModelOwnershipLock: <T>(operation: () => T) => operation(),
    log: vi.fn(),
  } as unknown as SetupInferenceDeps);
  const { deps, calls } = inferenceDeps({
    setupInference: setup,
    setupNim: async () => ({
      model: routing.capable.model,
      provider: routing.capable.provider,
      endpointUrl: "https://api.openai.com/v1",
      credentialEnv: "OPENAI_API_KEY",
      hermesAuthMethod: null,
      hermesToolGateways: [],
      preferredInferenceApi: "openai-completions",
      compatibleEndpointReasoning: null,
      compatibleEndpointReasoningEffort: null,
      nimContainer: null,
    }),
    getSandboxRegistryEntry: () => entry,
    recordStepComplete: async (step, updates) => {
      Object.assign(session, updates);
      session.steps[step as keyof Session["steps"]].status = "complete";
      return session;
    },
  });
  const runInference = (resume: boolean) =>
    handleProviderInferenceState({
      ...inferenceOptions(deps, session),
      sandboxName: "hermes",
      requestedSandboxName: "hermes",
      agent: { name: "hermes" },
      resume,
      env,
    });
  await runInference(false);
  expect(session.steps.inference.status).toBe("complete");
  expect(session.steps.sandbox.status).not.toBe("complete");
  expect(entry).toMatchObject({
    pendingRouteReservation: true,
    reservationSessionId: session.sessionId,
    hermesSwitchyard: { routing },
  });
  // A new process has the durable checkpoint and registry, not the old binding environment.
  session = structuredClone(session);
  delete env[HERMES_SWITCHYARD_BINDINGS_ENV];
  vi.clearAllMocks();
  return { fixture, env, calls, runInference, entry: () => entry!, session: () => session };
}

describe("Switchyard interrupted onboarding", () => {
  it("resumes after inference through sandbox creation without creating providers again (#13863)", async () => {
    const state = await interruptedOnboarding();
    const result = await state.runInference(true);
    expect(state.calls.hydrate).not.toHaveBeenCalled();
    expect(state.fixture.input.readCredential).not.toHaveBeenCalled();
    const recorded = state.entry();
    const expected = recorded.hermesSwitchyard!;
    const bindingEnvironment = encodeSwitchyardProviderBindings(expected.bindings, routing);
    expect(state.env[HERMES_SWITCHYARD_BINDINGS_ENV]).toBe(bindingEnvironment);
    const { deps, calls } = sandboxDeps(
      { getSandboxRegistryEntry: () => recorded },
      state.session(),
    );
    calls.createSandbox.mockImplementationOnce(async () => {
      expect(state.env[HERMES_SWITCHYARD_BINDINGS_ENV]).toBe(bindingEnvironment);
      return "hermes";
    });
    await handleSandboxState({
      ...sandboxOptions(deps, state.session()),
      resume: true,
      sandboxName: "hermes",
      agent: { name: "hermes" },
      provider: result.provider,
      model: result.model,
      endpointUrl: result.endpointUrl,
      credentialEnv: result.credentialEnv,
      preferredInferenceApi: result.preferredInferenceApi,
      env: state.env,
    });
    expect(calls.createSandbox).toHaveBeenCalledTimes(1);
    expect(state.fixture.methods.getProvider).toHaveBeenCalled();
    expect(state.fixture.methods.createProvider).not.toHaveBeenCalled();
    expect(state.fixture.methods.updateProvider).not.toHaveBeenCalled();
    expect(state.fixture.methods.deleteProvider).not.toHaveBeenCalled();
    expect(state.entry().hermesSwitchyard).toEqual(expected);
  });

  it("rejects another session's reservation before sandbox creation or provider mutation (#13863)", async () => {
    const state = await interruptedOnboarding();
    state.entry().reservationSessionId = "foreign-session";
    await expect(state.runInference(true)).rejects.toThrow("onboarding session");
    expect(state.calls.hydrate).not.toHaveBeenCalled();
    expect(state.fixture.input.readCredential).not.toHaveBeenCalled();
    expect(state.env).not.toHaveProperty(HERMES_SWITCHYARD_BINDINGS_ENV);
    expect(state.fixture.methods.getProvider).not.toHaveBeenCalled();
    expect(state.fixture.methods.createProvider).not.toHaveBeenCalled();
    expect(state.fixture.methods.updateProvider).not.toHaveBeenCalled();
    expect(state.fixture.methods.deleteProvider).not.toHaveBeenCalled();
  });
});
