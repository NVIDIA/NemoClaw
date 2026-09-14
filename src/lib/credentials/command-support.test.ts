// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  recoverNamedGatewayRuntime: vi.fn(),
}));

vi.mock("../actions/global", () => ({
  recoverNamedGatewayRuntime: mocks.recoverNamedGatewayRuntime,
}));

import { recoverGatewayOrExit } from "./command-support";

describe("credential gateway recovery diagnostics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("distinguishes an unproven gateway identity without exposing probe output (#11414)", async () => {
    const canary = "credential-shaped-canary";
    mocks.recoverNamedGatewayRuntime.mockResolvedValue({
      recovered: false,
      attempted: false,
      before: { recoveryBlocked: true, status: canary },
      after: { recoveryBlocked: true, gatewayInfo: canary },
    });
    const reportFailure = vi.fn();

    await expect(recoverGatewayOrExit("reach", reportFailure)).resolves.toBe(false);

    const lines = reportFailure.mock.calls[0][0] as readonly string[];
    expect(lines.join("\n")).toContain("did not prove the expected gateway identity");
    expect(lines.join("\n")).not.toContain("Is it running?");
    expect(lines.join("\n")).not.toContain(canary);
  });

  it("retains start guidance when the named gateway is unreachable", async () => {
    mocks.recoverNamedGatewayRuntime.mockResolvedValue({
      recovered: false,
      attempted: true,
      before: { recoveryBlocked: false },
      after: { recoveryBlocked: false },
    });
    const reportFailure = vi.fn();

    await expect(recoverGatewayOrExit("reach", reportFailure)).resolves.toBe(false);

    const lines = reportFailure.mock.calls[0][0] as readonly string[];
    expect(lines.join("\n")).toContain("Is it running?");
    expect(lines.join("\n")).not.toContain("did not prove the expected gateway identity");
  });

  it("uses identity guidance for a query without exposing recovery evidence", async () => {
    const canary = "query-recovery-canary";
    mocks.recoverNamedGatewayRuntime.mockResolvedValue({
      recovered: false,
      attempted: false,
      before: { recoveryBlocked: true, status: canary },
      after: { recoveryBlocked: true, gatewayInfo: canary },
    });
    const reportFailure = vi.fn();

    await expect(recoverGatewayOrExit("query", reportFailure)).resolves.toBe(false);

    const lines = reportFailure.mock.calls[0][0] as readonly string[];
    expect(lines.join("\n")).toContain("Could not query");
    expect(lines.join("\n")).toContain("did not prove the expected gateway identity");
    expect(lines.join("\n")).not.toContain("Is it running?");
    expect(lines.join("\n")).not.toContain(canary);
  });

  it("retains query-specific start guidance when the gateway is unreachable", async () => {
    mocks.recoverNamedGatewayRuntime.mockResolvedValue({
      recovered: false,
      attempted: true,
      before: { recoveryBlocked: false },
      after: { recoveryBlocked: false },
    });
    const reportFailure = vi.fn();

    await expect(recoverGatewayOrExit("query", reportFailure)).resolves.toBe(false);

    const lines = reportFailure.mock.calls[0][0] as readonly string[];
    expect(lines.join("\n")).toContain("Could not query");
    expect(lines.join("\n")).toContain("Is it running?");
    expect(lines.join("\n")).not.toContain("did not prove the expected gateway identity");
  });

  it("uses recovery guidance when the gateway observation times out", async () => {
    const canary = "timeout-diagnostic-canary";
    const timeout = {
      state: "observation_failed",
      recoveryBlocked: true,
      unavailable: true,
      diagnostic: canary,
      error: { kind: "timeout" },
    };
    mocks.recoverNamedGatewayRuntime.mockResolvedValue({
      recovered: false,
      attempted: false,
      before: timeout,
      after: timeout,
    });
    const reportFailure = vi.fn();

    await expect(recoverGatewayOrExit("reach", reportFailure)).resolves.toBe(false);

    const lines = reportFailure.mock.calls[0][0] as readonly string[];
    expect(lines.join("\n")).toContain("Is it running?");
    expect(lines.join("\n")).not.toContain("did not prove the expected gateway identity");
    expect(lines.join("\n")).not.toContain(canary);
  });
});
