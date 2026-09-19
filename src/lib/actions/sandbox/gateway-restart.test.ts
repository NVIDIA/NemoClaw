// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_RESTART_MARKERS as MARKERS } from "../../agent/gateway-restart-markers";
import {
  classifyGatewayRestartFailure,
  createHermesSandboxIdentityRevalidator,
  restartHermesSandboxThroughOpenShell,
} from "./gateway-restart";
import { restartSandboxGateway } from "./process-recovery";

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
      getSessionAgent: () => null,
      getSandbox: () => ({ name: "alpha", agent: "openclaw" }),
      resolveSandboxDashboardPort: () => 18789,
      executeSandboxExecCommand: vi.fn(async () => ({
        status: 0,
        stdout: "",
        stderr: "",
      })),
      restartHermesSandbox: vi.fn(async () => ({ status: 0, stdout: "", stderr: "" })),
      waitForRecoveredSandboxGateway: vi.fn(async () => true),
      ensureSandboxPortForward: vi.fn(() => true),
      ensureHermesDashboardPortForwardIfEnabled: vi.fn(() => null),
      recoverMessagingHostForward: vi.fn(() => null),
      recoverDeclaredAgentForwardPorts: vi.fn(() => null),
      printGatewayWedgeDiagnostics: vi.fn(async () => false),
      ...overrides,
    };
  }

  it("asks OpenClaw for a native safe restart without service-manager ownership", async () => {
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
      "env -u OPENCLAW_HOME -u OPENCLAW_STATE_DIR -u OPENCLAW_CONFIG_PATH openclaw gateway restart --safe --skip-deferral --json",
      210000,
    );
  });

  it("restarts the Hermes sandbox through OpenShell lifecycle", async () => {
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
    expect(deps.restartHermesSandbox).toHaveBeenCalledExactlyOnceWith("hermes-box");
    expect(deps.executeSandboxExecCommand).toHaveBeenCalledExactlyOnceWith(
      "hermes-box",
      "hermes gateway --help",
      210000,
    );
  });

  it("reports a failed Hermes OpenShell lifecycle before gateway health", async () => {
    silenceConsole();
    const deps = baseDeps({
      getSessionAgent: () => ({ name: "hermes", displayName: "Hermes Agent" }),
      getSandbox: () => ({ name: "hermes-box", agent: "hermes" }),
      restartHermesSandbox: vi.fn(async () => ({
        status: 1,
        stdout: "",
        stderr: "OpenShell sandbox stop failed",
      })),
    });

    await expect(restartSandboxGateway("hermes-box", { quiet: true, deps })).resolves.toMatchObject(
      {
        ok: false,
        failureLayer: "native agent command",
      },
    );
    expect(deps.waitForRecoveredSandboxGateway).not.toHaveBeenCalled();
  });

  it("converts a rejected Hermes identity check into a typed failure", async () => {
    silenceConsole();
    const deps = baseDeps({
      getSessionAgent: () => ({ name: "hermes", displayName: "Hermes Agent" }),
      getSandbox: () => ({ name: "hermes-box", agent: "hermes" }),
      restartHermesSandbox: vi.fn(async () => {
        throw new Error("Sandbox 'hermes-box' identity changed during Hermes restart.");
      }),
    });

    await expect(restartSandboxGateway("hermes-box", { quiet: true, deps })).resolves.toEqual({
      ok: false,
      failureLayer: "container identity changed",
      detail: "Sandbox 'hermes-box' identity changed during Hermes restart.",
    });
    expect(deps.waitForRecoveredSandboxGateway).not.toHaveBeenCalled();
  });

  it("refuses a same-name Hermes replacement before start or health recovery", async () => {
    silenceConsole();
    const expectedFingerprint = "a".repeat(64);
    const replacementFingerprint = "b".repeat(64);
    const entry = {
      name: "hermes-box",
      agent: "hermes",
      gatewayName: "nemoclaw",
      lifecycleGeneration: "generation-1",
      lifecycleLiveIdentityFingerprint: expectedFingerprint,
    };
    const inspectLiveIdentity = vi
      .fn<() => string>()
      .mockReturnValueOnce(expectedFingerprint)
      .mockReturnValue(replacementFingerprint);
    const runOpenshell = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
    const revalidate = createHermesSandboxIdentityRevalidator({
      sandboxName: entry.name,
      getSandbox: () => entry,
      inspectLiveIdentity: () => inspectLiveIdentity(),
    });
    const deps = baseDeps({
      getSessionAgent: () => ({ name: "hermes", displayName: "Hermes Agent" }),
      getSandbox: () => entry,
      restartHermesSandbox: vi.fn(async (sandboxName: string) =>
        restartHermesSandboxThroughOpenShell(sandboxName, runOpenshell, revalidate),
      ),
    });

    await expect(restartSandboxGateway("hermes-box", { quiet: true, deps })).resolves.toEqual({
      ok: false,
      failureLayer: "container identity changed",
      detail:
        "Sandbox 'hermes-box' live identity changed before confirming Hermes sandbox 'hermes-box' after OpenShell stop.",
    });
    expect(runOpenshell).toHaveBeenCalledExactlyOnceWith(
      ["sandbox", "stop", "hermes-box"],
      expect.any(Object),
    );
    expect(runOpenshell).not.toHaveBeenCalledWith(
      ["sandbox", "start", "hermes-box"],
      expect.any(Object),
    );
    expect(deps.waitForRecoveredSandboxGateway).not.toHaveBeenCalled();
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
    expect(execute).toHaveBeenCalledWith("hermes-box", "hermes gateway --help", 210000);
    expect(deps.restartHermesSandbox).not.toHaveBeenCalled();
  });

  it("reports the native OpenClaw restart failure without an authorization verdict", async () => {
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

  it("waits for health after the native safe restart", async () => {
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
