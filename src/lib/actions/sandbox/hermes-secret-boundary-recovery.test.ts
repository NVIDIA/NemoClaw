// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../state/registry", () => ({
  getSandbox: vi.fn(),
}));

import type { AgentDefinition } from "../../agent/defs";
import * as registry from "../../state/registry";
import { enforceHermesSecretBoundaryOnRunningGateway } from "./hermes-secret-boundary-recovery";

const SANDBOX = "hermes-box";
const HERMES_AGENT = { name: "hermes" } as AgentDefinition;

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

function mockSandboxAgent(agent: string): void {
  vi.mocked(registry.getSandbox).mockReturnValue({
    name: SANDBOX,
    agent,
  } as ReturnType<typeof registry.getSandbox>);
}

function makeExecResult(stdout: string, stderr = "", status = 0) {
  return { status, stdout, stderr };
}

beforeEach(() => {
  vi.mocked(registry.getSandbox).mockReset();
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
});

describe("enforceHermesSecretBoundaryOnRunningGateway", () => {
  it("does nothing for non-Hermes sandboxes", () => {
    mockSandboxAgent("openclaw");
    const exec = vi.fn();

    const result = enforceHermesSecretBoundaryOnRunningGateway(SANDBOX, HERMES_AGENT, exec);

    expect(result).toBeNull();
    expect(exec).not.toHaveBeenCalled();
  });

  it("refuses recovery when the Hermes agent definition cannot be loaded", () => {
    mockSandboxAgent("hermes");
    const exec = vi.fn();

    const result = enforceHermesSecretBoundaryOnRunningGateway(SANDBOX, null, exec);

    expect(result).toEqual({ refused: true, reason: "agent-missing", stderr: "" });
    expect(exec).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("could not be loaded"));
  });

  it("refuses recovery when the privileged controller check cannot run", () => {
    mockSandboxAgent("hermes");
    const exec = vi.fn(() => null);

    const result = enforceHermesSecretBoundaryOnRunningGateway(SANDBOX, HERMES_AGENT, exec);

    expect(result).toEqual({ refused: true, reason: "exec-failed", stderr: "" });
    expect(exec).toHaveBeenCalledWith(SANDBOX, "recover");
  });

  it("refuses recovery when the validator reports raw secret-shaped values", () => {
    mockSandboxAgent("hermes");
    const exec = vi.fn(() =>
      makeExecResult("SECRET_BOUNDARY_REFUSED\n", "[SECURITY] raw key\n", 1),
    );

    const result = enforceHermesSecretBoundaryOnRunningGateway(SANDBOX, HERMES_AGENT, exec);

    expect(result).toEqual({
      refused: true,
      reason: "raw-secret",
      stderr: "[SECURITY] raw key\n",
    });
    expect(exec).toHaveBeenCalledWith(SANDBOX, "recover");
    expect(consoleErrorSpy).toHaveBeenCalledWith("  [SECURITY] raw key");
  });

  it("allows recovery when the validator accepts the env file", () => {
    mockSandboxAgent("hermes");
    const exec = vi.fn(() => makeExecResult("GATEWAY_PID=4242\n"));

    const result = enforceHermesSecretBoundaryOnRunningGateway(SANDBOX, HERMES_AGENT, exec);

    expect(result).toEqual({ refused: false });
  });

  it("rejects a legacy-script ALREADY_RUNNING marker on the supervisor protocol", () => {
    mockSandboxAgent("hermes");
    const exec = vi.fn(() => makeExecResult("ALREADY_RUNNING\n"));

    const result = enforceHermesSecretBoundaryOnRunningGateway(SANDBOX, HERMES_AGENT, exec);

    expect(result).toEqual({
      refused: true,
      reason: "unexpected-marker",
      stderr: "",
    });
    expect(exec).toHaveBeenCalledWith(SANDBOX, "recover");
  });

  it("refuses recovery when an older sandbox image lacks the validator", () => {
    mockSandboxAgent("hermes");
    const exec = vi.fn(() => makeExecResult("SECRET_BOUNDARY_VALIDATOR_MISSING\n", "missing\n", 1));

    const result = enforceHermesSecretBoundaryOnRunningGateway(SANDBOX, HERMES_AGENT, exec);

    expect(result).toEqual({ refused: true, reason: "validator-missing", stderr: "missing\n" });
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("validator missing"));
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Re-image the sandbox"));
  });

  it("distinguishes unrecognized validator output from infrastructure failures", () => {
    mockSandboxAgent("hermes");
    const exec = vi.fn(() => makeExecResult("unexpected output\n", "validator failed\n", 1));

    const result = enforceHermesSecretBoundaryOnRunningGateway(SANDBOX, HERMES_AGENT, exec);

    expect(result).toEqual({
      refused: true,
      reason: "unexpected-marker",
      stderr: "validator failed\n",
    });
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("did not complete cleanly"),
    );
  });
});
