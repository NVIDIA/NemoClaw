// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_RESTART_MARKERS as MARKERS } from "../../agent/gateway-restart-markers";
import * as agentRuntime from "../../agent/runtime";
import * as registry from "../../state/registry";
import { classifyGatewayRestartFailure } from "./gateway-restart";
import { restartSandboxGateway } from "./process-recovery";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("gateway restart failure markers", () => {
  it("keeps supervisor failure markers aligned with the classifier", () => {
    const expectedMarkers: Array<
      [string, ReturnType<typeof classifyGatewayRestartFailure>["layer"]]
    > = [
      ["PRIVILEGED_CONTROL_UNAVAILABLE", "privileged control unavailable"],
      ["SUPERVISOR_REBUILD_REQUIRED", "privileged control unavailable"],
      ["SUPERVISOR_BUSY", "privileged control unavailable"],
      [MARKERS.SECRET_BOUNDARY_REFUSED, "secret-boundary refusal"],
      [MARKERS.SECRET_BOUNDARY_VALIDATOR_MISSING, "unsafe config path"],
      [MARKERS.GATEWAY_UNSAFE_CONFIG_PATH, "unsafe config path"],
      ["mcp-integrity", "MCP reconciliation refusal"],
      ["mcp-reconcile-required", "MCP reconciliation refusal"],
      ["HERMES_MCP_CONFIG_DRIFT", "MCP reconciliation refusal"],
      [MARKERS.GATEWAY_CONFIG_HASH_MISMATCH, "config hash mismatch"],
      ["HERMES_UNSAFE_CONFIG_PATH", "unsafe config path"],
      ["HERMES_LOCKED_HASH_MISMATCH", "config hash mismatch"],
      ["HERMES_CONFIG_HASH_MISMATCH", "config hash mismatch"],
      ["GATEWAY_HEALTH_TIMEOUT", "health timeout"],
      [MARKERS.GATEWAY_FAILED, "launch failure"],
    ] as const;

    for (const [marker, layer] of expectedMarkers) {
      expect(
        classifyGatewayRestartFailure({
          status: 1,
          stdout: marker,
          stderr: "",
        }),
      ).toMatchObject({ layer });
    }
  });
});

