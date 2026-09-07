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

async function isolatedOnboardHome(): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-abandoned-reservation-"));
  vi.stubEnv("HOME", home);
  vi.resetModules();
  return home;
}

/** Reserve a route under `sessionId`, then abandon the run without releasing it. */
async function seedAbandonedReservation(sessionId: string): Promise<void> {
  const registry = await import("../state/registry");
  registry.reserveSandboxInferenceRoute(SANDBOX, { ...ROUTE, reservationSessionId: sessionId });
}

describe("abandoned inference route reservation (#11051)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
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
    const onboardSession = await import("../state/onboard-session");
    const registry = await import("../state/registry");
    const { releaseAbandonedRouteReservation } = await import("./sandbox-lifecycle");
    onboardSession.acquireOnboardLock("onboard --fresh");
    onboardSession.saveSession(
      onboardSession.createSession({ sessionId: "session-of-this-fresh-run" }),
    );

    expect(releaseAbandonedRouteReservation(SANDBOX)).toBe(true);
    expect(registry.getSandbox(SANDBOX)).toBeNull();
    expect(
      registry.reserveSandboxInferenceRoute(SANDBOX, {
        ...ROUTE,
        reservationSessionId: "session-of-this-fresh-run",
      }),
    ).toBe(true);
    onboardSession.releaseOnboardLock();
  });

  it("keeps a reservation the running onboarding session already owns", async () => {
    await isolatedOnboardHome();
    await seedAbandonedReservation("session-of-this-fresh-run");
    const onboardSession = await import("../state/onboard-session");
    const registry = await import("../state/registry");
    const { releaseAbandonedRouteReservation } = await import("./sandbox-lifecycle");
    onboardSession.acquireOnboardLock("onboard --resume");
    onboardSession.saveSession(
      onboardSession.createSession({ sessionId: "session-of-this-fresh-run" }),
    );

    expect(releaseAbandonedRouteReservation(SANDBOX)).toBe(false);
    expect(registry.getSandbox(SANDBOX)).toMatchObject({
      name: SANDBOX,
      reservationSessionId: "session-of-this-fresh-run",
    });
    onboardSession.releaseOnboardLock();
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
    const onboardSession = await import("../state/onboard-session");
    const registry = await import("../state/registry");
    const { releaseAbandonedRouteReservation } = await import("./sandbox-lifecycle");
    registry.finalizeSandboxRouteReservation(SANDBOX, "session-from-an-abandoned-run");
    onboardSession.acquireOnboardLock("onboard --fresh");
    onboardSession.saveSession(
      onboardSession.createSession({ sessionId: "session-of-this-fresh-run" }),
    );

    expect(releaseAbandonedRouteReservation(SANDBOX)).toBe(false);
    expect(registry.getSandbox(SANDBOX)).toMatchObject({ name: SANDBOX });
    onboardSession.releaseOnboardLock();
  });
});
