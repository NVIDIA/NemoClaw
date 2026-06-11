// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { context, createPhases } from "../../../../test/helpers/onboard-final-flow-phases";
import { createSession } from "../../state/onboard-session";
import { runFinalOnboardFlowSlice } from "./final-flow-phases";

describe("final onboard flow phases", () => {
  it("selects the requested branch setup state", () => {
    expect(createPhases("openclaw")[0].state).toBe("openclaw");
    expect(createPhases("agent_setup")[0].state).toBe("agent_setup");
  });

  it("runs policies before final verification", async () => {
    const order: string[] = [];
    const [branchPhase, policiesPhase, finalizationPhase] = createPhases("openclaw", order);

    const branchResult = await branchPhase.run(context());
    const policiesResult = await policiesPhase.run(branchResult.context);
    await finalizationPhase.run(policiesResult.context);

    expect(order).toEqual(["openclaw", "policies", "set-default", "verify"]);
  });

  it("carries merged policy messaging channels into the final flow context", async () => {
    const mergePolicyMessagingChannels = vi.fn(() => ["slack", "discord"]);
    const [, policiesPhase] = createPhases("openclaw", [], { mergePolicyMessagingChannels });

    const result = await policiesPhase.run(context({ selectedMessagingChannels: ["slack"] }));

    expect(mergePolicyMessagingChannels).toHaveBeenCalledWith(["slack"], [], null, null);
    expect(result.context.selectedMessagingChannels).toEqual(["slack", "discord"]);
  });

  it("rejects final phases when required context is missing", async () => {
    const [branchPhase, policiesPhase, finalizationPhase] = createPhases("openclaw");
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
  });

  it("records each phase result on the resume compatibility path", async () => {
    const order: string[] = [];
    const recorded: string[] = [];
    const phases = createPhases("openclaw", order);

    await runFinalOnboardFlowSlice({
      context: context({ resume: true }),
      runtime: {
        session: async () => createSession(),
        applyResult: async () => createSession(),
      },
      phases,
      resume: true,
      recordStateResult: async (result) => {
        if (result.type === "complete" || result.type === "failed") {
          recorded.push(result.type);
        } else {
          recorded.push(result.next);
        }
      },
      afterPoliciesResultApplied: () => {
        order.push("disarm");
      },
    });

    expect(order).toEqual(["openclaw", "policies", "disarm", "set-default", "verify"]);
    expect(recorded).toEqual(["policies", "finalizing", "complete"]);
  });
});
