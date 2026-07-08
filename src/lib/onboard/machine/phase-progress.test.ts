// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  createPhaseProgressReporter,
  ONBOARD_PHASE_LABELS,
  type PhaseProgressOptions,
} from "./phase-progress";
import { advanceTo } from "./result";
import type { OnboardSequencePhase, OnboardSequencePhaseResult } from "./sequence-runner";

function phase(
  state: OnboardSequencePhase<string>["state"],
  run: (context: string) => Promise<OnboardSequencePhaseResult<string>>,
): OnboardSequencePhase<string> {
  return { state, run };
}

function createHarness(overrides: Partial<PhaseProgressOptions> = {}) {
  const state = {
    clockMs: 0,
    timerCallback: null as (() => void) | null,
    timerIntervalMs: null as number | null,
    cleared: false,
    lines: [] as string[],
  };
  const reporter = createPhaseProgressReporter({
    enabled: true,
    heartbeatIntervalMs: 30_000,
    now: () => state.clockMs,
    setTimer: (callback, intervalMs) => {
      state.timerCallback = callback;
      state.timerIntervalMs = intervalMs;
      return { unref() {} };
    },
    clearTimer: () => {
      state.cleared = true;
    },
    logLine: (line) => state.lines.push(line),
    ...overrides,
  });
  return { reporter, state };
}

describe("phase progress", () => {
  it("returns phases unchanged when disabled or not wait-heavy", () => {
    const original = phase("preflight", async (context) => ({
      context,
      result: advanceTo("gateway"),
    }));
    expect(createPhaseProgressReporter({ enabled: false }).wrap(original)).toBe(original);
    expect(createPhaseProgressReporter({ enabled: true }).wrap(original)).toBe(original);
  });

  it("emits a periodic heartbeat and always clears its timer", async () => {
    const { reporter, state } = createHarness();
    const wrapped = reporter.wrap(
      phase("gateway", async (context) => {
        state.clockMs = 30_000;
        state.timerCallback?.();
        return { context, result: advanceTo("provider_selection") };
      }),
    );

    await wrapped.run("ctx");

    expect(state.timerIntervalMs).toBe(30_000);
    expect(state.lines).toEqual(["  ⏳ Still working on Gateway startup… (30s elapsed)"]);
    expect(state.cleared).toBe(true);
  });

  it.each([
    "gateway",
    "inference",
    "sandbox",
    "agent_setup",
    "openclaw",
    "finalizing",
    "post_verify",
  ] as const)("keeps wait-heavy phase %s on the heartbeat path", async (stateName) => {
    const { reporter, state } = createHarness();
    await reporter
      .wrap(
        phase(stateName, async (context) => ({
          context,
          result: advanceTo("post_verify"),
        })),
      )
      .run("ctx");
    expect(state.timerCallback).not.toBeNull();
  });

  it.each([
    "provider_selection",
    "policies",
  ] as const)("protects the interactive %s prompt from heartbeat output", async (stateName) => {
    const { reporter, state } = createHarness({ interactive: true });
    await reporter
      .wrap(
        phase(stateName, async (context) => ({
          context,
          result: advanceTo("post_verify"),
        })),
      )
      .run("ctx");
    expect(state.timerCallback).toBeNull();
  });

  it("heartbeats prompt-owning phases during non-interactive onboarding", async () => {
    const { reporter, state } = createHarness({ interactive: false });
    await reporter
      .wrap(
        phase("provider_selection", async (context) => ({
          context,
          result: advanceTo("inference"),
        })),
      )
      .run("ctx");
    expect(state.timerCallback).not.toBeNull();
  });

  it("clears the timer and preserves the phase error", async () => {
    const { reporter, state } = createHarness();
    const wrapped = reporter.wrap(
      phase("gateway", async () => {
        throw new Error("gateway exploded");
      }),
    );
    await expect(wrapped.run("ctx")).rejects.toThrow("gateway exploded");
    expect(state.cleared).toBe(true);
  });

  it("keeps heartbeat logging best-effort", async () => {
    const { reporter, state } = createHarness({
      logLine: () => {
        throw new Error("closed output");
      },
    });
    await reporter
      .wrap(
        phase("gateway", async (context) => {
          state.clockMs = 30_000;
          expect(() => state.timerCallback?.()).not.toThrow();
          return { context, result: advanceTo("provider_selection") };
        }),
      )
      .run("ctx");
  });

  it("supports a shorter heartbeat interval for focused tests", async () => {
    const valid = createHarness({
      heartbeatIntervalMs: 12_000,
    });
    await valid.reporter
      .wrap(
        phase("gateway", async (context) => ({
          context,
          result: advanceTo("provider_selection"),
        })),
      )
      .run("ctx");
    expect(valid.state.timerIntervalMs).toBe(12_000);
  });

  it("provides a friendly label for every non-terminal state", () => {
    for (const [state, label] of Object.entries(ONBOARD_PHASE_LABELS)) {
      expect(label.trim().length, state).toBeGreaterThan(0);
    }
  });
});
