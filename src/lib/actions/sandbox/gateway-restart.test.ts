// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_RESTART_MARKERS as MARKERS } from "../../agent/gateway-restart-markers";
import * as agentRuntime from "../../agent/runtime";
import * as portableAgentLifecycle from "../../onboard/experimental/portable-agent-lifecycle";
import * as registry from "../../state/registry";
import { classifyGatewayRestartFailure } from "./gateway-restart";
import { restartSandboxGateway } from "./process-recovery";

afterEach(() => {
  vi.restoreAllMocks();
});

const supervisorFailureMarkers: Array<
  [string, ReturnType<typeof classifyGatewayRestartFailure>["layer"]]
> = [
  ["PRIVILEGED_CONTROL_UNAVAILABLE", "privileged control unavailable"],
  ["MANAGED_CONTROL_IDENTITY_CHANGED", "container identity changed"],
  ["SUPERVISOR_UNAVAILABLE", "privileged control unavailable"],
  ["SUPERVISOR_UNAVAILABLE\nNEMOCLAW_CONTROL_STAGE=await-replacement", "supervisor unavailable"],
  ["SUPERVISOR_NOT_RUNNING", "supervisor not running"],
  ["SUPERVISOR_DISCOVERY_PENDING", "supervisor unavailable"],
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
];

describe("gateway restart failure markers", () => {
  it.each(supervisorFailureMarkers)(
    "classifies supervisor failure marker %s as %s",
    (marker, layer) => {
      expect(
        classifyGatewayRestartFailure({
          status: 1,
          stdout: marker,
          stderr: "",
        }),
      ).toMatchObject({ layer });
    },
  );
});

