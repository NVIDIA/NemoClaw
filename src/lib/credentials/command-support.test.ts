// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { OpenShellGatewayObservation } from "../adapters/openshell/gateway-observer";

const mocks = vi.hoisted(() => ({
  recoverNamedGatewayRuntime: vi.fn(),
}));

vi.mock("../actions/global", () => ({
  recoverNamedGatewayRuntime: mocks.recoverNamedGatewayRuntime,
}));

import { recoverGatewayOrExit } from "./command-support";

function failedObservation(
  error: NonNullable<OpenShellGatewayObservation["error"]>,
  unavailable: boolean,
): OpenShellGatewayObservation {
  return {
    state: "observation_failed",
    activeGateway: null,
    recoveryBlocked: true,
    unavailable,
    diagnostic: "credential-shaped-canary",
    error,
  };
}

describe("credential gateway recovery diagnostics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("distinguishes an unproven gateway identity without exposing probe output (#11414)", async () => {
    const canary = "credential-shaped-canary";
    const identityMismatch = failedObservation(
      {
        kind: "transport",
        reason: "identity_mismatch",
        message: canary,
      },
      true,
    );
    mocks.recoverNamedGatewayRuntime.mockResolvedValue({
      recovered: false,
      attempted: false,
      before: identityMismatch,
      after: identityMismatch,
    });
    const reportFailure = vi.fn();

    await expect(recoverGatewayOrExit("reach", reportFailure)).resolves.toBe(false);

    const lines = reportFailure.mock.calls[0][0] as readonly string[];
    expect(lines.join("\n")).toContain("did not prove the expected gateway identity");
    expect(lines.join("\n")).not.toContain("Is it running?");
    expect(lines.join("\n")).not.toContain(canary);
  });

  it("directs endpoint override recovery without exposing the endpoint", async () => {
    const endpointOverride = failedObservation(
      {
        kind: "transport",
        reason: "endpoint_override",
        message: "http://credential-shaped-canary.invalid",
      },
      true,
    );
    mocks.recoverNamedGatewayRuntime.mockResolvedValue({
      recovered: false,
      attempted: false,
      before: endpointOverride,
      after: endpointOverride,
    });
    const reportFailure = vi.fn();

    await expect(recoverGatewayOrExit("reach", reportFailure)).resolves.toBe(false);

    const lines = reportFailure.mock.calls[0][0] as readonly string[];
    expect(lines.join("\n")).toContain("OPENSHELL_GATEWAY_ENDPOINT");
    expect(lines.join("\n")).toContain("Unset OPENSHELL_GATEWAY_ENDPOINT");
    expect(lines.join("\n")).not.toContain("correct OPENSHELL_GATEWAY_ENDPOINT");
    expect(lines.join("\n")).not.toContain("credential-shaped-canary");
  });

  it("retains start guidance when the named gateway is unreachable", async () => {
    const unreachable = failedObservation(
      {
        kind: "transport",
        reason: "unreachable",
        message: "The selected gateway is unreachable.",
      },
      true,
    );
    mocks.recoverNamedGatewayRuntime.mockResolvedValue({
      recovered: false,
      attempted: true,
      before: unreachable,
      after: unreachable,
    });
    const reportFailure = vi.fn();

    await expect(recoverGatewayOrExit("reach", reportFailure)).resolves.toBe(false);

    const lines = reportFailure.mock.calls[0][0] as readonly string[];
    expect(lines.join("\n")).toContain("Is it running?");
    expect(lines.join("\n")).not.toContain("did not prove the expected gateway identity");
  });

  it("uses identity guidance for a query without exposing recovery evidence", async () => {
    const canary = "query-recovery-canary";
    const identityMismatch = failedObservation(
      {
        kind: "transport",
        reason: "identity_mismatch",
        message: canary,
      },
      true,
    );
    mocks.recoverNamedGatewayRuntime.mockResolvedValue({
      recovered: false,
      attempted: false,
      before: identityMismatch,
      after: identityMismatch,
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
    const unreachable = failedObservation(
      {
        kind: "transport",
        reason: "unreachable",
        message: "The selected gateway is unreachable.",
      },
      true,
    );
    mocks.recoverNamedGatewayRuntime.mockResolvedValue({
      recovered: false,
      attempted: true,
      before: unreachable,
      after: unreachable,
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
    const timeout = failedObservation({ kind: "timeout", message: canary }, true);
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

  it.each([
    ["authentication", { kind: "authentication" as const, message: "unauthorized" }],
    ["schema", { kind: "schema" as const, message: "invalid wire type" }],
  ])("uses recovery guidance for a blocked %s observation", async (_label, error) => {
    const observation = failedObservation(error, false);
    mocks.recoverNamedGatewayRuntime.mockResolvedValue({
      recovered: false,
      attempted: false,
      before: observation,
      after: observation,
    });
    const reportFailure = vi.fn();

    await expect(recoverGatewayOrExit("reach", reportFailure)).resolves.toBe(false);

    const lines = reportFailure.mock.calls[0][0] as readonly string[];
    expect(lines.join("\n")).toContain("Is it running?");
    expect(lines.join("\n")).not.toContain("did not prove the expected gateway identity");
    expect(lines.join("\n")).not.toContain(error.message);
  });
});
