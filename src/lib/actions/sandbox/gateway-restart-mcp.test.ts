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
    executeSandboxExecCommand: vi.fn(async () => null),
    waitForRecoveredSandboxGateway: vi.fn(async () => true),
    ensureSandboxPortForward: vi.fn(() => true),
    ensureHermesDashboardPortForwardIfEnabled: vi.fn(() => null),
    recoverMessagingHostForward: vi.fn(() => null),
    recoverDeclaredAgentForwardPorts: vi.fn(() => null),
    printGatewayWedgeDiagnostics: vi.fn(async () => false),
    ...overrides,
  };
}

describe("Hermes MCP gateway restart", () => {
  it("completes generic restart without host MCP reconciliation (#11108)", async () => {
    const restore = silenceConsole();
    try {
      const deps = baseDeps();

      expect(await restartSandboxGateway("alpha", { quiet: true, deps })).toEqual({
        restarted: true,
        ok: true,
        healthPassed: true,
        forwardRecovered: true,
      });
      expect(deps.ensureSandboxPortForward).toHaveBeenCalledWith("alpha");
    } finally {
      restore();
    }
  });

  it("prints MCP recovery guidance for a supervisor-side integrity refusal", async () => {
    const restore = silenceConsole();
    try {
      const deps = baseDeps({
        requestGatewaySupervisorAction: vi.fn(() => ({
          status: 1,
          stdout: "",
          stderr:
            "v1 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa failed mcp-integrity 4242 0\n\u001b[31mHERMES_MCP_CONFIG_DRIFT\u001b[0m\nGITHUB_TOKEN=secret",
        })),
      });

      const result = await restartSandboxGateway("alpha", { quiet: true, deps });
      expect(result).toMatchObject({
        ok: false,
        failureLayer: "MCP reconciliation refusal",
        detail: expect.stringContaining("GITHUB_TOKEN=<REDACTED>"),
      });
      expect(result).not.toHaveProperty("restarted");
      expect(result).not.toHaveProperty("healthPassed");
      expect(result.ok).toBe(false);
      expect((result as Extract<typeof result, { ok: false }>).detail).not.toMatch(
        /\x1b|GITHUB_TOKEN=secret/u,
      );
      expect(deps.waitForRecoveredSandboxGateway).not.toHaveBeenCalled();
      expect(deps.ensureSandboxPortForward).not.toHaveBeenCalled();
      const output = vi.mocked(console.error).mock.calls.flat().join("\n");
      expect(output).toContain("nemoclaw alpha mcp restart");
      expect(output).toContain("nemoclaw alpha rebuild --yes");
      expect(output).toContain("GITHUB_TOKEN=<REDACTED>");
      expect(output).not.toMatch(/\x1b|GITHUB_TOKEN=secret/u);
    } finally {
      restore();
    }
  });
});
