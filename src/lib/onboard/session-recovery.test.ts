// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  createSession,
  MACHINE_SNAPSHOT_VERSION,
  normalizeSession,
  type Session,
} from "../state/onboard-session";
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

function reopenedCompleteSession(): Session {
  const session = createSession({
    resumable: true,
    status: "in_progress",
    lastCompletedStep: "gateway",
    machine: {
      version: MACHINE_SNAPSHOT_VERSION,
      state: "complete",
      stateEnteredAt: "2026-06-01T00:00:00.000Z",
      revision: 9,
    },
  });
  session.steps.preflight.status = "complete";
  session.steps.gateway.status = "complete";
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

  it("plans the next entry for a reopened complete snapshot (#6227)", () => {
    expect(planSessionRecovery(reopenedCompleteSession())).toEqual({
      action: "recover",
      reason: "reopened_complete_snapshot",
      entry: "provider_selection",
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
    expect(session.machine).toMatchObject({
      version: MACHINE_SNAPSHOT_VERSION,
      state: "preflight",
      stateEnteredAt: "2026-06-01T00:01:00.000Z",
      revision: 5,
      recoveryReceipt: {
        reason: "failed_terminal_snapshot",
        entry: "preflight",
        appliedAt: "2026-06-01T00:01:00.000Z",
        revision: 5,
      },
    });
    expect(session.machine.recoveryReceipt?.id).toMatch(/^[a-f0-9]{64}$/);
  });

  it("re-seats a reopened complete snapshot and records its recovery reason (#6227)", () => {
    const session = reopenedCompleteSession();

    const plan = applySessionRecovery(session, "2026-06-01T00:01:00.000Z");

    expect(plan).toEqual({
      action: "recover",
      reason: "reopened_complete_snapshot",
      entry: "provider_selection",
    });
    expect(session.machine).toMatchObject({
      state: "provider_selection",
      stateEnteredAt: "2026-06-01T00:01:00.000Z",
      revision: 10,
      recoveryReceipt: {
        reason: "reopened_complete_snapshot",
        entry: "provider_selection",
        appliedAt: "2026-06-01T00:01:00.000Z",
        revision: 10,
      },
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

  it("rejects a noncanonical recovery timestamp", () => {
    expect(() => applySessionRecovery(reopenedCompleteSession(), "yesterday")).toThrow(
      "canonical ISO timestamp",
    );
  });
});

describe("session recovery receipt persistence", () => {
  it("round-trips one stable receipt ID without another recovery revision (#6227)", () => {
    const original = reopenedCompleteSession();
    applySessionRecovery(original, "2026-06-01T00:01:00.000Z");
    const persisted = normalizeSession(JSON.parse(JSON.stringify(original))) as Session;
    const receipt = persisted.machine.recoveryReceipt;
    expect(receipt).toBeDefined();
    const revision = persisted.machine.revision;

    expect(planSessionRecovery(persisted)).toEqual({
      action: "keep",
      reason: "nonterminal_snapshot",
    });

    const restarted = normalizeSession(JSON.parse(JSON.stringify(persisted))) as Session;
    expect(restarted.machine.recoveryReceipt).toEqual(receipt);
    expect(restarted.machine.revision).toBe(revision);
  });

  it.each([
    ["unknown reason", { reason: "unknown" }],
    ["terminal entry", { entry: "complete" }],
    ["mismatched revision", { revision: 99 }],
    ["mismatched ID", { id: "b".repeat(64) }],
    ["mismatched timestamp", { appliedAt: "2026-06-01T00:02:00.000Z" }],
    ["noncanonical timestamp", { appliedAt: "yesterday" }],
  ])("drops a malformed recovery receipt with %s", (_label, mutation) => {
    const session = reopenedCompleteSession();
    applySessionRecovery(session, "2026-06-01T00:01:00.000Z");
    const serialized = JSON.parse(JSON.stringify(session)) as {
      machine: { recoveryReceipt: Record<string, unknown> };
    };
    Object.assign(serialized.machine.recoveryReceipt, mutation);

    expect(normalizeSession(serialized as never)?.machine.recoveryReceipt).toBeUndefined();
  });
});
