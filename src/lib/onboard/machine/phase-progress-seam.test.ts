// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { createPhaseProgressReporter } from "./phase-progress";
import { fakePhase, makeHarness } from "./phase-progress-test-support";
import {
  buildOnboardSequenceHandlers,
  type OnboardSequencePhase,
  runOnboardSequenceWithRunner,
} from "./sequence-runner";

describe("buildOnboardSequenceHandlers wiring (seam integration)", () => {
  it("drives heartbeat + timing through the onboarding sequence seam", async () => {
    const harness = makeHarness();
    const reporter = createPhaseProgressReporter(harness.options);
    const gatewayPhase = fakePhase("gateway", async () => {
      // Simulate a silent wait that outlives one heartbeat interval.
      harness.clockMs = 30_000;
      harness.timerCallback?.();
      harness.clockMs = 31_000;
      return { context: "ctx", result: "ok" };
    });

    // The reporter is applied inside buildOnboardSequenceHandlers, so the wrapped
    // handler must emit the heartbeat and record timing for the real seam.
    const handlers = buildOnboardSequenceHandlers<string>([gatewayPhase], () => {}, reporter);
    await handlers.gateway?.("ctx");

    expect(
      harness.lines.some((line) =>
        line.includes("⏳ Still working on Gateway startup… (30s elapsed)"),
      ),
    ).toBe(true);
    expect(harness.records[0]).toMatchObject({ phase: "gateway", status: "completed" });
  });

  it("is inert at the seam when the reporter is disabled", async () => {
    const harness = makeHarness({ enabled: false });
    const reporter = createPhaseProgressReporter(harness.options);
    const phase = fakePhase("gateway", async () => ({ context: "ctx", result: "ok" }));
    const handlers = buildOnboardSequenceHandlers<string>([phase], () => {}, reporter);
    await handlers.gateway?.("ctx");
    expect(harness.records).toHaveLength(0);
    expect(harness.lines).toHaveLength(0);
  });

  it("emits a heartbeat when driven through the real sequence runner", async () => {
    // Exercises the actual onboarding runner path (runOnboardSequenceWithRunner
    // -> runOnboardMachine -> wrapped phase), not just the reporter in isolation.
    const harness = makeHarness();
    const reporter = createPhaseProgressReporter(harness.options);
    let machineState = "gateway";
    const runtime = {
      async session() {
        return { machine: { state: machineState } } as never;
      },
      async applyResult(result: { type?: string; next?: string }) {
        machineState = result.type === "complete" ? "complete" : (result.next ?? machineState);
        return { machine: { state: machineState } } as never;
      },
    };
    const gatewayPhase: OnboardSequencePhase<Record<string, unknown>> = {
      state: "gateway",
      run: async (context) => {
        // Simulate a silent gateway wait that outlives one heartbeat interval.
        harness.clockMs = 30_000;
        harness.timerCallback?.();
        harness.clockMs = 31_000;
        return { context, result: { type: "complete", metadata: { state: "gateway" } } as never };
      },
    };

    await runOnboardSequenceWithRunner({
      context: {},
      runtime,
      phases: [gatewayPhase],
      phaseProgress: reporter,
    });

    expect(harness.lines.some((line) => line.includes("⏳ Still working on Gateway startup"))).toBe(
      true,
    );
    expect(harness.records[0]).toMatchObject({ phase: "gateway", status: "completed" });
  });
});
