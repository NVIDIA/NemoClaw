// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
    dockerSpawnSync: vi.fn(() => spawnResult("fallback-output")),
    extractSandboxExecCommandStdout: vi.fn((output: string) => output),
    getOpenshellBinary: vi.fn(() => "/usr/bin/openshell"),
    isDirectSandboxFallbackUnavailableError: vi.fn(() => false),
    openshellProbeTimeoutMs: 5000,
    privilegedSandboxExecArgv: vi.fn(() => ["exec", "container-id", "sh", "-c", "marked:id"]),
    root: "/repo",
    withPrivilegedSandboxExecutionLease: <T>(
      _sandboxName: string,
      _operation: string,
      fn: () => T,
    ): T => fn(),
    ...overrides,
  };
}

describe("sandbox command transport privileged execution lease", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("holds the SSH lease from config resolution through process cleanup", () => {
    const events: string[] = [];
    let leaseHeld = false;
    const assertLeaseHeld = (event: string): void => {
      expect(leaseHeld).toBe(true);
      events.push(event);
    };
    const withLease: CommandTransportDependencies["withPrivilegedSandboxExecutionLease"] = <T>(
      sandboxName: string,
      operation: string,
      fn: () => T,
    ): T => {
      expect(leaseHeld).toBe(false);
      events.push(`lease:${sandboxName}:${operation}`);
      leaseHeld = true;
      try {
        return fn();
      } finally {
        leaseHeld = false;
        events.push("lease:released");
      }
    };
    const deps = createDependencies({
      buildSubprocessEnv: vi.fn(() => {
        assertLeaseHeld("environment");
        return { PATH: "/usr/bin" };
      }),
      captureSandboxSshConfig: vi.fn(() => {
        assertLeaseHeld("config");
        return {
          output: "Host openshell-alpha.default\n  HostName 127.0.0.1\n",
          status: 0,
        };
      }),
      withPrivilegedSandboxExecutionLease: withLease,
    });
    mocks.resolveOpenshellSandboxSshHost.mockImplementation(() => {
      assertLeaseHeld("host");
      return "openshell-alpha.default";
    });
    mocks.createTempSshConfig.mockImplementation(() => {
      assertLeaseHeld("temp");
      return {
        cleanup: () => assertLeaseHeld("cleanup"),
        dir: "/tmp/nemoclaw-ssh-test",
        file: "/tmp/nemoclaw-ssh-test/ssh_config",
      };
    });
    mocks.spawnSync.mockImplementation(() => {
      assertLeaseHeld("spawn");
      return spawnResult("ok\n");
    });

    expect(executeSandboxCommandTransport(deps, "alpha", "id")).toEqual({
      status: 0,
      stderr: "",
      stdout: "ok",
    });
    expect(events).toEqual([
      "lease:alpha:sandbox SSH command transport",
      "config",
      "host",
      "temp",
      "environment",
      "spawn",
      "cleanup",
      "lease:released",
    ]);
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

  it("does not resolve SSH state or spawn when lease acquisition is rejected", () => {
    const rejection = new Error("provider fence active");
    const deps = createDependencies({
      withPrivilegedSandboxExecutionLease: <T>(
        sandboxName: string,
        operation: string,
        _fn: () => T,
      ): T => {
        expect(sandboxName).toBe("alpha");
        expect(operation).toBe("sandbox SSH command transport");
        throw rejection;
      },
    });

    expect(() => executeSandboxCommandTransport(deps, "alpha", "id")).toThrow(rejection);
    expect(deps.captureSandboxSshConfig).not.toHaveBeenCalled();
    expect(mocks.resolveOpenshellSandboxSshHost).not.toHaveBeenCalled();
    expect(mocks.createTempSshConfig).not.toHaveBeenCalled();
    expect(mocks.spawnSync).not.toHaveBeenCalled();
  });

  it("pins OpenShell exec to the requested gateway (#9834)", () => {
    const deps = createDependencies();
    mocks.spawnSync.mockReturnValue(spawnResult("ok"));

    expect(
      executeSandboxExecCommandTransport(deps, "alpha", "id", 9000, {
        gatewayName: "recorded-gateway",
      }),
    ).toEqual({ status: 0, stdout: "ok", stderr: "" });
    expect(mocks.spawnSync.mock.calls[0]?.[1]).toEqual([
      "sandbox",
      "exec",
      "--name",
      "alpha",
      "-g",
      "recorded-gateway",
      "--",
      "sh",
      "-c",
      "marked:id",
    ]);
  });

  it("does not use local Docker fallback for gateway-pinned exec (#9834)", () => {
    const deps = createDependencies({
      extractSandboxExecCommandStdout: vi.fn(() => null),
    });
    mocks.spawnSync.mockReturnValue(spawnResult("untrusted-output", { status: 1 }));

    expect(
      executeSandboxExecCommandTransport(deps, "alpha", "id", 9000, {
        gatewayName: "recorded-gateway",
        allowLocalDockerFallback: false,
      }),
    ).toBeNull();
    expect(deps.privilegedSandboxExecArgv).not.toHaveBeenCalled();
    expect(deps.dockerSpawnSync).not.toHaveBeenCalled();
  });

  it("holds one lease across OpenShell failure and the complete local fallback", () => {
    const events: string[] = [];
    let leaseHeld = false;
    let leaseCalls = 0;
    const assertLeaseHeld = (event: string): void => {
      expect(leaseHeld).toBe(true);
      events.push(event);
    };
    const withLease: CommandTransportDependencies["withPrivilegedSandboxExecutionLease"] = <T>(
      sandboxName: string,
      operation: string,
      fn: () => T,
    ): T => {
      leaseCalls += 1;
      expect(leaseHeld).toBe(false);
      events.push(`lease:${sandboxName}:${operation}`);
      leaseHeld = true;
      try {
        return fn();
      } finally {
        leaseHeld = false;
        events.push("lease:released");
      }
    };
    const deps = createDependencies({
      buildSandboxExecMarkedCommand: vi.fn((command: string) => {
        assertLeaseHeld("mark");
        return `marked:${command}`;
      }),
      buildSubprocessEnv: vi.fn(() => {
        assertLeaseHeld("environment");
        return { PATH: "/usr/bin" };
      }),
      dockerSpawnSync: vi.fn(() => {
        assertLeaseHeld("fallback-spawn");
        return spawnResult("fallback-output");
      }),
      extractSandboxExecCommandStdout: vi.fn((output: string) => {
        assertLeaseHeld(`parse:${output}`);
        return output === "fallback-output" ? "fallback-ok" : null;
      }),
      getOpenshellBinary: vi.fn(() => {
        assertLeaseHeld("openshell-resolution");
        return "/usr/bin/openshell";
      }),
      privilegedSandboxExecArgv: vi.fn(() => {
        assertLeaseHeld("fallback-resolution");
        return ["exec", "container-id", "sh", "-c", "marked:id"];
      }),
      withPrivilegedSandboxExecutionLease: withLease,
    });
    mocks.spawnSync.mockImplementation(() => {
      assertLeaseHeld("openshell-spawn");
      return spawnResult("unmarked-output", { status: 1 });
    });

    expect(executeSandboxExecCommandTransport(deps, "alpha", "id", 9000, {})).toEqual({
      status: 0,
      stderr: "",
      stdout: "fallback-ok",
    });
    expect(leaseCalls).toBe(1);
    expect(events).toEqual([
      "lease:alpha:sandbox OpenShell command transport",
      "mark",
      "openshell-resolution",
      "environment",
      "openshell-spawn",
      "parse:unmarked-output",
      "fallback-resolution",
      "environment",
      "fallback-spawn",
      "parse:fallback-output",
      "lease:released",
    ]);
  });

  it("does not resolve either exec transport or spawn when lease acquisition is rejected", () => {
    const rejection = new Error("provider fence active");
    const deps = createDependencies({
      withPrivilegedSandboxExecutionLease: <T>(
        sandboxName: string,
        operation: string,
        _fn: () => T,
      ): T => {
        expect(sandboxName).toBe("alpha");
        expect(operation).toBe("sandbox OpenShell command transport");
        throw rejection;
      },
    });

    expect(() => executeSandboxExecCommandTransport(deps, "alpha", "id", 9000, {})).toThrow(
      rejection,
    );
    expect(deps.buildSandboxExecMarkedCommand).not.toHaveBeenCalled();
    expect(deps.getOpenshellBinary).not.toHaveBeenCalled();
    expect(deps.privilegedSandboxExecArgv).not.toHaveBeenCalled();
    expect(deps.dockerSpawnSync).not.toHaveBeenCalled();
    expect(mocks.spawnSync).not.toHaveBeenCalled();
  });
});