describe("restartSandboxGateway — host-mediated gateway restart", () => {
  function silenceConsole() {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    return () => {
      log.mockRestore();
      error.mockRestore();
    };
  }

  function baseDeps(overrides = {}) {
    return {
      getSessionAgent: () => null,
      getSandbox: () => ({ name: "alpha", agent: "openclaw" }),
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

  it("refuses supervisor output without a completion marker", () => {
    const deps = baseDeps({
      getSandbox: () => ({ name: "openclaw-box", agent: "openclaw" }),
      requestGatewaySupervisorAction: vi.fn(() => null),
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = restartSandboxGateway("openclaw-box", { quiet: true, deps });

    expect(result).toMatchObject({
      ok: false,
      failureLayer: "privileged control unavailable",
    });
    expect(deps.requestGatewaySupervisorAction).toHaveBeenCalledWith(
      "openclaw-box",
      "restart",
      210000,
    );
    expect(errorSpy).toHaveBeenCalledWith(
      "  Failure layer: privileged control unavailable - gateway restart failed for 'openclaw-box'.",
    );
  });

  it("force-restarts through PID 1 even when a gateway might already be healthy", () => {
    const restore = silenceConsole();
    try {
      const deps = baseDeps();
      const result = restartSandboxGateway("alpha", { deps });

      expect(result).toMatchObject({ ok: true, restarted: true, healthPassed: true });
      expect(deps.requestGatewaySupervisorAction).toHaveBeenCalledWith("alpha", "restart", 210000);
      expect(deps.waitForRecoveredSandboxGateway).toHaveBeenCalledWith("alpha", {
        initialManagedHealthPassed: true,
        quiet: false,
      });
      expect(deps.ensureSandboxPortForward).toHaveBeenCalledWith("alpha");
    } finally {
      restore();
    }
  });

  it("uses the injected supervisor action for the managed settle probe", () => {
    const restore = silenceConsole();
    const previousSettleSeconds = process.env.NEMOCLAW_GATEWAY_RECOVERY_SETTLE_SECONDS;
    process.env.NEMOCLAW_GATEWAY_RECOVERY_SETTLE_SECONDS = "0.001";
    try {
      vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue(null);
      vi.spyOn(registry, "getSandbox").mockReturnValue({
        name: "alpha",
        agent: "openclaw",
        openshellDriver: "docker",
      });
      const requestGatewaySupervisorAction = vi.fn(() => ({
        status: 0,
        stdout: "GATEWAY_PID=123",
        stderr: "",
      }));
      const { waitForRecoveredSandboxGateway: _defaultWait, ...deps } = baseDeps({
        requestGatewaySupervisorAction,
      });

      const result = restartSandboxGateway("alpha", { quiet: true, deps });

      expect(result).toMatchObject({ ok: true, restarted: true, healthPassed: true });
      expect(requestGatewaySupervisorAction.mock.calls).toEqual([
        ["alpha", "restart", 210000],
        ["alpha", "probe"],
      ]);
    } finally {
      previousSettleSeconds === undefined
        ? delete process.env.NEMOCLAW_GATEWAY_RECOVERY_SETTLE_SECONDS
        : (process.env.NEMOCLAW_GATEWAY_RECOVERY_SETTLE_SECONDS = previousSettleSeconds);
      restore();
    }
  });

  it("suppresses restart success output in quiet mode", () => {
    const restore = silenceConsole();
    try {
      const deps = baseDeps();
      const result = restartSandboxGateway("alpha", { quiet: true, deps });

      expect(result).toMatchObject({ ok: true, restarted: true, healthPassed: true });
      expect(console.log).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("reports privileged supervisor unavailability", () => {
    const restore = silenceConsole();
    try {
      const deps = baseDeps({ requestGatewaySupervisorAction: vi.fn(() => null) });
      const result = restartSandboxGateway("alpha", { quiet: true, deps });

      expect(result).toMatchObject({
        ok: false,
        failureLayer: "privileged control unavailable",
      });
    } finally {
      restore();
    }
  });

  it("reports Hermes boundary refusals without hiding diagnostics in quiet mode", () => {
    const restore = silenceConsole();
    try {
      const hermesAgent = {
        name: "hermes",
        displayName: "Hermes Agent",
        healthProbe: { port: 8642 },
      };
      const deps = baseDeps({
        getSessionAgent: () => hermesAgent,
        getSandbox: () => ({ name: "alpha", agent: "hermes" }),
        requestGatewaySupervisorAction: vi.fn(() => ({
          status: 1,
          stdout: "SECRET_BOUNDARY_REFUSED",
          stderr: "[SECURITY] TELEGRAM_BOT_TOKEN (line 2)",
        })),
      });
      const result = restartSandboxGateway("alpha", { quiet: true, deps });

      expect(result).toMatchObject({
        ok: false,
        failureLayer: "secret-boundary refusal",
      });
      expect(deps.requestGatewaySupervisorAction).toHaveBeenCalledWith("alpha", "restart", 210000);
      expect(console.error).toHaveBeenCalledWith(
        "  Failure layer: secret-boundary refusal - gateway restart failed for 'alpha'.",
      );
    } finally {
      restore();
    }
  });

  it("reports launch failure markers", () => {
    const restore = silenceConsole();
    try {
      const deps = baseDeps({
        requestGatewaySupervisorAction: vi.fn(() => ({
          status: 1,
          stdout: "GATEWAY_FAILED",
          stderr: "tail output",
        })),
      });
      const result = restartSandboxGateway("alpha", { deps });

      expect(result).toMatchObject({ ok: false, failureLayer: "launch failure" });
    } finally {
      restore();
    }
  });

  it("redacts and strips restart failure detail before printing it", () => {
    const restore = silenceConsole();
    try {
      const deps = baseDeps({
        requestGatewaySupervisorAction: vi.fn(() => ({
          status: 1,
          stdout: "GATEWAY_FAILED",
          stderr: "\u001b[31mOPENAI_API_KEY=sk-review-secret\u001b[0m",
        })),
      });
      const result = restartSandboxGateway("alpha", { deps });

      expect(result).toMatchObject({ ok: false, failureLayer: "launch failure" });
      expect(result.ok).toBe(false);
      const failure = result as Extract<typeof result, { ok: false }>;
      expect(failure.detail).toContain("OPENAI_API_KEY=<REDACTED>");
      expect(failure.detail).not.toContain("\u001b");
      expect(failure.detail).not.toContain("sk-review-secret");
      const errorOutput = vi.mocked(console.error).mock.calls.join("\n");
      expect(errorOutput).toContain("Failure layer: launch failure");
      expect(errorOutput).toContain("OPENAI_API_KEY=<REDACTED>");
      expect(errorOutput).not.toContain("\u001b");
      expect(errorOutput).not.toContain("sk-review-secret");
    } finally {
      restore();
    }
  });

  it("reports a health timeout after the restart process marker", () => {
    const restore = silenceConsole();
    try {
      const deps = baseDeps({ waitForRecoveredSandboxGateway: vi.fn(() => false) });
      const result = restartSandboxGateway("alpha", { deps });

      expect(result).toMatchObject({ ok: false, failureLayer: "health timeout" });
      expect(deps.printGatewayWedgeDiagnostics).toHaveBeenCalledWith(
        "alpha",
        deps.executeSandboxExecCommand,
      );
    } finally {
      restore();
    }
  });

  it("fails when the primary dashboard/API forward cannot be restored", () => {
    const restore = silenceConsole();
    try {
      const deps = baseDeps({
        ensureSandboxPortForward: vi.fn(() => false),
        recoverMessagingHostForward: vi.fn(() => true),
        recoverDeclaredAgentForwardPorts: vi.fn(() => true),
      });
      const result = restartSandboxGateway("alpha", { deps });

      expect(result).toMatchObject({
        ok: false,
        failureLayer: "forward recovery failure",
        detail: expect.stringContaining("primary dashboard/API host forward"),
      });
      expect(deps.recoverMessagingHostForward).toHaveBeenCalledWith("alpha", { quiet: false });
      expect(deps.recoverDeclaredAgentForwardPorts).toHaveBeenCalledWith("alpha", 18789, {
        quiet: false,
      });
      const errorOutput = vi.mocked(console.error).mock.calls.join("\n");
      expect(errorOutput).toContain("Failure layer: forward recovery failure");
      expect(errorOutput).toContain("primary dashboard/API host forward");
      expect(console.log).not.toHaveBeenCalledWith(
        expect.stringContaining("Gateway restarted; health passed"),
      );
    } finally {
      restore();
    }
  });

  it("fails when an enabled auxiliary forward cannot be restored", () => {
    const restore = silenceConsole();
    try {
      const deps = baseDeps({
        ensureHermesDashboardPortForwardIfEnabled: vi.fn(() => false),
      });
      const result = restartSandboxGateway("alpha", { deps });

      expect(result).toMatchObject({
        ok: false,
        failureLayer: "forward recovery failure",
        detail: expect.stringContaining("Hermes dashboard host forward"),
      });
      expect(console.log).not.toHaveBeenCalledWith(
        expect.stringContaining("Gateway restarted; health passed"),
      );
    } finally {
      restore();
    }
  });

  it("refuses terminal agents with the unsupported-agent support matrix", () => {
    const restore = silenceConsole();
    try {
      const deps = baseDeps({
        getSessionAgent: () => ({
          name: "langchain-deepagents-code",
          displayName: "LangChain Deep Agents Code",
          runtime: { kind: "terminal" },
        }),
        getSandbox: () => ({ name: "alpha", agent: "langchain-deepagents-code" }),
      });
      const result = restartSandboxGateway("alpha", { deps });

      expect(result).toMatchObject({ ok: false, failureLayer: "unsupported agent" });
      expect(result.ok).toBe(false);
      const failure = result as Extract<typeof result, { ok: false }>;
      expect(failure.detail).toContain(
        "Agent 'langchain-deepagents-code' does not support gateway restart.",
      );
      expect(failure.detail).toContain("Gateway restart-supported agents: openclaw, hermes.");
      expect(failure.detail).toContain("LangChain Deep Agents Code has no gateway runtime.");
      const errorOutput = vi.mocked(console.error).mock.calls.join("\n");
      expect(errorOutput).toContain(
        "Agent 'langchain-deepagents-code' does not support gateway restart.",
      );
      expect(errorOutput).toContain("Gateway restart-supported agents: openclaw, hermes.");
      expect(deps.requestGatewaySupervisorAction).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("refuses custom agents when the explicit runtime definition is unavailable", () => {
    const restore = silenceConsole();
    try {
      const deps = baseDeps({
        getSessionAgent: () => null,
        getSandbox: () => ({ name: "alpha", agent: "custom-agent" }),
      });
      const result = restartSandboxGateway("alpha", { deps });

      expect(result).toMatchObject({ ok: false, failureLayer: "unsupported agent" });
      expect(result.ok).toBe(false);
      const failure = result as Extract<typeof result, { ok: false }>;
      expect(failure.detail).toContain("Agent 'custom-agent' does not support gateway restart.");
      expect(failure.detail).toContain("Gateway restart-supported agents: openclaw, hermes.");
      expect(failure.detail).toContain("custom-agent agent definition could not be loaded");
      const errorOutput = vi.mocked(console.error).mock.calls.join("\n");
      expect(errorOutput).toContain("Agent 'custom-agent' does not support gateway restart.");
      expect(errorOutput).toContain("Gateway restart-supported agents: openclaw, hermes.");
      expect(deps.requestGatewaySupervisorAction).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("fails closed when the persisted agent lookup fails", () => {
    const restore = silenceConsole();
    try {
      const deps = baseDeps({
        getSessionAgent: () => null,
        getSandbox: () => {
          throw new Error("registry unavailable");
        },
      });
      const result = restartSandboxGateway("alpha", { deps });

      expect(result).toMatchObject({
        ok: false,
        failureLayer: "unsupported agent",
        detail: expect.stringContaining("Sandbox agent lookup failed: registry unavailable."),
      });
      expect(deps.requestGatewaySupervisorAction).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("refuses custom gateway agents without a supported restart runtime", () => {
    const restore = silenceConsole();
    try {
      const deps = baseDeps({
        getSessionAgent: () => ({
          name: "custom-gateway",
          displayName: "Custom Gateway Agent",
        }),
        getSandbox: () => ({ name: "alpha", agent: "custom-gateway" }),
      });
      const result = restartSandboxGateway("alpha", { deps });

      expect(result).toMatchObject({ ok: false, failureLayer: "unsupported agent" });
      expect(result.ok).toBe(false);
      const failure = result as Extract<typeof result, { ok: false }>;
      expect(failure.detail).toContain("Agent 'custom-gateway' does not support gateway restart.");
      expect(failure.detail).toContain("Gateway restart-supported agents: openclaw, hermes.");
      expect(failure.detail).toContain(
        "Custom Gateway Agent does not declare a supported supervisor-mediated gateway restart runtime.",
      );
      const errorOutput = vi.mocked(console.error).mock.calls.join("\n");
      expect(errorOutput).toContain("Agent 'custom-gateway' does not support gateway restart.");
      expect(errorOutput).toContain("Gateway restart-supported agents: openclaw, hermes.");
      expect(deps.requestGatewaySupervisorAction).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});
