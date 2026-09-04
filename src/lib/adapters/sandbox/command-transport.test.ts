// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { OpenShellSandboxBufferedCommandExecutor } from "../openshell/sandbox-command";
import { namedOpenShellGateway } from "../openshell/sandbox-observer";

const mocks = vi.hoisted(() => ({
  createTempSshConfig: vi.fn(),
  resolveOpenshellSandboxSshHost: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: mocks.spawnSync };
});

vi.mock("../../sandbox/temp-ssh-config", () => ({
  createTempSshConfig: mocks.createTempSshConfig,
}));

vi.mock("../openshell/sandbox-ssh-host", () => ({
  resolveOpenshellSandboxSshHost: mocks.resolveOpenshellSandboxSshHost,
}));

import {
  type CommandTransportDependencies,
  executeSandboxCommandTransport,
  executeSandboxExecCommandTransport,
} from "./command-transport";

function spawnResult(
  stdout: string,
  overrides: Partial<ReturnType<typeof spawnSync>> = {},
): ReturnType<typeof spawnSync> {
  return {
    error: undefined,
    output: [],
    pid: 1234,
    signal: null,
    status: 0,
    stderr: "",
    stdout,
    ...overrides,
  } as ReturnType<typeof spawnSync>;
}

function createDependencies(
  overrides: Partial<CommandTransportDependencies> = {},
): CommandTransportDependencies {
  return {
    buildSandboxExecMarkedCommand: vi.fn((command: string) => `marked:${command}`),
    buildSubprocessEnv: vi.fn(() => ({ PATH: "/usr/bin" })),
    captureSandboxSshConfig: vi.fn(() => ({
      output: "Host openshell-alpha.default\n  HostName 127.0.0.1\n",
      status: 0,
    })),
    executePrivilegedSandboxCommand: vi.fn(() => ({
      status: 0,
      stdout: "fallback-output",
      stderr: "",
    })),
    extractSandboxExecCommandStdout: vi.fn((output: string) => output),
    commandExecutor: {
      runBuffered: vi.fn(async () => ({
        outcome: { kind: "completed", exitCode: 0 },
        stdout: "ok",
        stderr: "",
      })),
    } as OpenShellSandboxBufferedCommandExecutor,
    isDirectSandboxFallbackUnavailableError: vi.fn(() => false),
    openshellProbeTimeoutMs: 5000,
    ...overrides,
  };
}

