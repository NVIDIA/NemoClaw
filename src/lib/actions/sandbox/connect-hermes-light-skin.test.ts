// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readSandboxConfig: vi.fn(),
  resolveAgentConfig: vi.fn(),
  runOpenshell: vi.fn(),
  writeSandboxConfig: vi.fn(),
}));

vi.mock("../../adapters/openshell/runtime", () => ({ runOpenshell: mocks.runOpenshell }));
vi.mock("../../sandbox/config", () => ({
  readSandboxConfig: mocks.readSandboxConfig,
  resolveAgentConfig: mocks.resolveAgentConfig,
  writeSandboxConfig: mocks.writeSandboxConfig,
}));

import { prepareHermesLightTerminalSkin } from "./connect-hermes-light-skin";

describe("prepareHermesLightTerminalSkin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveAgentConfig.mockReturnValue({ agentName: "hermes" });
    mocks.readSandboxConfig.mockReturnValue({ display: { skin: "nemoclaw-light" } });
    mocks.runOpenshell.mockReturnValue({ status: 0 } as never);
  });

  it("pins the cleanup exec to the persisted sandbox gateway", () => {
    prepareHermesLightTerminalSkin("alpha", { name: "hermes" }, process.env, "nemoclaw-8091");

    expect(mocks.runOpenshell).toHaveBeenCalledWith(
      ["sandbox", "exec", "--name", "alpha", "-g", "nemoclaw-8091", "--", "sh", "-s"],
      expect.objectContaining({
        input: expect.stringContaining('rm -f "$skin_dir/nemoclaw-light.yaml"'),
      }),
    );
  });

  it("keeps selected-gateway behavior when no persisted gateway is available", () => {
    prepareHermesLightTerminalSkin("alpha", { name: "hermes" }, process.env);

    expect(mocks.runOpenshell).toHaveBeenCalledWith(
      ["sandbox", "exec", "--name", "alpha", "--", "sh", "-s"],
      expect.objectContaining({
        input: expect.stringContaining('rm -f "$skin_dir/nemoclaw-light.yaml"'),
      }),
    );
  });
});
