// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const SANDBOX = "ollama-mode";
const GATEWAY = "nemoclaw-18789";
const ROUTE = {
  provider: "ollama-local",
  model: "qwen3.5:9b",
  endpointUrl: "http://127.0.0.1:11434/v1",
  endpointSource: "inference-set" as const,
  credentialEnv: "NEMOCLAW_OLLAMA_PROXY_TOKEN",
  preferredInferenceApi: null,
  gatewayName: GATEWAY,
};

const freshRoute = { ...ROUTE, reservationSessionId: "session-of-this-fresh-run" };

const createdHomes: string[] = [];
const heldLockModules: (typeof import("../state/onboard-session"))[] = [];

/**
 * Point the registry and the onboard session at a private state root.
 *
 * Every test drives the real modules rather than mocks, so each one needs its
 * own `HOME`. The directory is recorded for teardown: an assertion that throws
 * mid-test would otherwise leave it behind.
 */
async function isolatedOnboardHome(): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-abandoned-reservation-"));
  createdHomes.push(home);
  vi.stubEnv("HOME", home);
  vi.resetModules();
  return home;
}

/**
 * Acquire the onboard lock for a session that owns `sessionId`.
 *
 * Teardown releases the lock through the same module instance, because
 * `vi.resetModules()` would otherwise strand the held descriptor in a module
 * copy no later test can reach.
 */
async function onboardingSessionUnderLock(
  sessionId: string,
  command: string,
  gatewayName = GATEWAY,
  gatewayPort = gatewayName === GATEWAY ? 18789 : 18790,
): Promise<void> {
  const onboardSession = await import("../state/onboard-session");
  heldLockModules.push(onboardSession);
  onboardSession.acquireOnboardLock(command);
  const session = onboardSession.createSession({ sessionId });
  const { bindGatewayAuthorityToCheckpoint } = await import("./gateway-authority-checkpoint");
  bindGatewayAuthorityToCheckpoint(session, {
    gatewayName,
    gatewayPort,
    mode: "nemoclaw-managed",
    source: "standalone",
    endpoint: null,
    stateDir: null,
    supervisor: null,
    requiredCapabilities: [],
  });
  onboardSession.saveSession(session);
}

/** Reserve a route under `sessionId`, then abandon the run without releasing it. */
async function seedAbandonedReservation(sessionId: string): Promise<void> {
  const registry = await import("../state/registry");
  registry.reserveSandboxInferenceRoute(SANDBOX, { ...ROUTE, reservationSessionId: sessionId });
}

