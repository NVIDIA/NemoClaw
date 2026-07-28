// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession } from "../../state/onboard-session";
import { advanceTo, retryTo } from "./result";
import { runOnboardPrerequisiteRepair } from "./prerequisite-repair";

describe("runOnboardPrerequisiteRepair", () => {
  it("accepts a legal update-free chain and preserves the durable entry state", async () => {
    const session = createSession({
      machine: {
        version: 1,
        state: "sandbox",
        stateEnteredAt: "2026-07-28T00:00:00.000Z",
        revision: 4,
      },
    });
    const recordRepairEvent = vi.fn(async (_type: string) => undefined);

    const result = await runOnboardPrerequisiteRepair({
      context: { provider: "nim" },
      durableEntryState: "sandbox",
      phase: {
        state: "provider_selection",
        run: (context) => ({
          context: { ...context, model: "nvidia/test" },
          result: [
            advanceTo("inference", { metadata: { state: "provider_selection" } }),
            retryTo("provider_selection", { metadata: { state: "inference" } }),
            advanceTo("inference", { metadata: { state: "provider_selection" } }),
            advanceTo("sandbox", { metadata: { state: "inference" } }),
          ],
        }),
      },
      expectedFinalStates: ["sandbox"],
      repair: "core-flow-prerequisite",
      runtime: {
        session: async () => session,
        applyResult: async () => {
          throw new Error("repair must not apply a result");
        },
      },
      recordRepairEvent,
    });

    expect(result.context).toEqual({ provider: "nim", model: "nvidia/test" });
    expect(result.finalState).toBe("sandbox");
    expect(session.machine).toMatchObject({ state: "sandbox", revision: 4 });
    expect(recordRepairEvent.mock.calls.map(([type]) => type)).toEqual([
      "state.repair.started",
      "state.repair.completed",
    ]);
  });

  it("rejects a repair result that contains a session update", async () => {
    const session = createSession({
      machine: {
        version: 1,
        state: "gateway",
        stateEnteredAt: "2026-07-28T00:00:00.000Z",
        revision: 2,
      },
    });
    const recordRepairEvent = vi.fn(async (_type: string) => undefined);

    await expect(
      runOnboardPrerequisiteRepair({
        context: {},
        durableEntryState: "gateway",
        phase: {
          state: "preflight",
          run: (context) => ({
            context,
            result: advanceTo("gateway", {
              updates: { provider: "nim" },
              metadata: { state: "preflight" },
            }),
          }),
        },
        expectedFinalStates: ["gateway"],
        repair: "initial-flow-prerequisite",
        runtime: {
          session: async () => session,
          applyResult: async () => session,
        },
        recordRepairEvent,
      }),
    ).rejects.toThrow("expected an update-free transition");
    expect(recordRepairEvent).toHaveBeenLastCalledWith(
      "state.repair.failed",
      expect.objectContaining({ state: "preflight" }),
    );
  });
});
