// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listAgents: vi.fn(() => ["openclaw"]),
  onboard: vi.fn().mockResolvedValue(undefined),
  runOnboardCommand: vi.fn(),
  reconcileRetainedOnboard: vi.fn(),
}));

vi.mock("../agent/defs", () => ({ listAgents: mocks.listAgents }));
vi.mock("../onboard", () => ({
  onboard: mocks.onboard,
  retainedOnboardRecoveryHost: {},
}));
vi.mock("./onboard/retained-recovery", () => ({
  createRetainedOnboardRecovery: () => mocks.reconcileRetainedOnboard,
}));
vi.mock("../onboard/command", () => ({ runOnboardCommand: mocks.runOnboardCommand }));

import { runOnboardAction } from "./onboard";

describe("onboard action runtime composition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reconcileRetainedOnboard.mockResolvedValue(null);
    mocks.runOnboardCommand.mockImplementation(
      async (deps: { runOnboard(options: unknown): Promise<void> }) => {
        await deps.runOnboard({ nonInteractive: true, resume: false });
      },
    );
  });

  it("passes host-only Google Chat dependencies into legacy onboarding", async () => {
    const googlechatTunnelRuntime = {
      loadServices: vi.fn(),
      loadWebhookProxy: vi.fn(),
    };

    await runOnboardAction({ "non-interactive": true }, { googlechatTunnelRuntime });

    expect(mocks.onboard).toHaveBeenCalledWith({
      nonInteractive: true,
      resume: false,
      googlechatTunnelRuntime,
    });
  });

  it("restarts the default name fresh only after retained recovery completes (#11510)", async () => {
    mocks.reconcileRetainedOnboard.mockResolvedValue("my-assistant");

    await runOnboardAction({ "non-interactive": true });

    expect(mocks.onboard).toHaveBeenCalledExactlyOnceWith({
      nonInteractive: true,
      resume: false,
      fresh: true,
      sandboxName: "my-assistant",
      googlechatTunnelRuntime: undefined,
    });
    expect(mocks.reconcileRetainedOnboard).toHaveBeenCalledBefore(mocks.onboard);
  });

  it("does not enter onboarding when recovery fails", async () => {
    mocks.reconcileRetainedOnboard.mockRejectedValue(new Error("Recovery preserved"));

    await expect(runOnboardAction({ "non-interactive": true })).rejects.toThrow(
      "Recovery preserved",
    );

    expect(mocks.onboard).not.toHaveBeenCalled();
  });
});
