// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  createSession,
  MACHINE_SNAPSHOT_VERSION,
  type Session,
} from "../state/onboard-session";
import {
  repairResumeMachineSnapshot,
  resumeMachineState,
} from "./resume-machine-repair";

function createFailedSession(mutator: (session: Session) => void): Session {
  const session = createSession({
    machine: {
      version: MACHINE_SNAPSHOT_VERSION,
      state: "failed",
      stateEnteredAt: "2026-06-01T00:00:00.000Z",
      revision: 7,
    },
    status: "failed",
    failure: {
      step: null,
      message: "interrupted",
      recordedAt: "2026-06-01T00:00:00.000Z",
    },
  });
  mutator(session);
  return session;
}

describe("resume machine repair", () => {
  it("resumes a failed preflight session from preflight", () => {
    const session = createFailedSession((current) => {
      current.failure = {
        step: "preflight",
        message: "Docker is unavailable",
        recordedAt: "2026-06-01T00:00:00.000Z",
      };
      current.lastStepStarted = "preflight";
      current.steps.preflight.status = "failed";
    });

    expect(resumeMachineState(session)).toBe("preflight");
    repairResumeMachineSnapshot(session, "2026-06-01T00:01:00.000Z");

    expect(session.machine).toEqual({
      version: MACHINE_SNAPSHOT_VERSION,
      state: "preflight",
      stateEnteredAt: "2026-06-01T00:01:00.000Z",
      revision: 8,
    });
  });

  it("uses the failed step before the last completed step", () => {
    const session = createFailedSession((current) => {
      current.lastCompletedStep = "provider_selection";
      current.steps.provider_selection.status = "complete";
      current.lastStepStarted = "inference";
      current.steps.inference.status = "failed";
      current.failure = {
        step: "inference",
        message: "route validation failed",
        recordedAt: "2026-06-01T00:00:00.000Z",
      };
    });

    expect(resumeMachineState(session)).toBe("inference");
  });

  it("derives the branch state after sandbox when no failed step is recorded", () => {
    const session = createFailedSession((current) => {
      current.agent = "hermes";
      current.lastCompletedStep = "sandbox";
      current.steps.sandbox.status = "complete";
      current.failure = null;
    });

    expect(resumeMachineState(session)).toBe("agent_setup");
  });

  it("leaves nonterminal snapshots untouched", () => {
    const session = createSession({
      machine: {
        version: MACHINE_SNAPSHOT_VERSION,
        state: "gateway",
        stateEnteredAt: "2026-06-01T00:00:00.000Z",
        revision: 3,
      },
    });

    repairResumeMachineSnapshot(session, "2026-06-01T00:01:00.000Z");

    expect(session.machine).toEqual({
      version: MACHINE_SNAPSHOT_VERSION,
      state: "gateway",
      stateEnteredAt: "2026-06-01T00:00:00.000Z",
      revision: 3,
    });
  });
});
