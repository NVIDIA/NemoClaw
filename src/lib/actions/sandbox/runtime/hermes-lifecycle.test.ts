// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionAgent: vi.fn(),
  waitForRecoveredSandboxGateway: vi.fn(),
}));

vi.mock("../../../agent/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../agent/runtime")>()),
  getSessionAgent: mocks.getSessionAgent,
}));

vi.mock("../process-recovery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process-recovery")>()),
  waitForRecoveredSandboxGateway: mocks.waitForRecoveredSandboxGateway,
}));

import { waitForGatedHermesGatewayRecovery } from "./hermes-lifecycle";

describe("gated Hermes gateway recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionAgent.mockReturnValue({
      name: "hermes",
      healthProbe: { timeout_seconds: 90 },
    });
    mocks.waitForRecoveredSandboxGateway.mockResolvedValue(true);
  });

  it("uses the bounded sandbox HTTP health wait while the supervisor relaunches", async () => {
    await expect(waitForGatedHermesGatewayRecovery("alpha")).resolves.toBe(true);

    expect(mocks.waitForRecoveredSandboxGateway).toHaveBeenCalledWith("alpha", {
      quiet: true,
      timeoutSeconds: 90,
      managedProbeImpl: expect.any(Function),
    });

    const options = mocks.waitForRecoveredSandboxGateway.mock.calls[0]?.[1];
    expect(options?.managedProbeImpl?.("alpha")).toBeNull();
  });

  it("propagates a bounded recovery failure", async () => {
    mocks.waitForRecoveredSandboxGateway.mockResolvedValue(false);

    await expect(waitForGatedHermesGatewayRecovery("alpha")).resolves.toBe(false);
  });

  it("fails closed without a valid Hermes health budget", async () => {
    mocks.getSessionAgent.mockReturnValue({ name: "hermes", healthProbe: {} });

    await expect(waitForGatedHermesGatewayRecovery("alpha")).resolves.toBe(false);
    expect(mocks.waitForRecoveredSandboxGateway).not.toHaveBeenCalled();
  });
});
