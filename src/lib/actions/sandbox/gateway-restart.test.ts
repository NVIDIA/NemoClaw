// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_RESTART_MARKERS as MARKERS } from "../../agent/gateway-restart-markers";
import {
  classifyGatewayRestartFailure,
  restartSandboxGatewayWithDeps as restartSandboxGateway,
} from "./gateway-restart";

afterEach(() => vi.restoreAllMocks());

describe("legacy recovery failure classification", () => {
  it.each([
    ["PRIVILEGED_CONTROL_UNAVAILABLE", "privileged control unavailable"],
    ["SUPERVISOR_NOT_RUNNING", "supervisor not running"],
    ["SUPERVISOR_DISCOVERY_PENDING", "supervisor unavailable"],
    [MARKERS.SECRET_BOUNDARY_REFUSED, "secret-boundary refusal"],
    [MARKERS.GATEWAY_UNSAFE_CONFIG_PATH, "unsafe config path"],
    [MARKERS.GATEWAY_CONFIG_HASH_MISMATCH, "config hash mismatch"],
    ["HERMES_MCP_CONFIG_DRIFT", "mcp configuration drift"],
    ["GATEWAY_HEALTH_TIMEOUT", "health timeout"],
    [MARKERS.GATEWAY_FAILED, "launch failure"],
  ] as const)("classifies %s as %s", (marker, layer) => {
    expect(classifyGatewayRestartFailure({ status: 1, stdout: marker, stderr: "" })).toMatchObject({
      layer,
    });
  });

  it("removes protocol-only identity markers from diagnostics", () => {
    expect(
      classifyGatewayRestartFailure({
        status: 1,
        stdout: "MANAGED_CONTROL_IDENTITY_CHANGED\ncontainer changed",
        stderr: "",
      }),
    ).toEqual({
      layer: "container identity changed",
      detail: "container changed",
    });
  });
});