describe("gateway restart failure classification precedence", () => {
  function classify(stdout: string, stderr = "") {
    return classifyGatewayRestartFailure({ status: 1, stdout, stderr });
  }

  it.each([
    ["SUPERVISOR_NOT_RUNNING", "supervisor not running"],
    [MARKERS.SECRET_BOUNDARY_REFUSED, "secret-boundary refusal"],
    [MARKERS.GATEWAY_UNSAFE_CONFIG_PATH, "unsafe config path"],
    ["HERMES_MCP_CONFIG_DRIFT", "MCP reconciliation refusal"],
    ["HERMES_CONFIG_HASH_MISMATCH", "config hash mismatch"],
  ] as const)("classifies %s ahead of the health timeout it causes", (marker, layer) => {
    expect(classify([marker, "GATEWAY_HEALTH_TIMEOUT"].join("\n"))).toMatchObject({ layer });
  });

  it("classifies a stopped supervisor ahead of the generic control-unavailable markers", () => {
    expect(classify(["SUPERVISOR_NOT_RUNNING", "SUPERVISOR_UNAVAILABLE"].join("\n"))).toMatchObject(
      { layer: "supervisor not running" },
    );
  });

  it("keeps the replacement-stage layer when a generic control marker co-occurs", () => {
    const output = [
      "SUPERVISOR_UNAVAILABLE",
      "NEMOCLAW_CONTROL_STAGE=await-replacement",
      "SUPERVISOR_BUSY",
    ].join("\n");
    expect(classify(output)).toMatchObject({ layer: "supervisor unavailable" });
  });

  it("classifies MCP drift ahead of the config hash mismatch reported with it", () => {
    const output = ["HERMES_MCP_CONFIG_DRIFT", "HERMES_CONFIG_HASH_MISMATCH"].join("\n");
    expect(classify(output)).toMatchObject({ layer: "MCP reconciliation refusal" });
  });

  it("applies the same precedence when markers split across stdout and stderr", () => {
    expect(classify("GATEWAY_HEALTH_TIMEOUT", "SUPERVISOR_NOT_RUNNING")).toMatchObject({
      layer: "supervisor not running",
    });
  });

  it("does not classify an embedded identity marker as a protocol marker", () => {
    expect(classify("failure mentions MANAGED_CONTROL_IDENTITY_CHANGED inline")).toMatchObject({
      layer: "launch failure",
    });
  });

  it("removes every complete identity marker line from the failure detail", () => {
    const output = [
      " MANAGED_CONTROL_IDENTITY_CHANGED ",
      "container changed once",
      "MANAGED_CONTROL_IDENTITY_CHANGED",
      "container changed again",
    ].join("\n");
    expect(classify(output)).toEqual({
      layer: "container identity changed",
      detail: "container changed once\ncontainer changed again",
    });
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

  it("rejects schema-5 inside the gateway restart lifecycle fence (#9203)", () => {
    vi.spyOn(portableAgentLifecycle, "assertHermesPortableCommandUnavailable").mockImplementation(
      () => {
        throw new Error("schema-5 rejected");
      },
    );
    const deps = baseDeps();

    expect(() => restartSandboxGateway("alpha", { quiet: true, deps })).toThrow(
      "schema-5 rejected",
    );

    expect(deps.requestGatewaySupervisorAction).not.toHaveBeenCalled();
    expect(deps.executeSandboxExecCommand).not.toHaveBeenCalled();
  });

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

  it("prints a bounded sanitized Hermes gateway-log tail after supervisor failure (#8614)", () => {
    const restore = silenceConsole();
    try {
      const logLines = Array.from({ length: 15 }, (_, index) => `line-${index}`);
      logLines[1] = "token=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";
      logLines[14] = "Bearer super-secret-token-value";
      const executeSandboxExecCommand = vi.fn(() => ({
        status: 0,
        stdout: logLines.join("\n"),
        stderr: "",
      }));
      const deps = baseDeps({
        getSessionAgent: () => ({ name: "hermes" }),
        getSandbox: () => ({ name: "triage-8614", agent: "hermes" }),
        requestGatewaySupervisorAction: vi.fn(() => ({
          status: 1,
          stdout: "GATEWAY_FAILED",
          stderr: "",
        })),
        executeSandboxExecCommand,
      });

      const result = restartSandboxGateway("triage-8614", { quiet: true, deps });
      const output = (console.error as ReturnType<typeof vi.fn>).mock.calls.flat().join("\n");

      expect(result).toMatchObject({ ok: false, failureLayer: "launch failure" });
      expect(executeSandboxExecCommand).toHaveBeenCalledWith(
        "triage-8614",
        "tail -n 12 /tmp/gateway.log 2>/dev/null || true",
      );
      expect(output).toContain("Hermes gateway log tail (sanitized):");
      expect(output).toContain("line-3");
      expect(output).toContain("Bearer <REDACTED>");
      expect(output).not.toContain("line-2");
      expect(output).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz0123456789");
      expect(output).not.toContain("super-secret-token-value");
      const tail = output.split("Hermes gateway log tail (sanitized):\n")[1]?.split("\n") ?? [];
      expect(tail).toHaveLength(12);
    } finally {
      restore();
    }
  });

  it("does not read a gateway-log tail for non-Hermes failures (#8614)", () => {
    const restore = silenceConsole();
    try {
      const executeSandboxExecCommand = vi.fn(() => ({
        status: 0,
        stdout: "unexpected",
        stderr: "",
      }));
      const deps = baseDeps({
        requestGatewaySupervisorAction: vi.fn(() => ({
          status: 1,
          stdout: "GATEWAY_FAILED",
          stderr: "",
        })),
        executeSandboxExecCommand,
      });

      restartSandboxGateway("alpha", { quiet: true, deps });

      expect(executeSandboxExecCommand).not.toHaveBeenCalled();
    } finally {
      restore();
    }
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

  it("uses the injected supervisor action for managed settle probes", () => {
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

  it("distinguishes a supervisor that becomes unavailable during replacement (#7484)", () => {
    const restore = silenceConsole();
    try {
      const deps = baseDeps({
        requestGatewaySupervisorAction: vi.fn(() => ({
          status: 1,
          stdout: "",
          stderr: [
            "SUPERVISOR_UNAVAILABLE",
            "NEMOCLAW_CONTROL_STAGE=await-replacement",
            "NEMOCLAW_SUPERVISOR_PID=40",
            "NEMOCLAW_GATEWAY_PID=0",
          ].join("\n"),
        })),
      });
      const result = restartSandboxGateway("alpha", { quiet: true, deps });

      expect(result).toMatchObject({
        ok: false,
        failureLayer: "supervisor unavailable",
        detail: expect.stringContaining("NEMOCLAW_CONTROL_STAGE=await-replacement"),
      });
      expect(console.error).toHaveBeenCalledWith(
        "  Failure layer: supervisor unavailable - gateway restart failed for 'alpha'.",
      );
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

  it("prints bounded redacted evidence for a Hermes health timeout (#7484)", () => {
    const restore = silenceConsole();
    try {
      const deps = baseDeps({
        requestGatewaySupervisorAction: vi.fn(() => ({
          status: 1,
          stdout: "",
          stderr: [
            "GATEWAY_HEALTH_TIMEOUT",
            "NEMOCLAW_CONTROL_STAGE=await-replacement",
            "NEMOCLAW_SUPERVISOR_PID=40",
            "NEMOCLAW_GATEWAY_PID=5252",
            "\u001b[31mNEMOCLAW_START_LOG=[gateway] Hermes gateway launch failed; token=sk-review-secret\u0007",
            "NEMOCLAW_START_LOG=[gateway] Hermes URL https://user:password@example.test/path?token=query-secret",
            "NEMOCLAW_START_LOG=[gateway] Hermes HF_TOKEN=hf-review-secret",
            ...Array.from(
              { length: 15 },
              (_, index) => `NEMOCLAW_START_LOG=[gateway] Hermes bounded marker ${index}`,
            ),
          ].join("\n"),
        })),
      });
      const result = restartSandboxGateway("alpha", { deps });

      expect(result).toMatchObject({
        ok: false,
        failureLayer: "health timeout",
        detail: expect.stringContaining("NEMOCLAW_GATEWAY_PID=5252"),
      });
      expect(result.ok).toBe(false);
      const detail = (result as Extract<typeof result, { ok: false }>).detail;
      expect(detail).toContain("token=<REDACTED>");
      expect(detail).toContain("HF_TOKEN=<REDACTED>");
      expect(detail).not.toContain("sk-review-secret");
      expect(detail).not.toContain("password");
      expect(detail).not.toContain("query-secret");
      expect(detail).not.toContain("hf-review-secret");
      expect(detail).not.toContain("\u001b");
      expect(detail).not.toContain("\u0007");
      const errorOutput = vi.mocked(console.error).mock.calls.join("\n");
      expect(vi.mocked(console.error).mock.calls).toHaveLength(13);
      expect(errorOutput).toContain("NEMOCLAW_START_LOG=[gateway] Hermes bounded marker 14");
      expect(errorOutput).not.toContain("NEMOCLAW_START_LOG=[gateway] Hermes bounded marker 2");
      expect(errorOutput).not.toContain("sk-review-secret");
      expect(errorOutput).not.toContain("query-secret");
      expect(errorOutput).not.toContain("hf-review-secret");
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

  it("reports every failed auxiliary forward in declaration order", () => {
    const restore = silenceConsole();
    try {
      const deps = baseDeps({
        ensureHermesDashboardPortForwardIfEnabled: vi.fn(() => false),
        recoverMessagingHostForward: vi.fn(() => false),
        recoverDeclaredAgentForwardPorts: vi.fn(() => false),
      });
      const result = restartSandboxGateway("alpha", { deps });

      expect(result).toMatchObject({ ok: false, failureLayer: "forward recovery failure" });
      expect(result.ok).toBe(false);
      const failure = result as Extract<typeof result, { ok: false }>;
      expect(failure.detail).toBe(
        "gateway health passed but the Hermes dashboard host forward, " +
          "the messaging webhook host forward, one or more agent-declared host forwards " +
          "could not be re-established",
      );
      const errorOutput = vi.mocked(console.error).mock.calls.join("\n");
      expect(errorOutput).toContain(
        "the Hermes dashboard host forward, the messaging webhook host forward, " +
          "one or more agent-declared host forwards",
      );
    } finally {
      restore();
    }
  });

  it("omits recovered and not-enabled auxiliary forwards from the failure detail", () => {
    const restore = silenceConsole();
    try {
      const deps = baseDeps({
        ensureHermesDashboardPortForwardIfEnabled: vi.fn(() => true),
        recoverMessagingHostForward: vi.fn(() => false),
        recoverDeclaredAgentForwardPorts: vi.fn(() => null),
      });
      const result = restartSandboxGateway("alpha", { deps });

      expect(result).toMatchObject({ ok: false, failureLayer: "forward recovery failure" });
      expect(result.ok).toBe(false);
      const failure = result as Extract<typeof result, { ok: false }>;
      expect(failure.detail).toBe(
        "gateway health passed but the messaging webhook host forward could not be re-established",
      );
    } finally {
      restore();
    }
  });

  it("reports the agent-declared host forwards when only their recovery fails", () => {
    const restore = silenceConsole();
    try {
      const deps = baseDeps({
        recoverDeclaredAgentForwardPorts: vi.fn(() => false),
      });
      const result = restartSandboxGateway("alpha", { deps });

      expect(result).toMatchObject({
        ok: false,
        failureLayer: "forward recovery failure",
        detail:
          "gateway health passed but one or more agent-declared host forwards could not be re-established",
      });
    } finally {
      restore();
    }
  });

  it("returns a recovered result when no auxiliary forward is enabled", () => {
    const restore = silenceConsole();
    try {
      const deps = baseDeps();
      const result = restartSandboxGateway("alpha", { deps });

      expect(result).toEqual({
        ok: true,
        restarted: true,
        healthPassed: true,
        forwardRecovered: true,
      });
      expect(console.error).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("reports the primary forward failure ahead of failed auxiliary forwards", () => {
    const restore = silenceConsole();
    try {
      const deps = baseDeps({
        ensureSandboxPortForward: vi.fn(() => false),
        ensureHermesDashboardPortForwardIfEnabled: vi.fn(() => false),
        recoverMessagingHostForward: vi.fn(() => false),
        recoverDeclaredAgentForwardPorts: vi.fn(() => false),
      });
      const result = restartSandboxGateway("alpha", { deps });

      expect(result).toMatchObject({
        ok: false,
        failureLayer: "forward recovery failure",
        detail:
          "gateway health passed but the primary dashboard/API host forward could not be re-established",
      });
      expect(result.ok).toBe(false);
      expect((result as Extract<typeof result, { ok: false }>).detail).not.toContain(
        "messaging webhook",
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
