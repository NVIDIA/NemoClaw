// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { CheckpointLoadResult } from "../state/onboard-checkpoint-types";
import { createSession, normalizeSession, type Session } from "../state/onboard-session";
import { getResumeConfigConflicts } from "./resume-config";
import {
  type OnboardSessionBootstrapDeps,
  prepareOnboardSession,
  sessionSandboxAccess,
} from "./session-bootstrap";

const ORIGIN = "https://launchpad.example.test:8443";

class ExitError extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

/** Session store and resume dependencies backed by one in-memory session. */
function createDeps(initial: Session | null = null) {
  let session = initial;
  const deps: OnboardSessionBootstrapDeps = {
    loadSession: vi.fn(() => session),
    clearSession: vi.fn(() => {
      session = null;
    }),
    createSession: vi.fn((overrides?: Partial<Session>) => createSession(overrides)),
    saveSession: vi.fn((next: Session) => {
      session = next;
      return next;
    }),
    updateSession: vi.fn((mutator: (current: Session) => Session | void) => {
      const current = session ?? createSession();
      session = mutator(current) ?? current;
      return session;
    }),
    applySessionRecovery: vi.fn(),
    setOnboardBrandingAgent: vi.fn(),
    getResumeConfigConflicts,
    recordResumeConflict: vi.fn(async () => undefined),
    resolvePath: vi.fn((value: string) => `/abs/${value}`),
    cliName: vi.fn(() => "nemoclaw"),
    error: vi.fn(),
    exitProcess: vi.fn((code: number) => {
      throw new ExitError(code);
    }) as (code: number) => never,
    requireHostMountRuntimeSupport: vi.fn(),
    resolveResumeCheckpoint: vi.fn((): CheckpointLoadResult => ({ status: "none" })),
  };
  return deps;
}

const baseInput = {
  fresh: false,
  requestedFromDockerfile: null,
  requestedSandboxName: "saved",
  cannotPrompt: true,
  nonInteractive: true,
};

/** Start onboarding with origins, then reload the session the way a new process would. */
async function interruptedSessionWithOrigins(): Promise<Session> {
  const started = await prepareOnboardSession(
    { ...baseInput, resume: false, requestedDashboardOrigins: [ORIGIN] },
    createDeps(),
  );
  const persisted = normalizeSession(JSON.parse(JSON.stringify(started.session)));
  expect(persisted).not.toBeNull();
  return persisted as Session;
}

describe("onboard resume keeps dashboard origins (#13177)", () => {
  it("replays the recorded origins when resume omits them", async () => {
    const resumed = await prepareOnboardSession(
      { ...baseInput, resume: true },
      createDeps(await interruptedSessionWithOrigins()),
    );

    expect(sessionSandboxAccess([], resumed.session).dashboardOrigins).toEqual([ORIGIN]);
  });

  it("refuses a different origin list on resume", async () => {
    const deps = createDeps(await interruptedSessionWithOrigins());

    await expect(
      prepareOnboardSession(
        { ...baseInput, resume: true, requestedDashboardOrigins: ["https://other.example.test"] },
        deps,
      ),
    ).rejects.toThrow(ExitError);
    expect(deps.recordResumeConflict).toHaveBeenCalledWith(
      expect.objectContaining({ field: "dashboard origins" }),
    );
  });

  it("accepts the same origins again on resume", async () => {
    const resumed = await prepareOnboardSession(
      { ...baseInput, resume: true, requestedDashboardOrigins: [ORIGIN] },
      createDeps(await interruptedSessionWithOrigins()),
    );

    expect(resumed.session?.metadata.dashboardOrigins).toEqual([ORIGIN]);
  });

  it("starts a fresh run without origins it did not request", async () => {
    const fresh = await prepareOnboardSession(
      { ...baseInput, resume: false, fresh: true },
      createDeps(await interruptedSessionWithOrigins()),
    );

    expect(sessionSandboxAccess([], fresh.session).dashboardOrigins).toBeUndefined();
  });
});
