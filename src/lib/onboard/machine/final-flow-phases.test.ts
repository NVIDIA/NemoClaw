// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  context,
  createPhases,
  createProviderlessComponentFlow,
} from "../../../../test/helpers/onboard-final-flow-phases";
import { createSession } from "../../state/onboard-session";
import { runFinalOnboardFlowSlice } from "./final-flow-phases";
import { advanceTo } from "./result";

describe("final onboard flow phases", () => {
  it("completes providerless onboarding only after verified component activation (#11486)", async () => {
    const flow = createProviderlessComponentFlow();
    const result = await flow.run();
    expect(result.session.machine.state).toBe("complete");
    expect(flow.transport).toHaveBeenCalledOnce();
    expect(flow.revalidate).toHaveBeenCalledTimes(2);
    expect(flow.evidence).toHaveBeenLastCalledWith(null);
    expect(flow.order).toEqual(["verify-proof", "activate"]);
    await expect(createPhases("openclaw")[3].run(flow.initial)).rejects.toThrow(
      "Providerless component activation has not completed in this onboarding run.",
    );
  });

  it("preserves failed providerless activation evidence after rejection (#11486)", async () => {
    const flow = createProviderlessComponentFlow();
    flow.response.result = "rejected";
    const result = await flow.run();
    expect(result.session.machine.state).toBe("finalizing");
    expect(result.session.externalComponentActivation).toMatchObject({
      sandboxIdentityFingerprint: flow.proof.sandboxIdentityFingerprint,
      lifecycleGeneration: flow.proof.lifecycleGeneration,
      resultClass: "failed",
    });
    expect(flow.transport).toHaveBeenCalledOnce();
    expect(flow.order).toEqual(["verify-proof", "activate"]);
  });

  it.each([
    {
      outcome: "malformed response",
      arrange: (flow: ReturnType<typeof createProviderlessComponentFlow>) =>
        flow.transport.mockResolvedValue("{}"),
      requests: 1,
      order: ["verify-proof", "activate"],
    },
    {
      outcome: "changed endpoint",
      arrange: (flow: ReturnType<typeof createProviderlessComponentFlow>) =>
        flow.revalidateEndpoint.mockImplementation(() => {
          throw new Error("changed endpoint");
        }),
      requests: 0,
      order: ["verify-proof"],
    },
    {
      outcome: "changed identity or policy proof",
      arrange: (flow: ReturnType<typeof createProviderlessComponentFlow>) =>
        flow.revalidate
          .mockImplementationOnce(() => undefined)
          .mockImplementationOnce(() => {
            throw new Error("drift");
          }),
      requests: 1,
      order: ["verify-proof", "activate"],
    },
  ])(
    "preserves ambiguous providerless activation evidence for $outcome (#11486)",
    async ({ arrange, requests, order }) => {
      const flow = createProviderlessComponentFlow();
      arrange(flow);
      const result = await flow.run();
      expect(result.session.machine.state).toBe("finalizing");
      expect(result.session.externalComponentActivation).toMatchObject({
        sandboxIdentityFingerprint: flow.proof.sandboxIdentityFingerprint,
        lifecycleGeneration: flow.proof.lifecycleGeneration,
        resultClass: "ambiguous",
      });
      expect(flow.transport).toHaveBeenCalledTimes(requests);
      expect(flow.order).toEqual(order);
    },
  );

  it("refuses providerless activation when policy proof is unavailable (#11486)", async () => {
    const flow = createProviderlessComponentFlow();
    flow.createProof.mockImplementation(() => {
      throw new Error("policy unavailable");
    });
    await expect(flow.run()).rejects.toThrow("policy unavailable");
    expect(flow.transport).not.toHaveBeenCalled();
  });

  it("selects the requested branch setup state", () => {
    expect(createPhases("openclaw")[0].state).toBe("openclaw");
    expect(createPhases("agent_setup")[0].state).toBe("agent_setup");
  });

  it("runs policies before final verification", async () => {
    const order: string[] = [];
    const [branchPhase, policiesPhase, finalizationPhase, postVerifyPhase] = createPhases(
      "openclaw",
      order,
    );

    const branchResult = await branchPhase.run(context());
    const policiesResult = await policiesPhase.run(branchResult.context);
    const finalizationResult = await finalizationPhase.run(policiesResult.context);
    await postVerifyPhase.run(finalizationResult.context);

    expect(order).toEqual(["openclaw", "agent-forward", "policies", "set-default", "verify"]);
  });

  it("carries merged policy messaging channels into the final flow context", async () => {
    const mergePolicyMessagingChannels = vi.fn(() => ["slack", "discord"]);
    const [, policiesPhase] = createPhases("openclaw", [], { mergePolicyMessagingChannels });

    const result = await policiesPhase.run(context({ selectedMessagingChannels: ["slack"] }));

    expect(mergePolicyMessagingChannels).toHaveBeenCalledWith(["slack"], [], [], []);
    expect(result.context.selectedMessagingChannels).toEqual(["slack", "discord"]);
  });

  it("rejects final phases when required context is missing", async () => {
    const [branchPhase, policiesPhase, finalizationPhase, postVerifyPhase] =
      createPhases("openclaw");
    const incomplete = context({ sandboxName: null });

    await expect(branchPhase.run(incomplete)).rejects.toThrow(
      "Onboarding state is incomplete before agent setup.",
    );
    await expect(policiesPhase.run(incomplete)).rejects.toThrow(
      "Onboarding state is incomplete before policies.",
    );
    await expect(finalizationPhase.run(incomplete)).rejects.toThrow(
      "Onboarding state is incomplete before finalization.",
    );
    await expect(postVerifyPhase.run(incomplete)).rejects.toThrow(
      "Onboarding state is incomplete before post verification.",
    );
  });

  it("rejects a prerequisite repair result with session updates without applying it", async () => {
    const phases = createPhases("openclaw");
    const applyResult = vi.fn(async () => createSession());
    const recordRepairEvent = vi.fn(async () => createSession());
    const invalidPhases = [
      {
        state: "openclaw" as const,
        run: async (flowContext: ReturnType<typeof context>) => ({
          context: flowContext,
          result: advanceTo("policies", {
            updates: { model: "unexpected/model" },
            metadata: { state: "openclaw" },
          }),
        }),
      },
      ...phases.slice(1),
    ];

    await expect(
      runFinalOnboardFlowSlice({
        context: context({ resume: true }),
        runtime: {
          session: async () =>
            createSession({
              machine: {
                version: 1,
                state: "policies",
                stateEnteredAt: "2026-06-09T00:00:00.000Z",
                revision: 1,
              },
            }),
          applyResult,
        },
        phases: invalidPhases,
        recordRepairEvent,
      }),
    ).rejects.toThrow("expected an update-free advance");

    expect(applyResult).not.toHaveBeenCalled();
    expect(recordRepairEvent).toHaveBeenCalledTimes(2);
    expect(recordRepairEvent).toHaveBeenNthCalledWith(1, "state.repair.started", expect.anything());
    expect(recordRepairEvent).toHaveBeenNthCalledWith(2, "state.repair.failed", expect.anything());
  });

  it("rejects an extra opposite branch phase before reading or running the flow", async () => {
    const order: string[] = [];
    const phases = createPhases("openclaw", order);
    const session = vi.fn(async () => createSession());

    await expect(
      runFinalOnboardFlowSlice({
        context: context(),
        runtime: { session, applyResult: vi.fn(async () => createSession()) },
        phases: [phases[0], { ...phases[0], state: "agent_setup" }, phases[1], phases[2]],
        recordRepairEvent: vi.fn(async () => createSession()),
      }),
    ).rejects.toThrow("Expected exactly one final onboarding branch phase");

    expect(session).not.toHaveBeenCalled();
    expect(order).toEqual([]);
  });

  it("rejects a missing downstream phase before reading or running the flow", async () => {
    const order: string[] = [];
    const phases = createPhases("openclaw", order);
    const session = vi.fn(async () => createSession());

    await expect(
      runFinalOnboardFlowSlice({
        context: context(),
        runtime: { session, applyResult: vi.fn(async () => createSession()) },
        phases: phases.slice(0, 3),
        recordRepairEvent: vi.fn(async () => createSession()),
      }),
    ).rejects.toThrow("Expected exactly four final onboarding phases");

    expect(session).not.toHaveBeenCalled();
    expect(order).toEqual([]);
  });
});
