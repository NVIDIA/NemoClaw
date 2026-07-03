// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { createSession, MACHINE_SNAPSHOT_VERSION, type Session } from "../state/onboard-session";
import {
  applySessionRecovery,
  assertRecoverableEntry,
  planSessionRecovery,
  UnrecoverableSessionError,
} from "./session-recovery";

function failedSession(mutator: (session: Session) => void): Session {
  const session = createSession({
    machine: {
      version: MACHINE_SNAPSHOT_VERSION,
      state: "failed",
      stateEnteredAt: "2026-06-01T00:00:00.000Z",
      revision: 4,
    },
    status: "failed",
    failure: { step: null, message: "interrupted", recordedAt: "2026-06-01T00:00:00.000Z" },
  });
  mutator(session);
  return session;
}

describe("planSessionRecovery", () => {
  it("plans one validated non-terminal entry for a failed terminal snapshot", () => {
    const session = failedSession((current) => {
      current.failure = {
        step: "gateway",
        message: "gateway failed",
        recordedAt: "2026-06-01T00:00:00.000Z",
      };
      current.lastStepStarted = "gateway";
      current.steps.gateway.status = "failed";
    });

    expect(planSessionRecovery(session)).toEqual({
      action: "recover",
      reason: "failed_terminal_snapshot",
      entry: "gateway",
    });
  });

  it("keeps a nonterminal snapshot", () => {
    const session = createSession({
      machine: {
        version: MACHINE_SNAPSHOT_VERSION,
        state: "gateway",
        stateEnteredAt: "2026-06-01T00:00:00.000Z",
        revision: 2,
      },
    });

    expect(planSessionRecovery(session)).toEqual({
      action: "keep",
      reason: "nonterminal_snapshot",
    });
  });

  it("does not mutate the session while planning", () => {
    const session = failedSession((current) => {
      current.lastStepStarted = "preflight";
      current.steps.preflight.status = "failed";
    });
    const before = JSON.stringify(session);

    planSessionRecovery(session);

    expect(JSON.stringify(session)).toBe(before);
  });
});

describe("assertRecoverableEntry", () => {
  it("returns a non-terminal entry unchanged", () => {
    expect(assertRecoverableEntry("gateway")).toBe("gateway");
  });

  it.each([
    "complete",
    "failed",
  ] as const)("rejects the terminal entry %s as unrecoverable", (state) => {
    expect(() => assertRecoverableEntry(state)).toThrow(UnrecoverableSessionError);
  });
});

describe("applySessionRecovery", () => {
  it("re-seats a failed snapshot at the validated entry with a bumped revision", () => {
    const session = failedSession((current) => {
      current.failure = {
        step: "preflight",
        message: "Docker unavailable",
        recordedAt: "2026-06-01T00:00:00.000Z",
      };
      current.lastStepStarted = "preflight";
      current.steps.preflight.status = "failed";
    });

    const plan = applySessionRecovery(session, "2026-06-01T00:01:00.000Z");

    expect(plan).toEqual({
      action: "recover",
      reason: "failed_terminal_snapshot",
      entry: "preflight",
    });
    expect(session.machine).toEqual({
      version: MACHINE_SNAPSHOT_VERSION,
      state: "preflight",
      stateEnteredAt: "2026-06-01T00:01:00.000Z",
      revision: 5,
    });
  });

  it("leaves a nonterminal snapshot untouched", () => {
    const session = createSession({
      machine: {
        version: MACHINE_SNAPSHOT_VERSION,
        state: "gateway",
        stateEnteredAt: "2026-06-01T00:00:00.000Z",
        revision: 2,
      },
    });

    const plan = applySessionRecovery(session, "2026-06-01T00:01:00.000Z");

    expect(plan).toEqual({ action: "keep", reason: "nonterminal_snapshot" });
    expect(session.machine.state).toBe("gateway");
    expect(session.machine.revision).toBe(2);
  });
});
