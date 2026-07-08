// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { hermesAgent } from "../../agent/hermes-recovery-boundary-fixtures";
import type { GatewayRestartDeps } from "./gateway-restart";
import { restartSandboxGateway } from "./process-recovery";

afterEach(() => {
  vi.restoreAllMocks();
});

function silenceConsole() {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  return () => {
    log.mockRestore();
    error.mockRestore();
  };
}

function baseDeps(overrides: Partial<GatewayRestartDeps> = {}): GatewayRestartDeps {
  return {
    getSessionAgent: () => hermesAgent,
    getSandbox: () => ({ name: "alpha", agent: "hermes" }),
    resolveSandboxDashboardPort: () => 18789,
    requestGatewaySupervisorAction: vi.fn(() => ({
      status: 0,
      stdout: "GATEWAY_PID=123",
      stderr: "",
    })),
    executeSandboxExecCommand: vi.fn(() => null),
    waitForRecoveredSandboxGateway: vi.fn(() => true),
    ensureSandboxPortForward: vi.fn(() => true),
    ensureHermesDashboardPortForwardIfEnabled: vi.fn(() => null),
    recoverMessagingHostForward: vi.fn(() => null),
    recoverDeclaredAgentForwardPorts: vi.fn(() => null),
    printGatewayWedgeDiagnostics: vi.fn(() => false),
    inspectHermesMcpReconciliationRefusal: vi.fn(() => null),
    ...overrides,
  };
}

describe("Hermes MCP gateway restart", () => {
  it("refuses to report a restarted gateway with stale MCP intent", () => {
    const restore = silenceConsole();
    try {
      const deps = baseDeps({
        inspectHermesMcpReconciliationRefusal: vi.fn(() => ({
          detail: "Hermes MCP config does not match persisted managed intent",
        })),
      });

      expect(restartSandboxGateway("alpha", { quiet: true, deps })).toEqual({
        ok: false,
        failureLayer: "MCP reconciliation refusal",
        detail: "Hermes MCP config does not match persisted managed intent",
      });
      expect(deps.ensureSandboxPortForward).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("returns only sanitized MCP reconciliation detail", () => {
    const restore = silenceConsole();
    try {
      const deps = baseDeps({
        inspectHermesMcpReconciliationRefusal: vi.fn(() => ({
          detail: "integrity pending FORGED SUCCESS <REDACTED>",
        })),
      });

      expect(restartSandboxGateway("alpha", { quiet: true, deps })).toEqual({
        ok: false,
        failureLayer: "MCP reconciliation refusal",
        detail: "integrity pending FORGED SUCCESS <REDACTED>",
      });
      expect(deps.ensureSandboxPortForward).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("prints MCP recovery guidance for a supervisor-side integrity refusal", () => {
    const restore = silenceConsole();
    try {
      const deps = baseDeps({
        requestGatewaySupervisorAction: vi.fn(() => ({
          status: 1,
          stdout: "",
          stderr:
            "v1 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa failed mcp-integrity 4242 0\nHERMES_MCP_CONFIG_DRIFT",
        })),
      });

      expect(restartSandboxGateway("alpha", { quiet: true, deps })).toMatchObject({
        ok: false,
        failureLayer: "MCP reconciliation refusal",
      });
      expect(deps.waitForRecoveredSandboxGateway).not.toHaveBeenCalled();
      const output = vi.mocked(console.error).mock.calls.flat().join("\n");
      expect(output).toContain("nemoclaw alpha mcp restart");
      expect(output).toContain("nemoclaw alpha rebuild --yes");
    } finally {
      restore();
    }
  });
});
