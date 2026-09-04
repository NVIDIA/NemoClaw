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
import type { VerifyDeploymentResult } from "../../verify-deployment";
import { runFinalOnboardFlowSlice } from "./final-flow-phases";
import { UnexpectedOnboardFlowSliceStateError } from "./flow-slice-error";

function deploymentResult(healthy: boolean): VerifyDeploymentResult {
  return {
    healthy,
    verification: {
      gatewayReachable: true,
      gatewayVersion: "test",
      inferenceRouteWorking: healthy,
      dashboardReachable: true,
      agentApiReachable: null,
      messagingBridgesHealthy: true,
      messagingRuntimeChannelsMissing: null,
      messagingConfigChannelsMissing: null,
      accessMethod: "localhost",
    },
    diagnostics: [],
  };
}

describe("final onboard flow runtime boundary", () => {
  it.each([
    { label: "fresh", resume: false },
    { label: "resumed", resume: true },
  ])(
    "uses the strict final runner for $label OpenClaw sessions at the branch state",
    async ({ resume }) => {
      const order: string[] = [];
      const harness = createRuntimeHarness(sessionAt("openclaw"));
      const recorders = harness.boundary.recorders();
      const phases = createPhases("openclaw", order, {
        loadSession: harness.getSession,
        recordStepSkipped: recorders.recordStepSkipped,
        recordStateSkipped: recorders.recordStateSkipped,
        startRecordedStep: recorders.startRecordedStep,
        recordStepComplete: recorders.recordStepComplete,
      });
      await runFinalOnboardFlowSlice({
        context: context({ resume, session: harness.getSession() }),
        runtime: harness.boundary.getRuntime(),
        phases,
        recordRepairEvent: recorders.recordRepairEvent,
        afterPoliciesReady: () => {
          order.push("disarm");
        },
      });

      expect(order).toEqual([
        "openclaw",
        "agent-forward",
        "policies",
        "disarm",
        "set-default",
        "verify",
      ]);
      expect(harness.getSession()).toMatchObject({
        status: "complete",
        sandboxName: "my-sandbox",
        provider: "nim",
        model: "nvidia/test",
        machine: { state: "complete" },
      });
      expect(
        harness.events
          .filter((event) => event.type === "state.entered")
          .map((event) => event.state),
      ).toEqual(["policies", "finalizing", "post_verify", "complete"]);
      expect(
        harness.events
          .filter((event) => event.type === "state.skipped")
          .map((event) => `${event.type}:${event.state}`),
      ).toEqual(["state.skipped:agent_setup"]);
      expect(harness.events.some((event) => event.type.startsWith("state.repair."))).toBe(false);
    },
  );

  it.each([
    { initialState: "policies" as const, branchState: "openclaw" as const, resume: true },
    { initialState: "finalizing" as const, branchState: "openclaw" as const, resume: true },
    { initialState: "post_verify" as const, branchState: "openclaw" as const, resume: true },
    { initialState: "finalizing" as const, branchState: "openclaw" as const, resume: false },
    { initialState: "post_verify" as const, branchState: "agent_setup" as const, resume: true },
  ])(
    "repairs prerequisites before strict $initialState entry for $branchState",
    async ({ initialState, branchState, resume }) => {
      const order: string[] = [];
      const harness = createRuntimeHarness(sessionAt(initialState));
      const recorders = harness.boundary.recorders();
      const phases = createPhases(branchState, order, {
        loadSession: harness.getSession,
        recordStepSkipped: recorders.recordStepSkipped,
        recordStateSkipped: recorders.recordStateSkipped,
        startRecordedStep: recorders.startRecordedStep,
        recordStepComplete: recorders.recordStepComplete,
      });
      const recordRepairEvent = vi.fn(recorders.recordRepairEvent);

      await runFinalOnboardFlowSlice({
        context: context({
          agent: branchState === "agent_setup" ? { name: "hermes" } : null,
          resume,
          session: harness.getSession(),
        }),
        runtime: harness.boundary.getRuntime(),
        phases,
        recordRepairEvent,
        afterPoliciesReady: () => {
          order.push("disarm");
        },
      });

      expect(order).toEqual([
        ...(branchState === "openclaw"
          ? ["openclaw", "agent-forward"]
          : ["agent-setup", "agent-forward"]),
        "policies",
        "disarm",
        "set-default",
        "verify",
      ]);
      expect(harness.getSession()).toMatchObject({
        status: "complete",
        sandboxName: "my-sandbox",
        provider: "nim",
        model: "nvidia/test",
        machine: { state: "complete" },
      });

      const prerequisiteStates = [branchState, "policies", "finalizing"].slice(
        0,
        [branchState, "policies", "finalizing", "post_verify"].indexOf(initialState),
      );
      expect(recordRepairEvent.mock.calls).toEqual(
        prerequisiteStates.flatMap((state) => [
          [
            "state.repair.started",
            {
              state,
              metadata: { repair: "final-flow-prerequisite", entryState: initialState },
            },
          ],
          [
            "state.repair.completed",
            {
              state,
              metadata: { repair: "final-flow-prerequisite", entryState: initialState },
            },
          ],
        ]),
      );
      expect(harness.events.some((event) => event.type === "state.result.invalidated")).toBe(false);
      expect(
        harness.events.filter((event) => event.type === "state.exited").map((event) => event.state),
      ).toEqual(
        {
          finalizing: ["finalizing"],
          policies: ["policies", "finalizing"],
          post_verify: [],
        }[initialState],
      );
    },
  );

  it.each([
    { state: "sandbox" as const, branchState: "openclaw" as const },
    { state: "complete" as const, branchState: "openclaw" as const },
    { state: "failed" as const, branchState: "openclaw" as const },
    { state: "agent_setup" as const, branchState: "openclaw" as const },
    { state: "openclaw" as const, branchState: "agent_setup" as const },
  ])(
    "rejects $state before effects for a $branchState final flow",
    async ({ state, branchState }) => {
      const order: string[] = [];
      const harness = createRuntimeHarness(sessionAt(state));
      const recordRepairEvent = vi.fn(harness.boundary.recordRepairEvent.bind(harness.boundary));

      await expect(
        runFinalOnboardFlowSlice({
          context: context({ session: harness.getSession() }),
          runtime: harness.boundary.getRuntime(),
          phases: createPhases(branchState, order),
          recordRepairEvent,
        }),
      ).rejects.toBeInstanceOf(UnexpectedOnboardFlowSliceStateError);

      expect(order).toEqual([]);
      expect(recordRepairEvent).not.toHaveBeenCalled();
    },
  );

  it.each([
    { label: "fresh", resume: false },
    { label: "resumed", resume: true },
  ])(
    "uses the strict final runner for $label agent sessions at the branch state",
    async ({ resume }) => {
      const order: string[] = [];
      const harness = createRuntimeHarness(sessionAt("agent_setup"));
      const recorders = harness.boundary.recorders();
      const phases = createPhases("agent_setup", order, {
        loadSession: harness.getSession,
        recordStepSkipped: recorders.recordStepSkipped,
        recordStateSkipped: recorders.recordStateSkipped,
        startRecordedStep: recorders.startRecordedStep,
        recordStepComplete: recorders.recordStepComplete,
      });
      await runFinalOnboardFlowSlice({
        context: context({ agent: { name: "hermes" }, resume, session: harness.getSession() }),
        runtime: harness.boundary.getRuntime(),
        phases,
        recordRepairEvent: recorders.recordRepairEvent,
        afterPoliciesReady: () => {
          order.push("disarm");
        },
      });

      expect(order).toEqual([
        "agent-setup",
        "agent-forward",
        "policies",
        "disarm",
        "set-default",
        "verify",
      ]);
      expect(harness.getSession()).toMatchObject({
        status: "complete",
        sandboxName: "my-sandbox",
        provider: "nim",
        model: "nvidia/test",
        machine: { state: "complete" },
      });
      expect(
        harness.events
          .filter((event) => event.type === "state.skipped")
          .map((event) => `${event.type}:${event.state}`),
      ).toEqual(["state.skipped:openclaw"]);
      expect(harness.events.some((event) => event.type.startsWith("state.repair."))).toBe(false);
    },
  );

  it("enters post verification with the updated live final context", async () => {
    const order: string[] = [];
    let liveChannels: string[] = [];
    const harness = createRuntimeHarness(sessionAt("post_verify"));
    const recorders = harness.boundary.recorders();
    const phases = createPhases("openclaw", order, {
      loadSession: harness.getSession,
      recordStepSkipped: recorders.recordStepSkipped,
      recordStateSkipped: recorders.recordStateSkipped,
      startRecordedStep: recorders.startRecordedStep,
      recordStepComplete: recorders.recordStepComplete,
      mergePolicyMessagingChannels: () => ["slack", "discord"],
      verifyDeployment: vi.fn(async () => {
        expect(harness.getSession().machine.state).toBe("post_verify");
        order.push(`verify:${liveChannels.join(",")}`);
        return {
          healthy: true,
          verification: {
            gatewayReachable: true,
            gatewayVersion: "test",
            inferenceRouteWorking: true,
            dashboardReachable: true,
            agentApiReachable: null,
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
      context: context({
        resume: true,
        selectedMessagingChannels: ["slack"],
        session: harness.getSession(),
      }),
      runtime: harness.boundary.getRuntime(),
      phases,
      recordRepairEvent: recorders.recordRepairEvent,
      afterPoliciesReady: () => {
        order.push("disarm");
      },
      onContextUpdated: (updatedContext) => {
        liveChannels = updatedContext.selectedMessagingChannels;
      },
    });

    expect(order).toEqual([
      "openclaw",
      "agent-forward",
      "policies",
      "disarm",
      "set-default",
      "verify:slack,discord",
    ]);
  });

  it("keeps rollback armed when applying the strict policies result fails", async () => {
    const order: string[] = [];
    const phases = createPhases("openclaw", order);

    await expect(
      runFinalOnboardFlowSlice({
        context: context(),
        runtime: {
          session: async () => sessionAt("policies"),
          applyResult: async (result) => {
            if (result.type === "transition" && result.next === "finalizing") {
              throw new Error("recording failed");
            }
            return createSession();
          },
        },
        phases,
        recordRepairEvent: vi.fn(),
        afterPoliciesReady: () => {
          order.push("disarm");
        },
      }),
    ).rejects.toThrow("recording failed");

    expect(order).toEqual(["openclaw", "agent-forward", "policies"]);
  });

  it("keeps rollback armed when a policies prerequisite repair fails", async () => {
    const order: string[] = [];
    const harness = createRuntimeHarness(sessionAt("post_verify"));
    const recorders = harness.boundary.recorders();
    const phases = createPhases("openclaw", order, {
      loadSession: harness.getSession,
      recordStepSkipped: recorders.recordStepSkipped,
      recordStateSkipped: recorders.recordStateSkipped,
      startRecordedStep: recorders.startRecordedStep,
      recordStepComplete: async (stepName, updates) => {
        if (stepName === "policies") throw new Error("policy repair failed");
        return recorders.recordStepComplete(stepName, updates);
      },
    });
    const recordRepairEvent = vi.fn(recorders.recordRepairEvent);
    const afterPoliciesReady = vi.fn();

    await expect(
      runFinalOnboardFlowSlice({
        context: context({ resume: true, session: harness.getSession() }),
        runtime: harness.boundary.getRuntime(),
        phases,
        recordRepairEvent,
        afterPoliciesReady,
      }),
    ).rejects.toThrow("policy repair failed");

    expect(order).toEqual(["openclaw", "agent-forward", "policies"]);
    expect(afterPoliciesReady).not.toHaveBeenCalled();
    expect(recordRepairEvent).toHaveBeenLastCalledWith("state.repair.failed", {
      state: "policies",
      error: "policy repair failed",
      metadata: { repair: "final-flow-prerequisite", entryState: "post_verify" },
    });
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
        recordRepairEvent: recorders.recordRepairEvent,
        afterPoliciesReady: () => {
          order.push("disarm");
        },
      }),
    ).rejects.toThrow("verification failed");

    expect(order).toEqual([
      "openclaw",
      "agent-forward",
      "policies",
      "disarm",
      "set-default",
      "verify",
    ]);
    expect(printDashboard).not.toHaveBeenCalled();
    expect(harness.getSession()).toMatchObject({
      status: "in_progress",
      machine: { state: "post_verify" },
    });
  });

  it("keeps an unhealthy final verification retryable and completes after a later resume (#6849)", async () => {
    const order: string[] = [];
    const harness = createRuntimeHarness(sessionAt("openclaw"));
    const recorders = harness.boundary.recorders();
    const verifyDeployment = vi
      .fn()
      .mockResolvedValueOnce(deploymentResult(false))
      .mockResolvedValueOnce(deploymentResult(true));
    const phases = createPhases("openclaw", order, {
      loadSession: harness.getSession,
      recordStepSkipped: recorders.recordStepSkipped,
      recordStateSkipped: recorders.recordStateSkipped,
      startRecordedStep: recorders.startRecordedStep,
      recordStepComplete: recorders.recordStepComplete,
      verifyDeployment,
    });

    const first = await runFinalOnboardFlowSlice({
      context: context({ session: harness.getSession() }),
      runtime: harness.boundary.getRuntime(),
      phases,
      recordRepairEvent: recorders.recordRepairEvent,
    });

    expect(first.session).toMatchObject({
      status: "in_progress",
      resumable: true,
      machine: { state: "post_verify" },
    });

    const resumed = await runFinalOnboardFlowSlice({
      context: context({ resume: true, session: harness.getSession() }),
      runtime: harness.boundary.getRuntime(),
      phases,
      recordRepairEvent: recorders.recordRepairEvent,
    });

    expect(verifyDeployment).toHaveBeenCalledTimes(2);
    expect(resumed.session).toMatchObject({
      status: "complete",
      resumable: false,
      machine: { state: "complete" },
    });
  });
});
