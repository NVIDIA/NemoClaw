// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { SandboxCommandTransportError } from "../../adapters/sandbox/command-transport";
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

  function readinessDiagnostic() {
    const prefix = "  OpenClaw restart readiness: ";
    const line = vi
      .mocked(console.error)
      .mock.calls.map(([value]) => String(value))
      .find((value) => value.startsWith(prefix));
    return line ? JSON.parse(line.slice(prefix.length)) : null;
  }

  it.each([
    {
      stdout: '{"ready":true}\n302',
      status: 0,
      httpStatus: 302,
      jsonParsed: true,
      ready: true,
      decision: false,
    },
    {
      stdout: '{"ready":true}\n401',
      status: 0,
      httpStatus: 401,
      jsonParsed: true,
      ready: true,
      decision: false,
    },
    {
      stdout: '{"ready":false}\n503',
      status: 0,
      httpStatus: 503,
      jsonParsed: true,
      ready: false,
      decision: false,
    },
    {
      stdout: '{"ready":false}\n200',
      status: 0,
      httpStatus: 200,
      jsonParsed: true,
      ready: false,
      decision: false,
    },
    {
      stdout: '{"ready":"true"}\n200',
      status: 0,
      httpStatus: 200,
      jsonParsed: true,
      ready: null,
      decision: false,
    },
    {
      stdout: '{"ok":true}\n200',
      status: 0,
      httpStatus: 200,
      jsonParsed: true,
      ready: null,
      decision: false,
    },
    {
      stdout: "not-json\n200",
      status: 0,
      httpStatus: 200,
      jsonParsed: false,
      ready: null,
      decision: false,
    },
    {
      stdout: '{"ready":true}',
      status: 0,
      httpStatus: null,
      jsonParsed: false,
      ready: null,
      decision: false,
    },
    {
      stdout: '{"ready":true}\n200',
      status: 28,
      httpStatus: 200,
      jsonParsed: true,
      ready: true,
      decision: false,
    },
    {
      stdout: "\n000",
      status: 7,
      httpStatus: null,
      jsonParsed: false,
      ready: null,
      decision: false,
    },
  ])(
    "reports readiness evidence without changing HTTP $httpStatus command $status outcome ($stdout)",
    async (sample) => {
      silenceConsole();
      const execute = vi
        .fn()
        .mockResolvedValueOnce({ status: 0, stdout: "", stderr: "" })
        .mockResolvedValue({
          status: sample.status,
          stdout: sample.stdout,
          stderr: "secret-stderr",
        });
      const deps = baseDeps({
        executeSandboxExecCommand: execute,
        waitForRecoveredSandboxGateway: async (
          name: string,
          options: Parameters<typeof waitForRecoveredSandboxGateway>[1],
        ) => {
          expect(await options!.probeImpl!(name)).toBe(sample.decision);
          return sample.decision;
        },
      });
      const result = await restartSandboxGateway("alpha", { quiet: true, deps });
      expect(result.ok).toBe(sample.decision);
      expect(execute).toHaveBeenCalledTimes(2);
      expect(execute.mock.calls[0]?.[2]).toBe(210000);
      expect(execute.mock.calls[1]?.[2]).toBe(10000);
      expect(readinessDiagnostic()).toEqual({
        nativeRestartStatus: 0,
        totalProbes: 1,
        droppedSamples: 0,
        samples: [
          {
            ordinal: 1,
            commandStatus: sample.status,
            transportErrorKind: null,
            httpStatus: sample.httpStatus,
            jsonParsed: sample.jsonParsed,
            ready: sample.ready,
            probeResult: false,
          },
        ],
      });
      expect(deps.ensureSandboxPortForward).not.toHaveBeenCalled();
      expect(vi.mocked(console.error).mock.calls.join("\n")).not.toContain("secret-stderr");
    },
  );

  it("retains the last 32 readiness observations without response bodies or extra probes", async () => {
    silenceConsole();
    const secret = "private-token-".repeat(10000);
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ status: 0, stdout: secret, stderr: secret })
      .mockResolvedValue({
        status: 0,
        stdout: `${JSON.stringify({ ready: false, token: secret, url: "https://user:password@example.com" })}\n503`,
        stderr: secret,
      });
    const deps = baseDeps({
      executeSandboxExecCommand: execute,
      waitForRecoveredSandboxGateway: async (
        name: string,
        options: Parameters<typeof waitForRecoveredSandboxGateway>[1],
      ) =>
        waitForRecoveredSandboxGateway(name, {
          ...options,
          timeoutSeconds: 102,
          sleepImpl: () => undefined,
        }),
    });
    await expect(restartSandboxGateway("alpha", { quiet: true, deps })).resolves.toMatchObject({
      ok: false,
      failureLayer: "health timeout",
    });
    const diagnostic = readinessDiagnostic();
    expect(diagnostic).toMatchObject({
      nativeRestartStatus: 0,
      totalProbes: 35,
      droppedSamples: 3,
    });
    expect(diagnostic.samples.map((sample: { ordinal: number }) => sample.ordinal)).toEqual(
      Array.from({ length: 32 }, (_, index) => index + 4),
    );
    expect(execute).toHaveBeenCalledTimes(36);
    const printed = vi.mocked(console.error).mock.calls.join("\n");
    expect(printed.length).toBeLessThan(6000);
    expect(printed).not.toMatch(/private-token|password|https:\/\/|example\.com/);
  });

  it.each(["cancelled", "capture", "invocation", "timeout", "unavailable", "malformed"] as const)(
    "records unavailable readiness evidence for %s without retrying the command",
    async (kind) => {
      silenceConsole();
      const execute = vi.fn().mockResolvedValueOnce({ status: 0, stdout: "", stderr: "" });
      execute.mockRejectedValue(new SandboxCommandTransportError(kind));
      const deps = baseDeps({
        executeSandboxExecCommand: execute,
        waitForRecoveredSandboxGateway: async (
          name: string,
          options: Parameters<typeof waitForRecoveredSandboxGateway>[1],
        ) => {
          expect(await options!.probeImpl!(name)).toBeNull();
          return false;
        },
      });
      await expect(restartSandboxGateway("alpha", { quiet: true, deps })).resolves.toMatchObject({
        ok: false,
        failureLayer: "health timeout",
      });
      expect(readinessDiagnostic().samples).toEqual([
        {
          ordinal: 1,
          commandStatus: null,
          transportErrorKind: kind,
          httpStatus: null,
          jsonParsed: false,
          ready: null,
          probeResult: null,
        },
      ]);
      expect(execute).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["cancelled", "capture", "invocation", "timeout", "unavailable", "malformed"] as const)(
    "reports %s transport failure without retrying restart",
    async (kind) => {
      silenceConsole();
      const execute = vi.fn().mockRejectedValue(new SandboxCommandTransportError(kind));
      const deps = baseDeps({ executeSandboxExecCommand: execute });
      await expect(restartSandboxGateway("alpha", { quiet: true, deps })).resolves.toMatchObject({
        ok: false,
        failureLayer: "native agent command",
      });
      expect(execute).toHaveBeenCalledOnce();
      expect(deps.waitForRecoveredSandboxGateway).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining(kind));
    },
  );

  it("propagates unexpected restart errors", async () => {
    silenceConsole();
    const error = new Error("authority refusal");
    const deps = baseDeps({ executeSandboxExecCommand: vi.fn().mockRejectedValue(error) });
    await expect(restartSandboxGateway("alpha", { quiet: true, deps })).rejects.toBe(error);
  });

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
      "env -u OPENCLAW_HOME -u OPENCLAW_STATE_DIR -u OPENCLAW_CONFIG_PATH NEMOCLAW_OPENCLAW_HOST_RESTART=1 openclaw gateway restart --safe --skip-deferral --json",
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

  it.each([
    { settled: true, observations: null },
    { settled: false, observations: [true, false] },
  ])(
    "preserves the readiness settle result $settled and its probe count",
    async ({ settled, observations }) => {
      silenceConsole();
      vi.stubEnv("NEMOCLAW_GATEWAY_RECOVERY_SETTLE_SECONDS", "25");
      const execute = vi
        .fn()
        .mockResolvedValueOnce({ status: 0, stdout: "", stderr: "" })
        .mockResolvedValueOnce({ status: 0, stdout: '{"ready":true}\n200', stderr: "" })
        .mockResolvedValueOnce({
          status: 0,
          stdout: `${JSON.stringify({ ready: settled })}\n200`,
          stderr: "",
        });
      const sleep = vi.fn();
      const deps = baseDeps({
        executeSandboxExecCommand: execute,
        waitForRecoveredSandboxGateway: (
          name: string,
          options: Parameters<typeof waitForRecoveredSandboxGateway>[1],
        ) =>
          waitForRecoveredSandboxGateway(name, { ...options, timeoutSeconds: 0, sleepImpl: sleep }),
      });
      expect((await restartSandboxGateway("alpha", { quiet: true, deps })).ok).toBe(settled);
      expect(execute).toHaveBeenCalledTimes(3);
      expect(sleep).toHaveBeenCalledExactlyOnceWith(25);
      expect(
        readinessDiagnostic()?.samples.map(
          (sample: { probeResult: boolean }) => sample.probeResult,
        ) ?? null,
      ).toEqual(observations);
    },
  );

  it("records a missing readiness command result without inventing a transport cause", async () => {
    silenceConsole();
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockResolvedValue(null);
    const deps = baseDeps({
      executeSandboxExecCommand: execute,
      waitForRecoveredSandboxGateway: async (
        name: string,
        options: Parameters<typeof waitForRecoveredSandboxGateway>[1],
      ) => {
        expect(await options!.probeImpl!(name)).toBeNull();
        return false;
      },
    });
    await expect(restartSandboxGateway("alpha", { quiet: true, deps })).resolves.toMatchObject({
      ok: false,
      failureLayer: "health timeout",
    });
    expect(readinessDiagnostic().samples).toEqual([
      {
        ordinal: 1,
        commandStatus: null,
        transportErrorKind: null,
        httpStatus: null,
        jsonParsed: false,
        ready: null,
        probeResult: null,
      },
    ]);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("treats lost OpenClaw readiness transport as unavailable evidence", async () => {
    silenceConsole();
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockRejectedValueOnce(new SandboxCommandTransportError("unavailable"));
    const deps = baseDeps({
      executeSandboxExecCommand: execute,
      waitForRecoveredSandboxGateway: async (
        name: string,
        options: Parameters<typeof waitForRecoveredSandboxGateway>[1],
      ) => {
        expect(await options!.probeImpl!(name)).toBeNull();
        return false;
      },
    });
    await expect(restartSandboxGateway("alpha", { quiet: true, deps })).resolves.toMatchObject({
      ok: false,
      failureLayer: "health timeout",
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(deps.ensureSandboxPortForward).not.toHaveBeenCalled();
  });

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

  it("retains the restart diagnostic when Hermes log collection loses transport", async () => {
    silenceConsole();
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ status: 1, stdout: "", stderr: "native restart failed" })
      .mockRejectedValueOnce(new SandboxCommandTransportError("unavailable"));
    const deps = baseDeps({
      getSessionAgent: () => ({ name: "hermes", displayName: "Hermes Agent" }),
      getSandbox: () => ({ name: "hermes-box", agent: "hermes" }),
      executeSandboxExecCommand: execute,
    });
    await expect(restartSandboxGateway("hermes-box", { quiet: true, deps })).resolves.toEqual({
      ok: false,
      failureLayer: "native agent command",
      detail: "native restart failed",
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1]?.[1]).toContain("tail -n");
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