describe("abandoned inference route reservation (#11051)", () => {
  afterEach(async () => {
    for (const onboardSession of heldLockModules.splice(0)) onboardSession.releaseOnboardLock();
    vi.unstubAllEnvs();
    vi.resetModules();
    for (const home of createdHomes.splice(0)) {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("transfers a published reservation when resume skips inference setup", async () => {
    await isolatedOnboardHome();
    await onboardingSessionUnderLock("resume-current", "onboard --resume");
    const sessionStore = await import("../state/onboard-session");
    const registry = await import("../state/registry");
    const { handleProviderInferenceState } = await import("./machine/handlers/provider-inference");
    const { baseOptions, baseSelection, createDeps } =
      await import("./machine/handlers/provider-inference.test-support");
    const session = sessionStore.loadSession()!;
    Object.assign(session, baseSelection, { sandboxName: SANDBOX });
    session.steps.provider_selection.status = "complete";
    session.steps.inference.status = "complete";
    sessionStore.saveSession(session);
    const route = {
      provider: baseSelection.provider,
      model: baseSelection.model,
      endpointUrl: baseSelection.endpointUrl,
      credentialEnv: baseSelection.credentialEnv,
      preferredInferenceApi: baseSelection.preferredInferenceApi,
      endpointSource: null,
      gatewayName: GATEWAY,
    };
    registry.registerSandbox({ name: SANDBOX, ...route, gatewayPort: 18789, agent: "openclaw" });
    registry.reserveSandboxInferenceRoute(SANDBOX, { ...route, reservationSessionId: "abandoned" });
    const { deps, calls } = createDeps({
      isInferenceRouteReady: () => true,
      reserveSandboxInferenceRoute: registry.reserveSandboxInferenceRoute,
      recordStepComplete: async () => session,
      recordStateSkipped: async () => session,
    });
    await handleProviderInferenceState({
      ...baseOptions(deps, session),
      gatewayName: GATEWAY,
      resume: true,
      sandboxName: SANDBOX,
      requestedSandboxName: SANDBOX,
    });
    expect(calls.setupInference).not.toHaveBeenCalled();
    expect(registry.getSandbox(SANDBOX)).toMatchObject({
      reservationSessionId: session.sessionId,
      pendingRouteReservation: true,
      agent: "openclaw",
    });
    expect(registry.finalizeSandboxRouteReservation(SANDBOX, session.sessionId)).toBe(true);
    expect(registry.getSandbox(SANDBOX)?.pendingRouteReservation).toBeUndefined();
  }, 15_000);

  it("transfers and publishes an abandoned route after Ready sandbox reuse", async () => {
    await isolatedOnboardHome();
    await onboardingSessionUnderLock("reuse-current", "onboard --resume");
    const sessionStore = await import("../state/onboard-session");
    const registry = await import("../state/registry");
    const { handleSandboxState } = await import("./machine/handlers/sandbox");
    const { baseOptions, createDeps } = await import("./machine/handlers/sandbox-test-fixtures");
    const session = sessionStore.loadSession()!;
    session.sandboxName = SANDBOX;
    session.steps.sandbox.status = "complete";
    session.machine.state = "agent_setup";
    const { recordCheckpointSandboxIdentity } = await import("./checkpoint-record");
    recordCheckpointSandboxIdentity(session, SANDBOX, "openclaw");
    sessionStore.saveSession(session);
    const route = {
      provider: "provider",
      model: "model",
      endpointUrl: null,
      endpointSource: null,
      credentialEnv: null,
      preferredInferenceApi: "openai-completions",
      gatewayName: GATEWAY,
    };
    registry.registerSandbox({
      name: SANDBOX,
      ...route,
      gatewayPort: 18789,
      agent: "openclaw",
      toolDisclosure: "progressive",
    });
    registry.reserveSandboxInferenceRoute(SANDBOX, { ...route, reservationSessionId: "abandoned" });
    const createdAt = registry.getSandbox(SANDBOX)!.createdAt;
    const { deps, calls } = createDeps(
      {
        getSandboxReuseState: () => "ready",
        getSandboxAgentRegistryFields: () => ({ agent: "openclaw" }),
        getSandboxRegistryEntry: registry.getSandbox,
        updateSandboxRegistry: registry.updateSandbox,
        reserveSandboxInferenceRoute: registry.reserveSandboxInferenceRoute,
        finalizeSandboxRouteReservation: registry.finalizeSandboxRouteReservation,
      },
      session,
    );
    await handleSandboxState({
      ...baseOptions(deps, session),
      agent: { name: "openclaw" },
      ...route,
      resume: true,
      sandboxName: SANDBOX,
    });
    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(registry.getSandbox(SANDBOX)).toMatchObject({
      createdAt,
      reservationSessionId: session.sessionId,
      gatewayPort: 18789,
      agent: "openclaw",
      toolDisclosure: "progressive",
    });
    expect(registry.getSandbox(SANDBOX)?.pendingRouteReservation).toBeUndefined();
  }, 15_000);

  it("refuses a later onboarding session while the abandoned reservation stands", async () => {
    await isolatedOnboardHome();
    await seedAbandonedReservation("session-from-an-abandoned-run");
    const registry = await import("../state/registry");

    expect(() =>
      registry.reserveSandboxInferenceRoute(SANDBOX, {
        ...ROUTE,
        reservationSessionId: "session-of-this-fresh-run",
      }),
    ).toThrow(
      `Cannot replace sandbox '${SANDBOX}': its inference route reservation belongs to another onboarding session`,
    );
  });

  it("releases the abandoned reservation and admits the fresh run", async () => {
    await isolatedOnboardHome();
    await seedAbandonedReservation("session-from-an-abandoned-run");
    const registry = await import("../state/registry");
    const { releaseAbandonedRouteReservation } = await import("./sandbox-lifecycle");
    await onboardingSessionUnderLock("session-of-this-fresh-run", "onboard --fresh");

    expect(releaseAbandonedRouteReservation(SANDBOX, freshRoute)).toBe(true);
    expect(registry.getSandbox(SANDBOX)).toBeNull();
    expect(
      registry.reserveSandboxInferenceRoute(SANDBOX, {
        ...ROUTE,
        reservationSessionId: "session-of-this-fresh-run",
      }),
    ).toBe(true);
  });

  it("releases a failed re-onboard reservation without removing the registered sandbox (#12278)", async () => {
    await isolatedOnboardHome();
    const registry = await import("../state/registry");
    const { releaseAbandonedRouteReservation } = await import("./sandbox-lifecycle");
    registry.registerSandbox({
      name: SANDBOX,
      ...ROUTE,
      agent: "openclaw",
      agentVersion: "2026.9.1",
      dashboardPort: 18790,
    });
    await seedAbandonedReservation("session-from-failed-credential-validation");
    const reserved = registry.getSandbox(SANDBOX)!;
    const reclaimed = { ...reserved, reservationSessionId: "session-of-this-fresh-run" };
    await onboardingSessionUnderLock("session-of-this-fresh-run", "onboard --fresh");

    expect(releaseAbandonedRouteReservation(SANDBOX, freshRoute)).toBe(true);
    expect(registry.getSandbox(SANDBOX)).toEqual(reclaimed);
    expect(registry.getDefault()).toBeNull();
    expect(
      registry.reserveSandboxInferenceRoute(SANDBOX, {
        ...ROUTE,
        reservationSessionId: "session-of-this-fresh-run",
      }),
    ).toBe(true);
    expect(registry.getSandbox(SANDBOX)).toMatchObject({
      createdAt: reserved.createdAt,
      agent: "openclaw",
      agentVersion: "2026.9.1",
      dashboardPort: 18790,
      reservationSessionId: "session-of-this-fresh-run",
    });
  });

  it("preserves a registered reservation belonging to another gateway", async () => {
    await isolatedOnboardHome();
    const registry = await import("../state/registry");
    const { releaseAbandonedRouteReservation } = await import("./sandbox-lifecycle");
    registry.registerSandbox({ name: SANDBOX, ...ROUTE, agent: "openclaw" });
    await seedAbandonedReservation("session-from-another-gateway");
    const reserved = registry.getSandbox(SANDBOX);
    await onboardingSessionUnderLock("current-session", "onboard --fresh", "nemoclaw-18790");

    expect(
      releaseAbandonedRouteReservation(SANDBOX, {
        ...freshRoute,
        reservationSessionId: "current-session",
      }),
    ).toBe(false);
    expect(registry.getSandbox(SANDBOX)).toEqual(reserved);
  });

  it.each([
    { recordedPort: 18789, checkpointPort: 18790 },
    { recordedPort: 18790, checkpointPort: 18789 },
  ])(
    "preserves mismatched recorded/checkpoint ports $recordedPort/$checkpointPort",
    async ({ recordedPort, checkpointPort }) => {
      await isolatedOnboardHome();
      const registry = await import("../state/registry");
      const { releaseAbandonedRouteReservation } = await import("./sandbox-lifecycle");
      registry.registerSandbox({
        name: SANDBOX,
        ...ROUTE,
        gatewayPort: recordedPort,
        agent: "openclaw",
      });
      await seedAbandonedReservation("prior-session");
      const reserved = registry.getSandbox(SANDBOX);
      await onboardingSessionUnderLock(
        "current-session",
        "onboard --fresh",
        GATEWAY,
        checkpointPort,
      );
      expect(
        releaseAbandonedRouteReservation(SANDBOX, {
          ...freshRoute,
          reservationSessionId: "current-session",
        }),
      ).toBe(false);
      expect(registry.getSandbox(SANDBOX)).toEqual(reserved);
    },
  );

  it("reclaims a published reservation through the real setup-inference caller", async () => {
    await isolatedOnboardHome();
    const registry = await import("../state/registry");
    const { createSetupInference } = await import("./setup-inference");
    const route = {
      ...ROUTE,
      provider: "router-test",
      endpointUrl: "http://router.test/v1",
      credentialEnv: "ROUTER_KEY",
    };
    registry.registerSandbox({
      name: SANDBOX,
      ...route,
      gatewayPort: 18789,
      agent: "openclaw",
      dashboardPort: 18790,
    });
    registry.reserveSandboxInferenceRoute(SANDBOX, { ...route, reservationSessionId: "abandoned" });
    const previous = registry.getSandbox(SANDBOX)!;
    await onboardingSessionUnderLock("current-session", "onboard --fresh");
    const locked = async <T>(_key: string | number, operation: () => Promise<T> | T) =>
      await operation();
    const setup = createSetupInference({
      checkGatewayRouteCompatibility: () => ({ ok: true }),
      withSandboxMutationLock: locked,
      withGatewayRouteMutationLock: locked,
      withModelRouterPortLifecycleLock: locked,
      getModelRouterPort: () => 4000,
      step: vi.fn(),
      getGatewayName: () => GATEWAY,
      runOpenshell: () => ({ status: 0 }),
      updateSandbox: registry.reserveSandboxInferenceRoute,
      upsertProvider: () => ({ ok: true }),
      verifyInferenceRoute: vi.fn(),
      verifyOnboardInferenceSmoke: vi.fn(),
      isNonInteractive: () => true,
      hermesProviderAuth: { HERMES_PROVIDER_NAME: "hermes-provider" },
      isRoutedInferenceProvider: () => true,
      reconcileModelRouter: async () => undefined,
      routedInference: {
        upsertRoutedProvider: () => ({
          ok: true,
          endpointUrl: route.endpointUrl,
          result: { ok: true },
        }),
      },
      hydrateCredentialEnv: () => "fixture-key",
      redact: (value: string) => value,
      compactText: (value: string) => value,
      log: vi.fn(),
      error: vi.fn(),
      exitProcess: (code: number): never => {
        throw new Error(`exit ${code}`);
      },
    } as unknown as import("./setup-inference").SetupInferenceDeps);
    await expect(
      setup(
        SANDBOX,
        route.model,
        route.provider,
        route.endpointUrl,
        route.credentialEnv,
        null,
        [],
        {
          skipHostInferenceSmoke: true,
          reservationSessionId: "current-session",
          revalidateSandboxIdentity: () => undefined,
        },
      ),
    ).resolves.toEqual({ ok: true });
    expect(registry.getSandbox(SANDBOX)).toMatchObject({
      createdAt: previous.createdAt,
      agent: "openclaw",
      dashboardPort: 18790,
      gatewayName: GATEWAY,
      gatewayPort: 18789,
      reservationSessionId: "current-session",
      pendingRouteReservation: true,
    });
  }, 15000);

  it("keeps a reservation the running onboarding session already owns", async () => {
    await isolatedOnboardHome();
    await seedAbandonedReservation("session-of-this-fresh-run");
    const registry = await import("../state/registry");
    const { releaseAbandonedRouteReservation } = await import("./sandbox-lifecycle");
    await onboardingSessionUnderLock("session-of-this-fresh-run", "onboard --resume");

    expect(releaseAbandonedRouteReservation(SANDBOX, freshRoute)).toBe(false);
    expect(registry.getSandbox(SANDBOX)).toMatchObject({
      name: SANDBOX,
      reservationSessionId: "session-of-this-fresh-run",
    });
  });

  it("keeps a foreign reservation when this process does not hold the onboard lock", async () => {
    await isolatedOnboardHome();
    await seedAbandonedReservation("session-from-an-abandoned-run");
    const onboardSession = await import("../state/onboard-session");
    const registry = await import("../state/registry");
    const { releaseAbandonedRouteReservation } = await import("./sandbox-lifecycle");
    onboardSession.saveSession(
      onboardSession.createSession({ sessionId: "session-of-this-fresh-run" }),
    );

    expect(onboardSession.isOnboardLockHeldByCurrentProcess()).toBe(false);
    expect(releaseAbandonedRouteReservation(SANDBOX, freshRoute)).toBe(false);
    expect(registry.getSandbox(SANDBOX)).toMatchObject({
      name: SANDBOX,
      reservationSessionId: "session-from-an-abandoned-run",
    });
  });

  it("keeps a published sandbox row that is no longer a route-only reservation", async () => {
    await isolatedOnboardHome();
    await seedAbandonedReservation("session-from-an-abandoned-run");
    const registry = await import("../state/registry");
    const { releaseAbandonedRouteReservation } = await import("./sandbox-lifecycle");
    registry.finalizeSandboxRouteReservation(SANDBOX, "session-from-an-abandoned-run");
    await onboardingSessionUnderLock("session-of-this-fresh-run", "onboard --fresh");

    expect(releaseAbandonedRouteReservation(SANDBOX, freshRoute)).toBe(false);
    expect(registry.getSandbox(SANDBOX)).toMatchObject({ name: SANDBOX });
  });
});
