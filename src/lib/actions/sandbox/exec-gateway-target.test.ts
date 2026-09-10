// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createCliOpenShellSandboxCommandExecutor,
  type OpenShellCommandChild,
  type OpenShellCommandSpawner,
} from "../../adapters/openshell/sandbox-command-cli";
import type { OpenShellSandboxCommandExecutor } from "../../adapters/openshell/sandbox-command";
import { execSandbox, type SandboxExecCleanupDeps } from "./exec";

function commandExecutor(options: {
  run?: OpenShellSandboxCommandExecutor["runStreaming"];
  probe?: OpenShellSandboxCommandExecutor["probeDirectory"];
}): OpenShellSandboxCommandExecutor {
  return {
    probeDirectory: options.probe ?? (async () => ({ state: "present" })),
    runStreaming:
      options.run ??
      (async () => ({
        outcome: { kind: "completed", exitCode: 0 },
        release: () => {},
      })),
  };
}

const cleanupSkipped: SandboxExecCleanupDeps = {
  getSandbox: () => null,
  inspectMutableConfigPerms: (() => {
    throw new Error("cleanup should be skipped");
  }) as unknown as SandboxExecCleanupDeps["inspectMutableConfigPerms"],
  repairMutableConfigPerms: (() => {
    throw new Error("cleanup should be skipped");
  }) as unknown as SandboxExecCleanupDeps["repairMutableConfigPerms"],
};

