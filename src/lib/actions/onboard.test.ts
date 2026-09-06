// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listAgents: vi.fn(() => ["openclaw"]),
  onboard: vi.fn().mockResolvedValue(undefined),
  runOnboardCommand: vi.fn(),
}));

vi.mock("../agent/defs", () => ({ listAgents: mocks.listAgents }));
vi.mock("../onboard", () => ({ onboard: mocks.onboard }));
vi.mock("../onboard/command", () => ({ runOnboardCommand: mocks.runOnboardCommand }));

import { getDashboardReuseLifecycle } from "../onboard/dashboard/reuse-lifecycle";
import { runOnboard, runOnboardAction } from "./onboard";

describe("onboard action runtime composition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runOnboardCommand.mockImplementation(
      async (deps: { runOnboard(options: unknown): Promise<void> }) => {
        await deps.runOnboard({ nonInteractive: true, resume: false });
      },
    );
  });

  it("passes host-only runtime dependencies into legacy onboarding", async () => {
    const googlechatTunnelRuntime = {
      loadServices: vi.fn(),
      loadWebhookProxy: vi.fn(),
    };
    const dashboardReuseLifecycle = {
      startSandbox: vi.fn(),
      stopSandbox: vi.fn(),
      withSandboxLifecycleLock: vi.fn(),
    };

    await runOnboardAction(
      { "non-interactive": true },
      { googlechatTunnelRuntime, dashboardReuseLifecycle },
    );

    expect(mocks.onboard).toHaveBeenCalledWith({
      nonInteractive: true,
      resume: false,
      googlechatTunnelRuntime,
    });
  });

  it("provides the default dashboard reuse lifecycle to direct onboarding callers", async () => {
    mocks.onboard.mockImplementationOnce(async () => {
      expect(getDashboardReuseLifecycle()).toEqual({
        startSandbox: expect.any(Function),
        stopSandbox: expect.any(Function),
        withSandboxLifecycleLock: expect.any(Function),
      });
    });

    await runOnboard({} as never);
  });
});