describe("restartSandboxGateway native lifecycle", () => {
  function silenceConsole() {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  }

  function baseDeps(overrides = {}) {
    return {
      sleep: vi.fn(async () => undefined),
      getSessionAgent: () => null,
      getSandbox: () => ({ name: "alpha", agent: "openclaw" }),
      resolveSandboxDashboardPort: () => 18789,
      executeSandboxExecCommand: vi.fn(async () => ({
        status: 0,
        stdout: JSON.stringify({
          ok: true,
          result: "scheduled",
          restart: { ok: true, delayMs: 0 },
        }),
        stderr: "",
      })),
      waitForRecoveredSandboxGateway: vi.fn(async () => true),
      ensureSandboxPortForward: vi.fn(() => true),
      ensureHermesDashboardPortForwardIfEnabled: vi.fn(() => null),
      recoverMessagingHostForward: vi.fn(() => null),
      recoverDeclaredAgentForwardPorts: vi.fn(() => null),
      printGatewayWedgeDiagnostics: vi.fn(async () => false),
      ...overrides,
    };
  }

  it("asks OpenClaw to restart its gateway", async () => {
    silenceConsole();
    const deps = baseDeps();
    const result = await restartSandboxGateway("alpha", { quiet: true, deps });

    expect(result).toMatchObject({
      ok: true,
      restarted: true,
      healthPassed: true,
    });
    expect(deps.executeSandboxExecCommand).toHaveBeenCalledWith(
      "alpha",
      "openclaw gateway restart --safe --skip-deferral --json",
      210000,
    );
  });

  it.each([
    "Gateway service is not installed.",
    "null",
    '{"ok":true}\n{"ok":true}',
    JSON.stringify({ ok: true, result: "scheduled", restart: { ok: true, delayMs: -1 } }),
    JSON.stringify({ ok: false }),
    JSON.stringify({ ok: true, result: "deferred", restart: { ok: true, delayMs: 0 } }),
    JSON.stringify({ ok: true, result: "scheduled", restart: { ok: true, delayMs: 60_001 } }),
  ])(
    "does not accept a healthy old gateway after an unacknowledged restart: %s",
    async (stdout) => {
      silenceConsole();
      const deps = baseDeps({
        executeSandboxExecCommand: vi.fn(async () => ({ status: 0, stdout, stderr: "" })),
      });
      expect(await restartSandboxGateway("alpha", { quiet: true, deps })).toMatchObject({
        ok: false,
        failureLayer: "native agent command",
      });
      expect(deps.waitForRecoveredSandboxGateway).not.toHaveBeenCalled();
      expect(deps.ensureSandboxPortForward).not.toHaveBeenCalled();
    },
  );

  it("waits for the acknowledged cooldown before checking gateway health", async () => {
    silenceConsole();
    const deps = baseDeps({
      executeSandboxExecCommand: vi.fn(async () => ({
        status: 0,
        stderr: "",
        stdout: JSON.stringify({
          ok: true,
          result: "coalesced",
          restart: { ok: true, delayMs: 30_000 },
        }),
      })),
    });
    expect(await restartSandboxGateway("alpha", { quiet: true, deps })).toMatchObject({ ok: true });
    expect(deps.sleep).toHaveBeenCalledWith(30);
    expect(deps.sleep.mock.invocationCallOrder[0]).toBeLessThan(
      deps.waitForRecoveredSandboxGateway.mock.invocationCallOrder[0]!,
    );
  });

  it("asks Hermes to restart its gateway", async () => {
    silenceConsole();
    const deps = baseDeps({
      getSessionAgent: () => ({ name: "hermes", displayName: "Hermes Agent" }),
      getSandbox: () => ({ name: "hermes-box", agent: "hermes" }),
    });
    const result = await restartSandboxGateway("hermes-box", {
      quiet: true,
      deps,
    });

    expect(result).toMatchObject({ ok: true });
    expect(deps.executeSandboxExecCommand).toHaveBeenCalledOnce();
    expect(deps.executeSandboxExecCommand).toHaveBeenCalledWith(
      "hermes-box",
      "hermes gateway restart",
      210000,
    );
  });

  it("refuses Hermes restart before reload when the secret boundary fails", async () => {
    silenceConsole();
    const execute = vi.fn(async () => ({
      status: 1,
      stdout: "",
      stderr: "[SECURITY] restart refused\nSECRET_BOUNDARY_REFUSED",
    }));
    const deps = baseDeps({
      getSessionAgent: () => ({ name: "hermes", displayName: "Hermes Agent" }),
      getSandbox: () => ({ name: "hermes-box", agent: "hermes" }),
      executeSandboxExecCommand: execute,
    });

    const result = await restartSandboxGateway("hermes-box", { quiet: true, deps });

    expect(result).toEqual({
      ok: false,
      failureLayer: "secret-boundary refusal",
      detail: "[SECURITY] restart refused\nSECRET_BOUNDARY_REFUSED",
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith("hermes-box", "hermes gateway restart", 210000);
  });

  it("reports the native agent failure without an authorization verdict", async () => {
    silenceConsole();
    const deps = baseDeps({
      executeSandboxExecCommand: vi.fn(async () => ({
        status: 1,
        stdout: "",
        stderr: "native restart failed",
      })),
    });
    const result = await restartSandboxGateway("alpha", { quiet: true, deps });

    expect(result).toEqual({
      ok: false,
      failureLayer: "native agent command",
      detail: "native restart failed",
    });
    expect(deps.waitForRecoveredSandboxGateway).not.toHaveBeenCalled();
    expect(vi.mocked(console.error).mock.calls.join("\n")).not.toContain("authorization");
  });

  it("waits for health after the native command", async () => {
    silenceConsole();
    const deps = baseDeps({
      waitForRecoveredSandboxGateway: vi.fn(async () => false),
    });
    const result = await restartSandboxGateway("alpha", { quiet: true, deps });

    expect(result).toMatchObject({ ok: false, failureLayer: "health timeout" });
    expect(deps.waitForRecoveredSandboxGateway).toHaveBeenCalledWith("alpha", {
      initialManagedHealthPassed: false,
      managedProbeImpl: expect.any(Function),
      quiet: true,
    });
    expect(deps.printGatewayWedgeDiagnostics).toHaveBeenCalled();
  });

  it("checks host forwards after native health passes", async () => {
    silenceConsole();
    const deps = baseDeps();
    const result = await restartSandboxGateway("alpha", { quiet: true, deps });

    expect(result).toEqual({
      ok: true,
      restarted: true,
      healthPassed: true,
      forwardRecovered: true,
    });
    expect(deps.ensureSandboxPortForward).toHaveBeenCalledWith("alpha");
    expect(deps.recoverMessagingHostForward).toHaveBeenCalledWith("alpha", {
      quiet: true,
    });
  });

  it("refuses an agent without a gateway runtime", async () => {
    silenceConsole();
    const deps = baseDeps({
      getSessionAgent: () => ({
        name: "langchain-deepagents-code",
        displayName: "LangChain Deep Agents Code",
        runtime: { kind: "terminal" },
      }),
      getSandbox: () => ({ name: "alpha", agent: "langchain-deepagents-code" }),
    });
    const result = await restartSandboxGateway("alpha", { quiet: true, deps });

    expect(result).toMatchObject({
      ok: false,
      failureLayer: "unsupported agent",
    });
    expect(deps.executeSandboxExecCommand).not.toHaveBeenCalled();
  });
});
