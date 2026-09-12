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
async function onboardingSessionUnderLock(sessionId: string, command: string): Promise<void> {
  const onboardSession = await import("../state/onboard-session");
  heldLockModules.push(onboardSession);
  onboardSession.acquireOnboardLock(command);
  onboardSession.saveSession(onboardSession.createSession({ sessionId }));
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

    expect(releaseAbandonedRouteReservation(SANDBOX)).toBe(true);
    expect(registry.getSandbox(SANDBOX)).toBeNull();
    expect(
      registry.reserveSandboxInferenceRoute(SANDBOX, {
        ...ROUTE,
        reservationSessionId: "session-of-this-fresh-run",
      }),
    ).toBe(true);
  });

  it("keeps a reservation the running onboarding session already owns", async () => {
    await isolatedOnboardHome();
    await seedAbandonedReservation("session-of-this-fresh-run");
    const registry = await import("../state/registry");
    const { releaseAbandonedRouteReservation } = await import("./sandbox-lifecycle");
    await onboardingSessionUnderLock("session-of-this-fresh-run", "onboard --resume");

    expect(releaseAbandonedRouteReservation(SANDBOX)).toBe(false);
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
    expect(releaseAbandonedRouteReservation(SANDBOX)).toBe(false);
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

    expect(releaseAbandonedRouteReservation(SANDBOX)).toBe(false);
    expect(registry.getSandbox(SANDBOX)).toMatchObject({ name: SANDBOX });
  });
});
