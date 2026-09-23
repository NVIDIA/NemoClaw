// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_RESTART_MARKERS as MARKERS } from "../../agent/gateway-restart-markers";
import { classifyGatewayRestartFailure } from "./gateway-restart";
import { restartSandboxGateway, waitForRecoveredSandboxGateway } from "./process-recovery";
import * as forwardRecovery from "./forward-recovery";

const executeFile = promisify(execFile);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

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
      waitForSandboxControlPlaneReady: vi.fn(async () => true),
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

  it.each([
    { status: 200, body: '{"ready":true}', ready: true },
    { status: 302, body: '{"ready":true}', ready: false },
    { status: 401, body: '{"ready":true}', ready: false },
    { status: 503, body: '{"ready":false}', ready: false },
    { status: 200, body: '{"ready":false}', ready: false },
    { status: 200, body: "<html>Control UI</html>", ready: false },
    { status: 200, body: '{"ok":true}', ready: false },
    { status: 200, body: '{"ready":"true"}', ready: false },
  ])(
    "requires the OpenClaw readiness contract (HTTP $status, $body)",
    async ({ status, body, ready }) => {
      silenceConsole();
      vi.stubEnv("NEMOCLAW_GATEWAY_RECOVERY_SETTLE_SECONDS", "0");
      const server = createServer((request, response) => {
        response.statusCode = request.url === "/readyz" ? status : 200;
        response.end(request.url === "/readyz" ? body : '{"ok":true}');
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const { port } = server.address() as { port: number };
        vi.spyOn(forwardRecovery, "resolveSandboxHealthProbeUrl").mockReturnValue(
          `http://127.0.0.1:${port}/health`,
        );
        const deps = baseDeps({
          executeSandboxExecCommand: vi.fn(async (_name: string, command: string) =>
            command.startsWith("curl ")
              ? executeFile("/bin/bash", ["-c", command]).then(
                  ({ stdout, stderr }) => ({ status: 0, stdout, stderr }),
                  (error: { code?: number; stdout?: string; stderr?: string }) => ({
                    status: error.code ?? 1,
                    stdout: error.stdout ?? "",
                    stderr: error.stderr ?? "",
                  }),
                )
              : { status: 0, stdout: "", stderr: "" },
          ),
          waitForRecoveredSandboxGateway: (
            name: string,
            options: Parameters<typeof waitForRecoveredSandboxGateway>[1],
          ) =>
            waitForRecoveredSandboxGateway(name, {
              ...options,
              probeImpl: options?.probeImpl ?? (async () => true),
              timeoutSeconds: 0,
              sleepImpl: () => undefined,
            }),
        });

        const result = await restartSandboxGateway("alpha", { quiet: true, deps });
        expect(result.ok).toBe(ready);
        expect(deps.ensureSandboxPortForward).toHaveBeenCalledTimes(ready ? 1 : 0);
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );

  it("requires health proof when Hermes restart closes the exec relay before status", async () => {
    silenceConsole();
    const deps = baseDeps({
      getSessionAgent: () => ({ name: "hermes", displayName: "Hermes Agent" }),
      getSandbox: () => ({ name: "hermes-box", agent: "hermes" }),
      executeSandboxExecCommand: vi.fn(async () => ({
        status: 1,
        stdout: "",
        stderr:
          "Error:   × code: 'The service is currently unavailable', message: \"exec relay closed\n  │ before the command reported an exit status\"",
      })),
    });

    await expect(restartSandboxGateway("hermes-box", { quiet: true, deps })).resolves.toMatchObject(
      {
        ok: true,
        healthPassed: true,
      },
    );
    expect(deps.waitForRecoveredSandboxGateway).toHaveBeenCalledOnce();
    expect(deps.waitForSandboxControlPlaneReady).toHaveBeenCalledExactlyOnceWith("hermes-box");
  });

  it("does not accept the Hermes relay closure for another agent", async () => {
    silenceConsole();
    const deps = baseDeps({
      executeSandboxExecCommand: vi.fn(async () => ({
        status: 1,
        stdout: "",
        stderr:
          "Error: code: 'The service is currently unavailable', message: \"exec relay closed before the command reported an exit status\"",
      })),
    });

    const result = await restartSandboxGateway("alpha", { quiet: true, deps });

    expect(result).toMatchObject({ ok: false, failureLayer: "native agent command" });
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
    expect(execute).toHaveBeenCalledWith("hermes-box", "hermes gateway restart", 210000);
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
      probeImpl: expect.any(Function),
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
