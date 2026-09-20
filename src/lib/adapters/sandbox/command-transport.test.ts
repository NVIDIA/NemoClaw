// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { OpenShellSandboxBufferedCommandExecutor } from "../openshell/sandbox-command";
import { namedOpenShellGateway } from "../openshell/sandbox-observer";

import {
  type CommandTransportDependencies,
  executeSandboxCommandTransport,
  executeSandboxExecCommandTransport,
} from "./command-transport";

function createDependencies(
  overrides: Partial<CommandTransportDependencies> = {},
): CommandTransportDependencies {
  return {
    buildSandboxExecMarkedCommand: vi.fn((command: string) => `marked:${command}`),
    buildSubprocessEnv: vi.fn(() => ({ PATH: "/usr/bin" })),
    sshExecutor: {
      run: vi.fn(async () => ({
        kind: "completed" as const,
        exitCode: 0,
        stdout: "ok\n",
        stderr: "",
      })),
    },
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
    ...overrides,
  };
}

describe("sandbox command transport", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("passes the recorded gateway, environment, and command timeout to typed SSH", async () => {
    const deps = createDependencies();
    const runtimeEnv = { PATH: "/pinned/bin" };
    expect(
      await executeSandboxCommandTransport(deps, "alpha", "openclaw doctor --fix", 300_000, {
        gatewayName: "recorded-gateway",
        runtimeEnv,
      }),
    ).toEqual({ status: 0, stdout: "ok", stderr: "" });
    expect(deps.sshExecutor?.run).toHaveBeenCalledWith({
      sandboxName: "alpha",
      target: namedOpenShellGateway("recorded-gateway"),
      command: "openclaw doctor --fix",
      environment: runtimeEnv,
      timeoutMilliseconds: 300_000,
    });
  });

  it.each([
    { result: { kind: "failed", reason: "configuration" }, expected: null },
    {
      result: { kind: "completed", exitCode: 9, stdout: " out\n", stderr: " err\n" },
      expected: { status: 9, stdout: "out", stderr: "err" },
    },
    {
      result: {
        kind: "failed",
        reason: "transport",
        command: { exitCode: 255, stdout: " out\n", stderr: " err\n" },
      },
      expected: { status: 255, stdout: "out", stderr: "err" },
    },
  ] as const)(
    "preserves the SSH command outcome $result without a Docker fallback",
    async ({ result, expected }) => {
      const deps = createDependencies({ sshExecutor: { run: vi.fn(async () => result) } });
      expect(await executeSandboxCommandTransport(deps, "alpha", "id")).toEqual(expected);
      expect(deps.executePrivilegedSandboxCommand).not.toHaveBeenCalled();
    },
  );

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
        localDockerFallbackPolicy: "never",
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

  it.each(["read-only", "reconciled"] as const)(
    "uses the %s fallback after an inconclusive completed result",
    async (localDockerFallbackPolicy) => {
      const deps = createDependencies({
        extractSandboxExecCommandStdout: vi.fn((output: string) =>
          output === "fallback-output" ? "fallback-ok" : null,
        ),
        commandExecutor: {
          runBuffered: vi.fn(async () => ({
            outcome: { kind: "completed" as const, exitCode: 1 },
            stdout: "unmarked-output",
            stderr: "",
          })),
        },
      });

      await expect(
        executeSandboxExecCommandTransport(deps, "alpha", "id", 9000, {
          localDockerFallbackPolicy,
        }),
      ).resolves.toEqual({ status: 0, stdout: "fallback-ok", stderr: "" });
      expect(deps.executePrivilegedSandboxCommand).toHaveBeenCalledOnce();
    },
  );

  it.each(["read-only", "reconciled"] as const)(
    "keeps a marked remote result final under the %s policy",
    async (localDockerFallbackPolicy) => {
      const deps = createDependencies();

      await expect(
        executeSandboxExecCommandTransport(deps, "alpha", "id", 9000, {
          localDockerFallbackPolicy,
        }),
      ).resolves.toEqual({ status: 0, stdout: "ok", stderr: "" });
      expect(deps.executePrivilegedSandboxCommand).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "unavailable-only", "read-only", "reconciled"] as const)(
    "uses the %s policy fallback when the OpenShell executable is unavailable",
    async (localDockerFallbackPolicy) => {
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
        executeSandboxExecCommandTransport(deps, "alpha", "id", 9000, {
          ...(localDockerFallbackPolicy ? { localDockerFallbackPolicy } : {}),
        }),
      ).resolves.toEqual({ status: 0, stdout: "fallback-output", stderr: "" });
      expect(deps.executePrivilegedSandboxCommand).toHaveBeenCalledOnce();
    },
  );

  it("does not use the never policy fallback when OpenShell is unavailable", async () => {
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
      executeSandboxExecCommandTransport(deps, "alpha", "id", 9000, {
        localDockerFallbackPolicy: "never",
      }),
    ).resolves.toBeNull();
    expect(deps.executePrivilegedSandboxCommand).not.toHaveBeenCalled();
  });

  it.each(["cancelled", "timeout", "capture", "invocation"] as const)(
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

  it.each([
    ["read-only", "timeout"],
    ["read-only", "capture"],
    ["read-only", "invocation"],
    ["reconciled", "timeout"],
    ["reconciled", "capture"],
    ["reconciled", "invocation"],
  ] as const)(
    "uses the %s fallback after a typed %s failure with an unknown outcome",
    async (localDockerFallbackPolicy, kind) => {
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
        executeSandboxExecCommandTransport(deps, "alpha", "id", 9000, {
          localDockerFallbackPolicy,
        }),
      ).resolves.toEqual({ status: 0, stdout: "fallback-output", stderr: "" });
      expect(deps.executePrivilegedSandboxCommand).toHaveBeenCalledOnce();
    },
  );

  it.each(["read-only", "reconciled"] as const)(
    "does not use the %s fallback after cancellation",
    async (localDockerFallbackPolicy) => {
      const deps = createDependencies({
        commandExecutor: {
          runBuffered: vi.fn(async () => ({
            outcome: {
              kind: "failed" as const,
              error: { kind: "cancelled" as const, message: "cancelled by SIGINT" },
            },
            stdout: "partial",
            stderr: "",
          })),
        },
      });

      await expect(
        executeSandboxExecCommandTransport(deps, "alpha", "id", 9000, {
          localDockerFallbackPolicy,
        }),
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

    await expect(
      executeSandboxExecCommandTransport(deps, "alpha", "id", 9000, {
        localDockerFallbackPolicy: "read-only",
      }),
    ).rejects.toBe(refusal);
    expect(deps.executePrivilegedSandboxCommand).not.toHaveBeenCalled();
  });

  it("propagates a local Docker identity refusal after an eligible fallback", async () => {
    const refusal = new Error("sandbox identity changed");
    const deps = createDependencies({
      executePrivilegedSandboxCommand: vi.fn(() => {
        throw refusal;
      }),
      commandExecutor: {
        runBuffered: vi.fn(async () => ({
          outcome: {
            kind: "failed" as const,
            error: { kind: "timeout" as const, message: "OpenShell command timed out" },
          },
          stdout: "",
          stderr: "",
        })),
      },
    });

    await expect(
      executeSandboxExecCommandTransport(deps, "alpha", "id", 9000, {
        localDockerFallbackPolicy: "read-only",
      }),
    ).rejects.toBe(refusal);
    expect(deps.isDirectSandboxFallbackUnavailableError).toHaveBeenCalledWith(refusal);
  });
});
