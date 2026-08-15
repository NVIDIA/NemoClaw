// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createInitialFlowPhases: vi.fn(),
  destroyGatewayForReuse: vi.fn(),
  verifyGatewayContainerRunning: vi.fn(),
}));

vi.mock("../gateway-cleanup", () => ({
  destroyGatewayForReuse: mocks.destroyGatewayForReuse,
}));

vi.mock("../gateway-container-running", () => ({
  verifyGatewayContainerRunning: mocks.verifyGatewayContainerRunning,
}));

vi.mock("./initial-flow-phases", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./initial-flow-phases")>()),
  createInitialOnboardFlowPhases: mocks.createInitialFlowPhases,
}));

import { createInitialOnboardFlowPhases } from "./initial-flow-composition";

describe("createInitialOnboardFlowPhases", () => {
  beforeEach(() => {
    mocks.createInitialFlowPhases.mockReturnValue([{ state: "preflight" }, { state: "gateway" }]);
  });

  it("adds gateway verification and cleanup dependencies when it creates the initial phases (#7695)", () => {
    const existingGatewayDependency = vi.fn();
    const options = {
      gatewayDeps: { existingGatewayDependency },
    } as never;

    const phases = createInitialOnboardFlowPhases(options);

    expect(mocks.createInitialFlowPhases).toHaveBeenCalledWith({
      gatewayDeps: {
        existingGatewayDependency,
        destroyGatewayForReuse: mocks.destroyGatewayForReuse,
        verifyGatewayContainerRunning: mocks.verifyGatewayContainerRunning,
      },
    });
    expect(phases).toEqual([{ state: "preflight" }, { state: "gateway" }]);
  });
});
