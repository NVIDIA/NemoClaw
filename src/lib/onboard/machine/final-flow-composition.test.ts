// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createFinalFlowPhases: vi.fn(),
}));

vi.mock("./final-flow-phases", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./final-flow-phases")>()),
  createFinalOnboardFlowPhases: mocks.createFinalFlowPhases,
}));

import { createFinalOnboardFlowPhases, finalizationHandlerDeps } from "./final-flow-composition";

describe("createFinalOnboardFlowPhases", () => {
  beforeEach(() => {
    mocks.createFinalFlowPhases.mockReturnValue([{ state: "agent_setup" }]);
  });

  it("adds recovery and readiness dependencies when it creates the final phases (#7695)", () => {
    const existingDependency = vi.fn();
    const options = {
      branchState: "agent_setup",
      agentSetupDeps: {},
      policiesDeps: {},
      finalization: {},
      finalizationDeps: { existingDependency },
    } as never;

    const phases = createFinalOnboardFlowPhases(options);

    expect(mocks.createFinalFlowPhases).toHaveBeenCalledWith({
      branchState: "agent_setup",
      agentSetupDeps: {},
      policiesDeps: {},
      finalization: {},
      finalizationDeps: {
        existingDependency,
        ...finalizationHandlerDeps,
      },
    });
    expect(phases).toEqual([{ state: "agent_setup" }]);
  });
});
