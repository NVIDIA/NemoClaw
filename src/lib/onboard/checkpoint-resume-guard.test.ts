// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { decisionUnset } from "../state/onboard-checkpoint-decision";
import {
  CHECKPOINT_SCHEMA_VERSION,
  type CheckpointLoadResult,
  type OnboardCheckpoint,
} from "../state/onboard-checkpoint-types";
import { createSession } from "../state/onboard-session";
import { type OnboardSessionBootstrapDeps, prepareOnboardSession } from "./session-bootstrap";

class ExitError extends Error {
  constructor(readonly code: number) {
    super(`exit:${code}`);
  }
}

const resumeInput = {
  resume: true,
  fresh: false,
  requestedFromDockerfile: null,
  requestedSandboxName: null,
  cannotPrompt: false,
  nonInteractive: false,
};

const loadedCheckpoint: OnboardCheckpoint = {
  schemaVersion: CHECKPOINT_SCHEMA_VERSION,
  sessionId: "s1",
  machineState: "sandbox",
  updatedAt: "2026-01-01T00:00:00.000Z",
  sandboxIdentity: decisionUnset(),
  webSearch: decisionUnset(),
  messaging: decisionUnset(),
  resourceProfile: decisionUnset(),
  gatewayAuthority: decisionUnset(),
  effectGroups: {},
  bindings: { credentialEnvs: [], registeredProviders: [] },
};

function makeDeps(overrides: Partial<OnboardSessionBootstrapDeps>): OnboardSessionBootstrapDeps {
  return {
    loadSession: () => createSession({ sessionId: "s1", agent: "openclaw" }),
    clearSession: () => {},
    createSession: (o) => createSession(o),
    saveSession: (s) => s,
    updateSession: (mutator) => {
      const session = createSession({ sessionId: "s1", agent: "openclaw" });
      mutator(session);
      return session;
    },
    applySessionRecovery: () => {},
    setOnboardBrandingAgent: () => {},
    getResumeConfigConflicts: () => [],
    recordResumeConflict: async () => undefined,
    resolvePath: (v) => v,
    cliName: () => "nemoclaw",
    error: () => {},
    exitProcess: (code) => {
      throw new ExitError(code);
    },
    resolveResumeCheckpoint: (): CheckpointLoadResult => ({ status: "none" }),
    ...overrides,
  };
}

describe("resume checkpoint fail-safe (#6228)", () => {
  it("aborts with guidance on an unsupported future checkpoint instead of resuming", async () => {
    const error = vi.fn();
    const deps = makeDeps({
      error,
      resolveResumeCheckpoint: (): CheckpointLoadResult => ({
        status: "unsupported_future",
        foundVersion: 99,
      }),
    });
    await expect(prepareOnboardSession(resumeInput, deps)).rejects.toBeInstanceOf(ExitError);
    expect(error.mock.calls.flat().join("\n")).toContain("v99");
  });

  it("aborts on a corrupt checkpoint rather than continuing", async () => {
    const error = vi.fn();
    const deps = makeDeps({
      error,
      resolveResumeCheckpoint: (): CheckpointLoadResult => ({ status: "corrupt" }),
    });
    await expect(prepareOnboardSession(resumeInput, deps)).rejects.toBeInstanceOf(ExitError);
    expect(error.mock.calls.flat().join("\n")).toContain("unreadable");
  });

  it("continues past the guard when the checkpoint loads cleanly", async () => {
    const deps = makeDeps({
      resolveResumeCheckpoint: (): CheckpointLoadResult => ({
        status: "loaded",
        checkpoint: loadedCheckpoint,
      }),
      getResumeConfigConflicts: () => {
        throw new Error("PAST_GUARD");
      },
    });
    await expect(prepareOnboardSession(resumeInput, deps)).rejects.toThrow("PAST_GUARD");
  });

  it("always runs checkpoint validation before resuming — there is no path that skips it (#6228)", async () => {
    const resolveResumeCheckpoint = vi.fn((): CheckpointLoadResult => ({ status: "none" }));
    const deps = makeDeps({
      resolveResumeCheckpoint,
      getResumeConfigConflicts: () => {
        throw new Error("PAST_GUARD");
      },
    });
    await expect(prepareOnboardSession(resumeInput, deps)).rejects.toThrow("PAST_GUARD");
    expect(resolveResumeCheckpoint).toHaveBeenCalled();
  });

  it("persists a migrated legacy checkpoint onto the session instead of re-deriving it every resume (#7022)", async () => {
    let persistedSession = createSession({ sessionId: "s1", agent: "openclaw" });
    const updateSession = vi.fn((mutator: (session: typeof persistedSession) => void) => {
      mutator(persistedSession);
      return persistedSession;
    });
    const deps = makeDeps({
      updateSession,
      resolveResumeCheckpoint: (): CheckpointLoadResult => ({
        status: "migrated",
        checkpoint: loadedCheckpoint,
        fromVersion: 0,
      }),
      getResumeConfigConflicts: () => {
        throw new Error("PAST_GUARD");
      },
    });
    await expect(prepareOnboardSession(resumeInput, deps)).rejects.toThrow("PAST_GUARD");
    expect(updateSession).toHaveBeenCalled();
    expect(persistedSession.checkpoint).toEqual(loadedCheckpoint);
  });
});
