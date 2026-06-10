// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  context,
  createPhases,
  createRuntimeHarness,
  sessionAt,
} from "../../../../test/helpers/onboard-final-flow-phases";
import { createSession } from "../../state/onboard-session";
import { runFinalOnboardFlowSlice } from "./final-flow-phases";

describe("final onboard flow runtime boundary", () => {
  it("uses the strict final runner for fresh OpenClaw sessions with a real runtime boundary", async () => {
    const order: string[] = [];
    const harness = createRuntimeHarness(sessionAt("openclaw"));
    const recorders = harness.boundary.recorders();
    const phases = createPhases("openclaw", order, {
      loadSession: harness.getSession,
      recordStepSkipped: recorders.recordStepSkipped,
      recordStateSkipped: recorders.recordStateSkipped,
      startRecordedStep: recorders.startRecordedStep,
      recordStepComplete: recorders.recordStepComplete,
      recordPostVerifyStarted: recorders.recordPostVerifyStarted,
    });
    const compatibilityRecorder = vi.fn(recorders.recordStateResultWithStepCompatibility);

    await runFinalOnboardFlowSlice({
      context: context({ session: harness.getSession() }),
      runtime: harness.boundary.getRuntime(),
      phases,
      resume: false,
      recordStateResult: compatibilityRecorder,
      afterPoliciesResultApplied: () => {
        order.push("disarm");
      },
    });

    expect(compatibilityRecorder).not.toHaveBeenCalled();
    expect(order).toEqual(["openclaw", "policies", "disarm", "set-default", "verify"]);
    expect(harness.getSession()).toMatchObject({
      status: "complete",
      sandboxName: "my-sandbox",
      provider: "nim",
      model: "nvidia/test",
      machine: { state: "complete" },
    });
  });

  it.each([
    "policies",
    "finalizing",
    "post_verify",
  ] as const)("keeps persisted %s sessions on the compatibility path with the real runtime boundary", async (initialState) => {
    const order: string[] = [];
    const harness = createRuntimeHarness(sessionAt(initialState));
    const recorders = harness.boundary.recorders();
    const phases = createPhases("openclaw", order, {
      loadSession: harness.getSession,
      recordStepSkipped: recorders.recordStepSkipped,
      recordStateSkipped: recorders.recordStateSkipped,
      startRecordedStep: recorders.startRecordedStep,
      recordStepComplete: recorders.recordStepComplete,
      recordPostVerifyStarted: recorders.recordPostVerifyStarted,
    });
    const compatibilityRecorder = vi.fn(recorders.recordStateResultWithStepCompatibility);

    await runFinalOnboardFlowSlice({
      context: context({ session: harness.getSession() }),
      runtime: harness.boundary.getRuntime(),
      phases,
      resume: false,
      recordStateResult: compatibilityRecorder,
      afterPoliciesResultApplied: () => {
        order.push("disarm");
      },
    });

    expect(compatibilityRecorder).toHaveBeenCalled();
    expect(order).toEqual(["openclaw", "policies", "disarm", "set-default", "verify"]);
    expect(harness.getSession()).toMatchObject({
      status: "complete",
      sandboxName: "my-sandbox",
      provider: "nim",
      model: "nvidia/test",
      machine: { state: "complete" },
    });

    const skippedTargets = harness.events
      .filter((event) => event.type === "state.result.skipped")
      .map((event) => event.metadata.targetState);
    expect(skippedTargets).toContain("policies");
    if (initialState !== "policies") {
      expect(skippedTargets).toContain("finalizing");
    }
  });

  it("uses the strict final runner for fresh agent sessions with a real runtime boundary", async () => {
    const order: string[] = [];
    const harness = createRuntimeHarness(sessionAt("agent_setup"));
    const recorders = harness.boundary.recorders();
    const phases = createPhases("agent_setup", order, {
      loadSession: harness.getSession,
      recordStepSkipped: recorders.recordStepSkipped,
      recordStateSkipped: recorders.recordStateSkipped,
      startRecordedStep: recorders.startRecordedStep,
      recordStepComplete: recorders.recordStepComplete,
      recordPostVerifyStarted: recorders.recordPostVerifyStarted,
    });
    const compatibilityRecorder = vi.fn(recorders.recordStateResultWithStepCompatibility);

    await runFinalOnboardFlowSlice({
      context: context({ agent: { name: "hermes" }, session: harness.getSession() }),
      runtime: harness.boundary.getRuntime(),
      phases,
      resume: false,
      recordStateResult: compatibilityRecorder,
      afterPoliciesResultApplied: () => {
        order.push("disarm");
      },
    });

    expect(compatibilityRecorder).not.toHaveBeenCalled();
    expect(order).toEqual([
      "agent-setup",
      "agent-forward",
      "policies",
      "disarm",
      "set-default",
      "agent-forward",
      "verify",
    ]);
    expect(harness.getSession()).toMatchObject({
      status: "complete",
      sandboxName: "my-sandbox",
      provider: "nim",
      model: "nvidia/test",
      machine: { state: "complete" },
    });
  });

  it("updates the live final context before strict final verification", async () => {
    const order: string[] = [];
    let liveChannels: string[] = [];
    const harness = createRuntimeHarness(sessionAt("openclaw"));
    const recorders = harness.boundary.recorders();
    const phases = createPhases("openclaw", order, {
      loadSession: harness.getSession,
      recordStepSkipped: recorders.recordStepSkipped,
      recordStateSkipped: recorders.recordStateSkipped,
      startRecordedStep: recorders.startRecordedStep,
      recordStepComplete: recorders.recordStepComplete,
      recordPostVerifyStarted: recorders.recordPostVerifyStarted,
      mergePolicyMessagingChannels: () => ["slack", "discord"],
      verifyDeployment: vi.fn(async () => {
        order.push(`verify:${liveChannels.join(",")}`);
        return {
          healthy: true,
          verification: {
            gatewayReachable: true,
            gatewayVersion: "test",
            inferenceRouteWorking: true,
            dashboardReachable: true,
            messagingBridgesHealthy: true,
            messagingRuntimeChannelsMissing: null,
            messagingConfigChannelsMissing: null,
            accessMethod: "localhost" as const,
          },
          diagnostics: [],
        };
      }),
    });

    await runFinalOnboardFlowSlice({
      context: context({ selectedMessagingChannels: ["slack"], session: harness.getSession() }),
      runtime: harness.boundary.getRuntime(),
      phases,
      resume: false,
      recordStateResult: vi.fn(),
      afterPoliciesResultApplied: () => {
        order.push("disarm");
      },
      onContextUpdated: (updatedContext) => {
        liveChannels = updatedContext.selectedMessagingChannels;
      },
    });

    expect(order).toEqual([
      "openclaw",
      "policies",
      "disarm",
      "set-default",
      "verify:slack,discord",
    ]);
  });

  it("keeps rollback armed when recording the policies FSM result fails", async () => {
    const order: string[] = [];
    const phases = createPhases("openclaw", order);

    await expect(
      runFinalOnboardFlowSlice({
        context: context(),
        runtime: {
          session: async () => sessionAt("policies"),
          applyResult: async () => createSession(),
        },
        phases,
        resume: false,
        recordStateResult: async (result) => {
          if (result.type === "transition" && result.next === "finalizing") {
            throw new Error("recording failed");
          }
        },
        afterPoliciesResultApplied: () => {
          order.push("disarm");
        },
      }),
    ).rejects.toThrow("recording failed");

    expect(order).toEqual(["openclaw", "policies"]);
  });

  it("does not complete or print dashboard when strict final verification fails", async () => {
    const order: string[] = [];
    const harness = createRuntimeHarness(sessionAt("openclaw"));
    const recorders = harness.boundary.recorders();
    const printDashboard = vi.fn();
    const phases = createPhases("openclaw", order, {
      loadSession: harness.getSession,
      recordStepSkipped: recorders.recordStepSkipped,
      recordStateSkipped: recorders.recordStateSkipped,
      startRecordedStep: recorders.startRecordedStep,
      recordStepComplete: recorders.recordStepComplete,
      recordPostVerifyStarted: recorders.recordPostVerifyStarted,
      verifyDeployment: vi.fn(async () => {
        order.push("verify");
        throw new Error("verification failed");
      }),
      printDashboard,
    });

    await expect(
      runFinalOnboardFlowSlice({
        context: context({ session: harness.getSession() }),
        runtime: harness.boundary.getRuntime(),
        phases,
        resume: false,
        recordStateResult: vi.fn(),
        afterPoliciesResultApplied: () => {
          order.push("disarm");
        },
      }),
    ).rejects.toThrow("verification failed");

    expect(order).toEqual(["openclaw", "policies", "disarm", "set-default", "verify"]);
    expect(printDashboard).not.toHaveBeenCalled();
    expect(harness.getSession()).toMatchObject({
      status: "in_progress",
      machine: { state: "post_verify" },
    });
  });
});