describe("execSandbox gateway targeting", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("selects the sandbox's owning gateway before dispatching the exec", async () => {
    const order: string[] = [];
    const selectGateway = vi.fn((name: string) => {
      order.push(`select:${name}`);
      return { outcome: "selected" as const, gatewayName: name };
    });
    const run = vi.fn<OpenShellSandboxCommandExecutor["runStreaming"]>(async () => {
      order.push("run");
      return { outcome: { kind: "completed", exitCode: 0 }, release: () => {} };
    });
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code ?? 0}__`);
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      execSandbox(
        "beta",
        ["hostname"],
        {},
        {
          selectGateway,
          commandExecutor: commandExecutor({ run }),
          cleanupDeps: cleanupSkipped,
          policyHint: {
            now: () => 0,
            env: {},
            probeLogs: () => "",
            enableAudit: () => {},
            sleep: async () => {},
            attempts: 1,
            writeStderr: () => {},
          },
        },
      ),
    ).rejects.toThrow("__exit_0__");

    expect(selectGateway).toHaveBeenCalledWith("beta");
    expect(run).toHaveBeenCalled();
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      sandboxName: "beta",
      target: { kind: "named", gatewayName: "beta" },
    });
    expect(run.mock.calls[0]?.[0].command.at(-2)).toBe("nemoclaw-runtime-env");
    expect(run.mock.calls[0]?.[0].command.at(-1)).toBe("hostname");
    expect(order.indexOf("select:beta")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("select:beta")).toBeLessThan(order.indexOf("run"));
  });

  it("selects the owning gateway before the workdir probe when a workdir is set", async () => {
    const order: string[] = [];
    vi.stubEnv("OPENSHELL_GATEWAY", "ambient-sibling");
    const selectGateway = vi.fn((name: string) => {
      order.push(`select:${name}`);
      process.env.OPENSHELL_GATEWAY = "drifted-sibling";
      return { outcome: "selected" as const, gatewayName: "nemoclaw-8091" };
    });
    const probeWorkdir = vi.fn<OpenShellSandboxCommandExecutor["probeDirectory"]>(async () => {
      order.push("probe");
      return { state: "present" };
    });
    const run = vi.fn<OpenShellSandboxCommandExecutor["runStreaming"]>(async () => {
      order.push("run");
      return { outcome: { kind: "completed", exitCode: 0 }, release: () => {} };
    });
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code ?? 0}__`);
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      execSandbox(
        "beta",
        ["hostname"],
        { workdir: "/work" },
        {
          selectGateway,
          commandExecutor: commandExecutor({ probe: probeWorkdir, run }),
          cleanupDeps: cleanupSkipped,
          policyHint: {
            now: () => 0,
            env: {},
            probeLogs: () => "",
            enableAudit: () => {},
            sleep: async () => {},
            attempts: 1,
            writeStderr: () => {},
          },
        },
      ),
    ).rejects.toThrow("__exit_0__");

    expect(order).toEqual(["select:beta", "probe", "run"]);
    expect(process.env.OPENSHELL_GATEWAY).toBe("drifted-sibling");
    expect(probeWorkdir).toHaveBeenCalledWith({
      sandboxName: "beta",
      target: { kind: "named", gatewayName: "nemoclaw-8091" },
      path: "/work",
    });
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      sandboxName: "beta",
      target: { kind: "named", gatewayName: "nemoclaw-8091" },
      workdir: "/work",
    });
    expect(run.mock.calls[0]?.[0].command.at(-2)).toBe("nemoclaw-runtime-env");
    expect(run.mock.calls[0]?.[0].command.at(-1)).toBe("hostname");
  });

  it("carries the selected gateway through the CLI workdir probe and command dispatch", async () => {
    const spawnProbe = vi.fn(() => ({ status: 0 }));
    const child = {
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
      once: vi.fn((event: "error" | "close", listener: (...args: unknown[]) => void) => {
        const notify = {
          error: () => undefined,
          close: () => queueMicrotask(() => listener(0, null)),
        }[event];
        notify();
        return child;
      }),
    } as unknown as OpenShellCommandChild;
    const spawnChild = vi.fn<OpenShellCommandSpawner>(() => child);
    const executor = createCliOpenShellSandboxCommandExecutor({
      resolveBinary: () => "/usr/bin/openshell",
      spawnProbe,
      spawnChild,
    });
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code ?? 0}__`);
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      execSandbox(
        "beta",
        ["hostname"],
        { workdir: "/work" },
        {
          selectGateway: () => ({
            outcome: "selected",
            gatewayName: "nemoclaw-8091",
          }),
          commandExecutor: executor,
          cleanupDeps: cleanupSkipped,
          policyHint: {
            now: () => 0,
            env: {},
            probeLogs: () => "",
            enableAudit: () => {},
            sleep: async () => {},
            attempts: 1,
            writeStderr: () => {},
          },
        },
      ),
    ).rejects.toThrow("__exit_0__");

    expect(spawnProbe).toHaveBeenCalledWith("/usr/bin/openshell", [
      "sandbox",
      "exec",
      "--name",
      "beta",
      "-g",
      "nemoclaw-8091",
      "--",
      "test",
      "-d",
      "/work",
    ]);
    expect(spawnChild.mock.calls[0]?.[0]).toBe("/usr/bin/openshell");
    const execArgs = spawnChild.mock.calls[0]?.[1];
    expect(execArgs?.slice(0, 9)).toEqual([
      "sandbox",
      "exec",
      "--name",
      "beta",
      "-g",
      "nemoclaw-8091",
      "--workdir",
      "/work",
      "--",
    ]);
    expect(execArgs?.at(-1)).toBe("hostname");
  });

  it("reports a rejected workdir probe as a normal invocation failure", async () => {
    const resolveBinary = vi.fn(() => "/usr/bin/openshell");
    const spawnProbe = vi.fn();
    const spawnChild = vi.fn();
    const executor = createCliOpenShellSandboxCommandExecutor({
      resolveBinary,
      spawnProbe,
      spawnChild,
    });
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code ?? 0}__`);
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      execSandbox(
        "invalid/name",
        ["hostname"],
        { workdir: "/work" },
        {
          selectGateway: () => ({ outcome: "unregistered", gatewayName: null }),
          commandExecutor: executor,
          cleanupDeps: cleanupSkipped,
        },
      ),
    ).rejects.toThrow("__exit_1__");

    expect(console.error).toHaveBeenCalledWith(
      "  Failed to invoke openshell: Invalid OpenShell sandbox name",
    );
    expect(resolveBinary).not.toHaveBeenCalled();
    expect(spawnProbe).not.toHaveBeenCalled();
    expect(spawnChild).not.toHaveBeenCalled();
  });

  it("rejects a direct endpoint override before selecting, probing, or dispatching", async () => {
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://sibling.invalid");
    const selectGateway = vi.fn();
    const probeWorkdir = vi.fn();
    const run = vi.fn();
    const executor = commandExecutor({ probe: probeWorkdir, run });
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code ?? 0}__`);
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      execSandbox(
        "beta",
        ["hostname"],
        { workdir: "/work" },
        { commandExecutor: executor, selectGateway },
      ),
    ).rejects.toThrow("__exit_1__");

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("OPENSHELL_GATEWAY_ENDPOINT is set"),
    );
    expect(selectGateway).not.toHaveBeenCalled();
    expect(probeWorkdir).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps post-exec policy probes pinned after ambient gateway selection drifts", async () => {
    vi.stubEnv("OPENSHELL_GATEWAY", "ambient-sibling");
    const enableAudit = vi.fn();
    const probeLogs = vi.fn(() => "");
    const selectGateway = vi.fn(() => {
      process.env.OPENSHELL_GATEWAY = "drifted-sibling";
      return { outcome: "selected" as const, gatewayName: "nemoclaw-8091" };
    });
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code ?? 0}__`);
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      execSandbox(
        "beta",
        ["curl", "https://example.invalid"],
        {},
        {
          selectGateway,
          commandExecutor: commandExecutor({
            run: async () => ({
              outcome: { kind: "completed", exitCode: 56 },
              release: () => {},
            }),
          }),
          cleanupDeps: cleanupSkipped,
          policyHint: {
            now: () => 0,
            env: {},
            enableAudit,
            probeLogs,
            attempts: 1,
            sleep: async () => {},
            writeStderr: () => {},
          },
        },
      ),
    ).rejects.toThrow("__exit_56__");

    expect(process.env.OPENSHELL_GATEWAY).toBe("drifted-sibling");
    expect(enableAudit).toHaveBeenCalledWith("beta", "nemoclaw-8091");
    expect(probeLogs).toHaveBeenCalledWith("beta", "nemoclaw-8091");
  });

  it("aborts before the workdir probe and exec when gateway selection fails", async () => {
    const order: string[] = [];
    const selectGateway = vi.fn(() => {
      order.push("select");
      return { outcome: "failed" as const, gatewayName: "nemoclaw-8091" };
    });
    const probeWorkdir = vi.fn<OpenShellSandboxCommandExecutor["probeDirectory"]>(async () => {
      order.push("probe");
      return { state: "present" };
    });
    const run = vi.fn<OpenShellSandboxCommandExecutor["runStreaming"]>(async () => {
      order.push("run");
      return { outcome: { kind: "completed", exitCode: 0 }, release: () => {} };
    });
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code ?? 0}__`);
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      execSandbox(
        "beta",
        ["hostname"],
        { workdir: "/work" },
        {
          selectGateway,
          commandExecutor: commandExecutor({ probe: probeWorkdir, run }),
          cleanupDeps: cleanupSkipped,
        },
      ),
    ).rejects.toThrow("__exit_1__");

    expect(order).toEqual(["select"]);
    expect(probeWorkdir).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
});
