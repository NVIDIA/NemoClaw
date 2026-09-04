// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  executeGatewaySupervisorAction: vi.fn(),
  runOpenshellProviderCommand: vi.fn(),
  sleepMs: vi.fn(),
  waitUntil: vi.fn(),
}));

vi.mock("../../../src/lib/adapters/openshell/provider-command", () => ({
  OPENSHELL_OPERATION_TIMEOUT_MS: 30_000,
  runOpenshellProviderCommand: mocks.runOpenshellProviderCommand,
}));

vi.mock("../../../src/lib/actions/sandbox/process-recovery", () => ({
  executeGatewaySupervisorAction: mocks.executeGatewaySupervisorAction,
  executeSandboxCommand: vi.fn(),
}));

vi.mock("../../../src/lib/core/wait", () => ({
  sleepMs: mocks.sleepMs,
  waitUntil: mocks.waitUntil,
}));

import { assertAgentMcpMutationRuntimeCapability } from "../../../src/lib/actions/sandbox/mcp-bridge-adapters";

type ProbeResult = { status: number; stdout: string; stderr: string };

function runHermesProbe(results: ProbeResult[]) {
  const runtimeSelection = {
    gatewayName: "nemoclaw-8091",
    workspace: "default",
  } as const;
  let calls = 0;
  const recoveryActions: Array<{ action: string; timeout: number }> = [];

  mocks.runOpenshellProviderCommand.mockImplementation((_args, options) => {
    expect(options?.runtimeSelection).toEqual({
      gatewayName: "nemoclaw-8091",
      workspace: "default",
    });
    return results[calls++];
  });
  mocks.executeGatewaySupervisorAction.mockImplementation(
    (_sandbox: string, action: string, timeout: number) => {
      recoveryActions.push({ action, timeout });
      return null;
    },
  );
  mocks.waitUntil.mockImplementation(
    (condition: () => boolean, optionsOrTimeout?: number | { maxAttempts?: number }): boolean => {
      const maxAttempts =
        typeof optionsOrTimeout === "object"
          ? (optionsOrTimeout.maxAttempts ?? Number.POSITIVE_INFINITY)
          : Number.POSITIVE_INFINITY;
      let attempts = 0;
      let ready = false;
      while (!ready && calls < results.length && attempts < maxAttempts) {
        attempts += 1;
        ready = condition();
      }
      return ready;
    },
  );
  let message = "";
  try {
    assertAgentMcpMutationRuntimeCapability("hermes-box", "hermes-config", runtimeSelection);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  return { calls, recoveryActions, message };
}

beforeEach(() => {
  vi.resetAllMocks();
});

const starting: ProbeResult = {
  status: 1,
  stdout: "",
  stderr: "Hermes gateway is not running for managed MCP reload",
};
const ready: ProbeResult = {
  status: 0,
  stdout: '{"ok":true}\n',
  stderr: "",
};
describe("Hermes managed MCP startup probe", () => {
  it("retries only the exact transient gateway-starting result", () => {
    expect(runHermesProbe([starting, ready])).toEqual({
      calls: 2,
      recoveryActions: [],
      message: "",
    });
  });

  it("does not recover when the third exact startup probe is ready", () => {
    expect(runHermesProbe([starting, starting, ready])).toEqual({
      calls: 3,
      recoveryActions: [],
      message: "",
    });
  });

  it("fails closed on the selected target without host-local supervisor recovery", () => {
    const result = runHermesProbe([starting, starting, starting, ready]);

    expect(result.calls).toBe(3);
    expect(result.recoveryActions).toEqual([]);
    expect(result.message).toContain("recorded OpenShell target 'nemoclaw-8091'");
    expect(result.message).toContain("NemoClaw did not attempt host-local supervisor recovery");
  });

  it("fails immediately on trust and topology errors", () => {
    const result = runHermesProbe([
      {
        status: 1,
        stdout: "",
        stderr: "Hermes gateway PID does not identify the trusted launcher",
      },
      ready,
    ]);

    expect(result.calls).toBe(1);
    expect(result.recoveryActions).toEqual([]);
    expect(result.message).toContain("does not identify the trusted launcher");
    expect(result.message).not.toContain("nemoclaw hermes-box recover");
  });

  it("directs an unmanaged but trusted gateway to recovery before mutation", () => {
    const result = runHermesProbe([
      {
        status: 1,
        stdout: "",
        stderr: "Hermes gateway is not running under the managed service lifecycle",
      },
      ready,
    ]);

    expect(result.calls).toBe(1);
    expect(result.recoveryActions).toEqual([]);
    expect(result.message).toContain("nemoclaw hermes-box recover");
    expect(result.message).toContain("managed service lifecycle");
  });

  it("fails clearly when the gateway never becomes ready", () => {
    const result = runHermesProbe([starting, starting, starting]);

    expect(result.calls).toBe(3);
    expect(result.recoveryActions).toEqual([]);
    expect(result.message).toContain("recorded OpenShell target 'nemoclaw-8091'");
  });
});
