// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  assertValidOnboardMachineTransition,
  canTransitionOnboardMachineState,
  getNextOnboardMachineStates,
  getOnboardMachineTransition,
  InvalidOnboardMachineTransitionError,
  isOnboardMachineState,
  isTerminalOnboardMachineState,
  ONBOARD_MACHINE_DIRECT_TRANSITIONS,
  ONBOARD_MACHINE_NEXT_STATES,
  ONBOARD_MACHINE_TRANSITIONS,
} from "./transitions";
import {
  ONBOARD_MACHINE_EVENT_TYPES,
  ONBOARD_MACHINE_STATES,
  ONBOARD_NON_TERMINAL_MACHINE_STATES,
} from "./types";

const canonicalDirectTransitions = [
  ["init", "preflight", "advance"],
  ["preflight", "gateway", "advance"],
  ["gateway", "provider_selection", "advance"],
  ["provider_selection", "inference", "advance"],
  ["inference", "provider_selection", "retry"],
  ["inference", "sandbox", "advance"],
  ["sandbox", "openclaw", "branch"],
  ["sandbox", "agent_setup", "branch"],
  ["openclaw", "policies", "advance"],
  ["agent_setup", "policies", "advance"],
  ["policies", "finalizing", "advance"],
  ["finalizing", "post_verify", "advance"],
  ["post_verify", "complete", "advance"],
] as const;

describe("onboard machine vocabulary", () => {
  it("defines the initial coarse state vocabulary from issue #3802", () => {
    expect(ONBOARD_MACHINE_STATES).toEqual([
      "init",
      "preflight",
      "gateway",
      "provider_selection",
      "inference",
      "sandbox",
      "agent_setup",
      "openclaw",
      "policies",
      "finalizing",
      "post_verify",
      "complete",
      "failed",
    ]);
  });

  it("defines the initial observe-only event vocabulary from issue #3802", () => {
    expect(ONBOARD_MACHINE_EVENT_TYPES).toEqual([
      "onboard.started",
      "onboard.resumed",
      "onboard.completed",
      "onboard.failed",
      "state.entered",
      "state.exited",
      "state.skipped",
      "state.completed",
      "state.failed",
      "state.repair.started",
      "state.repair.completed",
      "state.repair.failed",
      "state.result.skipped",
      "context.updated",
      "resume.conflict",
      "hook.started",
      "hook.completed",
      "hook.failed",
    ]);
  });

  it("recognizes valid machine state names", () => {
    expect(isOnboardMachineState("preflight")).toBe(true);
    expect(isOnboardMachineState("messaging")).toBe(false);
    expect(isOnboardMachineState(null)).toBe(false);
  });
});

describe("onboard machine transitions", () => {
  it("encodes the canonical direct transition graph", () => {
    expect(ONBOARD_MACHINE_DIRECT_TRANSITIONS).toEqual(
      canonicalDirectTransitions.map(([from, to, kind]) => ({ from, to, kind })),
    );
  });

  it("allows every non-terminal state to fail", () => {
    for (const state of ONBOARD_NON_TERMINAL_MACHINE_STATES) {
      expect(canTransitionOnboardMachineState(state, "failed")).toBe(true);
      expect(getOnboardMachineTransition(state, "failed")?.kind).toBe("failure");
    }
  });

  it("keeps terminal states terminal", () => {
    expect(isTerminalOnboardMachineState("complete")).toBe(true);
    expect(isTerminalOnboardMachineState("failed")).toBe(true);
    expect(getNextOnboardMachineStates("complete")).toEqual([]);
    expect(getNextOnboardMachineStates("failed")).toEqual([]);
    expect(canTransitionOnboardMachineState("complete", "failed")).toBe(false);
    expect(canTransitionOnboardMachineState("failed", "init")).toBe(false);
  });

  it("exposes next states in deterministic order", () => {
    expect(ONBOARD_MACHINE_NEXT_STATES).toEqual({
      init: ["preflight", "failed"],
      preflight: ["gateway", "failed"],
      gateway: ["provider_selection", "failed"],
      provider_selection: ["inference", "failed"],
      inference: ["provider_selection", "sandbox", "failed"],
      sandbox: ["openclaw", "agent_setup", "failed"],
      agent_setup: ["policies", "failed"],
      openclaw: ["policies", "failed"],
      policies: ["finalizing", "failed"],
      finalizing: ["post_verify", "failed"],
      post_verify: ["complete", "failed"],
      complete: [],
      failed: [],
    });
  });

  it("classifies retry and branch transitions", () => {
    expect(assertValidOnboardMachineTransition("inference", "provider_selection")).toMatchObject({
      kind: "retry",
    });
    expect(assertValidOnboardMachineTransition("sandbox", "openclaw")).toMatchObject({
      kind: "branch",
    });
    expect(assertValidOnboardMachineTransition("sandbox", "agent_setup")).toMatchObject({
      kind: "branch",
    });
  });

  it("rejects transitions outside the graph", () => {
    expect(() => assertValidOnboardMachineTransition("init", "sandbox")).toThrow(
      InvalidOnboardMachineTransitionError,
    );
    expect(() => assertValidOnboardMachineTransition("complete", "failed")).toThrow(
      "complete -> failed",
    );
  });

  it("keeps the next-state map aligned with the transition list", () => {
    for (const state of ONBOARD_MACHINE_STATES) {
      expect(
        ONBOARD_MACHINE_TRANSITIONS.filter((transition) => transition.from === state).map(
          (transition) => transition.to,
        ),
      ).toEqual(getNextOnboardMachineStates(state));
    }
  });

  it("does not contain duplicate transition edges", () => {
    const edges = ONBOARD_MACHINE_TRANSITIONS.map(({ from, to }) => `${from}->${to}`);
    expect(new Set(edges).size).toBe(edges.length);
  });
});