describe("sandbox command transport", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("resolves SSH state and cleans the temporary config after the command", () => {
    const events: string[] = [];
    const deps = createDependencies({
      buildSubprocessEnv: vi.fn(() => {
        events.push("environment");
        return { PATH: "/usr/bin" };
      }),
      captureSandboxSshConfig: vi.fn(() => {
        events.push("config");
        return {
          output: "Host openshell-alpha.default\n  HostName 127.0.0.1\n",
          status: 0,
        };
      }),
    });
    mocks.resolveOpenshellSandboxSshHost.mockImplementation(() => {
      events.push("host");
      return "openshell-alpha.default";
    });
    mocks.createTempSshConfig.mockImplementation(() => {
      events.push("temp");
      return {
        cleanup: () => events.push("cleanup"),
        dir: "/tmp/nemoclaw-ssh-test",
        file: "/tmp/nemoclaw-ssh-test/ssh_config",
      };
    });
    mocks.spawnSync.mockImplementation(() => {
      events.push("spawn");
      return spawnResult("ok\n");
    });

    expect(executeSandboxCommandTransport(deps, "alpha", "id")).toEqual({
      status: 0,
      stderr: "",
      stdout: "ok",
    });
    expect(events).toEqual(["config", "host", "temp", "environment", "spawn", "cleanup"]);
  });

  it("uses the caller's bounded SSH command timeout", () => {
    const deps = createDependencies();
    mocks.resolveOpenshellSandboxSshHost.mockReturnValue("openshell-alpha.default");
    mocks.createTempSshConfig.mockReturnValue({
      cleanup: vi.fn(),
      dir: "/tmp/nemoclaw-ssh-test",
      file: "/tmp/nemoclaw-ssh-test/ssh_config",
    });
    mocks.spawnSync.mockReturnValue(spawnResult("ok\n"));

    expect(executeSandboxCommandTransport(deps, "alpha", "openclaw doctor --fix", 300_000)).toEqual(
      {
        status: 0,
        stderr: "",
        stdout: "ok",
      },
    );
    expect(mocks.spawnSync.mock.calls[0]?.[2]).toMatchObject({ timeout: 300_000 });
  });

  it("pins OpenShell exec to the requested gateway (#9834)", async () => {
    const deps = createDependencies();

    await expect(
      executeSandboxExecCommandTransport(deps, "alpha", "id", 9000, {
        gatewayName: "recorded-gateway",
      }),
    ).resolves.toEqual({ status: 0, stdout: "ok", stderr: "" });
    expect(deps.commandExecutor.runBuffered).toHaveBeenCalledWith({
      sandboxName: "alpha",
      target: namedOpenShellGateway("recorded-gateway"),
      command: ["sh", "-c", "marked:id"],
      environment: { PATH: "/usr/bin" },
      timeoutMilliseconds: 9000,
    });
  });

  it("does not use local Docker fallback for gateway-pinned exec (#9834)", async () => {
    const deps = createDependencies({
      extractSandboxExecCommandStdout: vi.fn(() => null),
      commandExecutor: {
        runBuffered: vi.fn(async () => ({
          outcome: { kind: "completed", exitCode: 1 },
          stdout: "untrusted-output",
          stderr: "",
        })),
      } as OpenShellSandboxBufferedCommandExecutor,
    });

    await expect(
      executeSandboxExecCommandTransport(deps, "alpha", "id", 9000, {
        gatewayName: "recorded-gateway",
        allowLocalDockerFallback: false,
      }),
    ).resolves.toBeNull();
    expect(deps.executePrivilegedSandboxCommand).not.toHaveBeenCalled();
  });

  it("does not retry locally after an inconclusive completed OpenShell result", async () => {
    const events: string[] = [];
    const deps = createDependencies({
      buildSandboxExecMarkedCommand: vi.fn((command: string) => {
        events.push("mark");
        return `marked:${command}`;
      }),
      buildSubprocessEnv: vi.fn(() => {
        events.push("environment");
        return { PATH: "/usr/bin" };
      }),
      executePrivilegedSandboxCommand: vi.fn(() => {
        events.push("fallback-execution");
        return { status: 0, stdout: "fallback-output", stderr: "" };
      }),
      extractSandboxExecCommandStdout: vi.fn((output: string) => {
        events.push(`parse:${output}`);
        return output === "fallback-output" ? "fallback-ok" : null;
      }),
      commandExecutor: {
        runBuffered: vi.fn(async () => {
          events.push("openshell-execution");
          return {
            outcome: { kind: "completed", exitCode: 1 },
            stdout: "unmarked-output",
            stderr: "",
          };
        }),
      } as OpenShellSandboxBufferedCommandExecutor,
    });

    await expect(
      executeSandboxExecCommandTransport(deps, "alpha", "id", 9000, {}),
    ).resolves.toBeNull();
    expect(events).toEqual(["mark", "environment", "openshell-execution", "parse:unmarked-output"]);
    expect(deps.executePrivilegedSandboxCommand).not.toHaveBeenCalled();
  });

  it("uses the local fallback when the OpenShell executable is unavailable", async () => {
    const deps = createDependencies({
      commandExecutor: {
        runBuffered: vi.fn(async () => ({
          outcome: {
            kind: "failed" as const,
            error: { kind: "unavailable" as const, message: "OpenShell binary not found" },
          },
          stdout: "",
          stderr: "",
        })),
      },
    });

    await expect(
      executeSandboxExecCommandTransport(deps, "alpha", "id", 9000, {}),
    ).resolves.toEqual({ status: 0, stdout: "fallback-output", stderr: "" });
    expect(deps.executePrivilegedSandboxCommand).toHaveBeenCalledOnce();
  });

  it.each(["timeout", "capture", "invocation"] as const)(
    "does not retry a typed %s failure through local Docker",
    async (kind) => {
      const deps = createDependencies({
        commandExecutor: {
          runBuffered: vi.fn(async () => ({
            outcome: { kind: "failed" as const, error: { kind, message: `${kind} failure` } },
            stdout: "partial",
            stderr: "detail",
          })),
        },
      });

      await expect(
        executeSandboxExecCommandTransport(deps, "alpha", "id", 9000, {}),
      ).resolves.toBeNull();
      expect(deps.executePrivilegedSandboxCommand).not.toHaveBeenCalled();
    },
  );

  it("does not catch validation or security refusals and retry through local Docker", async () => {
    const refusal = new Error("gateway authority refused");
    const deps = createDependencies({
      commandExecutor: {
        runBuffered: vi.fn(async () => {
          throw refusal;
        }),
      },
    });

    await expect(executeSandboxExecCommandTransport(deps, "alpha", "id", 9000, {})).rejects.toBe(
      refusal,
    );
    expect(deps.executePrivilegedSandboxCommand).not.toHaveBeenCalled();
  });
});
