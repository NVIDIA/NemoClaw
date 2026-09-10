// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ProcessSessionChild, ProcessSessionSignals } from "../../core/process-session";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { createCliOpenShellSandboxCommandExecutor } from "../../adapters/openshell/sandbox-command-cli";
import type {
  OpenShellSandboxCommandExecutor,
  OpenShellSandboxCommandOutcome,
} from "../../adapters/openshell/sandbox-command";
import { execSandbox, type SandboxExecCleanupDeps } from "./exec";

const HEALTHY_MUTABLE_CONFIG = {
  applies: true as const,
  ok: true,
  issues: [],
};

const TIGHTENED_MUTABLE_CONFIG = {
  ...HEALTHY_MUTABLE_CONFIG,
  ok: false,
  issues: ["OpenClaw config mode differs from runtime contract"],
};

function cleanupDeps(overrides: Partial<SandboxExecCleanupDeps> = {}): SandboxExecCleanupDeps {
  return {
    getSandbox: () => ({ agent: "openclaw" }),
    inspectMutableConfigPerms: () => HEALTHY_MUTABLE_CONFIG,
    repairMutableConfigPerms: () => ({ applied: true, verified: true, errors: [] }),
    ...overrides,
  };
}

async function runExecCase(options: {
  cleanupDeps: SandboxExecCleanupDeps;
  command?: readonly string[];
  executor?: OpenShellSandboxCommandExecutor;
  onRun?: () => void;
  outcome?: OpenShellSandboxCommandOutcome;
  release?: () => void;
}): Promise<{ exitCode: number; stderr: string[] }> {
  const exitSignal = new Error("__exec_exit__");
  const stderr: string[] = [];
  let exitCode = Number.NaN;
  const executor =
    options.executor ??
    ({
      probeDirectory: async () => ({ state: "present" }),
      runStreaming: async () => {
        options.onRun?.();
        return {
          outcome: options.outcome ?? { kind: "completed", exitCode: 0 },
          release: options.release ?? (() => {}),
        };
      },
    } satisfies OpenShellSandboxCommandExecutor);
  const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    stderr.push(args.map(String).join(" "));
  });

  try {
    await execSandbox(
      "alpha",
      options.command ?? ["true"],
      {},
      {
        selectGateway: () => ({ outcome: "unregistered", gatewayName: null }),
        commandExecutor: executor,
        cleanupDeps: options.cleanupDeps,
        policyHint: {
          now: () => 0,
          env: {},
          probeLogs: () => "",
          enableAudit: () => {},
          sleep: async () => {},
          attempts: 1,
          writeStderr: () => {},
        },
        exit: ((code: number) => {
          exitCode = code;
          throw exitSignal;
        }) as (code: number) => never,
      },
    );
    throw new Error("execSandbox returned without exiting");
  } catch (error) {
    expect(error).toBe(exitSignal);
  } finally {
    errorSpy.mockRestore();
  }
  return { exitCode, stderr };
}

describe("execSandbox mutable OpenClaw cleanup (#6047)", () => {
  it("preserves a nonzero command status when the mutable contract is already healthy", async () => {
    const repair = vi.fn(() => ({ applied: true as const, verified: true, errors: [] }));
    const release = vi.fn();
    const result = await runExecCase({
      command: ["false"],
      outcome: { kind: "completed", exitCode: 42 },
      cleanupDeps: cleanupDeps({ repairMutableConfigPerms: repair }),
      release,
    });

    expect(result.exitCode).toBe(42);
    expect(repair).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it("repairs a drifted tree after the command and preserves status 42 after verified repair", async () => {
    const order: string[] = [];
    const inspect = vi
      .fn<SandboxExecCleanupDeps["inspectMutableConfigPerms"]>()
      .mockImplementationOnce(() => {
        order.push("inspect-before");
        return TIGHTENED_MUTABLE_CONFIG;
      });
    const repair = vi.fn(() => {
      order.push("repair");
      return { applied: true as const, verified: true, errors: [] };
    });

    const result = await runExecCase({
      command: ["bash", "-c", "openclaw doctor --fix"],
      outcome: { kind: "completed", exitCode: 42 },
      onRun: () => order.push("command"),
      cleanupDeps: cleanupDeps({
        inspectMutableConfigPerms: inspect,
        repairMutableConfigPerms: repair,
      }),
      release: () => order.push("release"),
    });

    expect(result.exitCode).toBe(42);
    expect(order).toEqual(["command", "inspect-before", "repair", "release"]);
  });

  it("lets cleanup failure override status 42 and reports both statuses", async () => {
    const order: string[] = [];
    const result = await runExecCase({
      command: ["false"],
      outcome: { kind: "completed", exitCode: 42 },
      cleanupDeps: cleanupDeps({
        inspectMutableConfigPerms: () => TIGHTENED_MUTABLE_CONFIG,
        repairMutableConfigPerms: () => {
          order.push("repair");
          return { applied: true, verified: false, errors: ["chmod denied"] };
        },
      }),
      release: () => order.push("release"),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.join("\n")).toContain("command exit 42; cleanup exit 1");
    expect(result.stderr.join("\n")).toContain("chmod denied");
    expect(order).toEqual(["repair", "release"]);
  });

  it.each([
    ["Hermes", { agent: "hermes" }],
    ["a custom agent", { agent: "langchain-deepagents-code" }],
    ["an unregistered sandbox", null],
  ])("does not apply OpenClaw cleanup to %s", async (_label, entry) => {
    const inspect = vi.fn(() => HEALTHY_MUTABLE_CONFIG);
    const repair = vi.fn(() => ({ applied: true as const, verified: true, errors: [] }));

    const result = await runExecCase({
      outcome: { kind: "completed", exitCode: 0 },
      cleanupDeps: cleanupDeps({
        getSandbox: () => entry,
        inspectMutableConfigPerms: inspect,
        repairMutableConfigPerms: repair,
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(inspect).not.toHaveBeenCalled();
    expect(repair).not.toHaveBeenCalled();
  });

  it("still verifies cleanup after an OpenShell transport failure", async () => {
    const inspect = vi.fn(() => HEALTHY_MUTABLE_CONFIG);
    const release = vi.fn();
    const result = await runExecCase({
      outcome: { kind: "failed", error: { kind: "unavailable", message: "ENOENT" } },
      cleanupDeps: cleanupDeps({ inspectMutableConfigPerms: inspect }),
      release,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.join("\n")).toContain("Failed to invoke openshell: ENOENT");
    expect(inspect).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("reports registry read failure as cleanup failure after the command", async () => {
    const inspect = vi.fn(() => HEALTHY_MUTABLE_CONFIG);
    const result = await runExecCase({
      command: ["false"],
      outcome: { kind: "completed", exitCode: 42 },
      cleanupDeps: cleanupDeps({
        getSandbox: () => {
          throw new Error("invalid registry JSON");
        },
        inspectMutableConfigPerms: inspect,
      }),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.join("\n")).toContain("sandbox registry lookup failed");
    expect(result.stderr.join("\n")).toContain("invalid registry JSON");
    expect(inspect).not.toHaveBeenCalled();
  });

  it("forwards TERM to the direct child, reaps it, and still runs cleanup", async () => {
    const signal = "SIGTERM" as const;
    const code = 143;
    const childEvents = new EventEmitter();
    const signalEvents = new EventEmitter();
    const order: string[] = [];
    const child: ProcessSessionChild = {
      exitCode: null,
      signalCode: null,
      kill: vi.fn((receivedSignal) => {
        order.push(`kill:${receivedSignal}`);
        child.signalCode = receivedSignal;
        queueMicrotask(() => {
          order.push("close");
          childEvents.emit("close", null, receivedSignal);
        });
        return true;
      }),
      once: ((event: string, listener: (...args: unknown[]) => void) =>
        childEvents.once(event, listener)) as ProcessSessionChild["once"],
    };
    const signalSource: ProcessSessionSignals = {
      add: (name, listener) => signalEvents.on(name, listener),
      remove: (name, listener) => {
        const recordRelease = {
          SIGTERM: () => order.push("release"),
          SIGINT: () => undefined,
        }[name];
        recordRelease();
        signalEvents.off(name, listener);
      },
    };
    const inspect = vi.fn(() => {
      order.push("cleanup");
      expect(signalEvents.listenerCount(signal)).toBe(1);
      signalEvents.emit(signal);
      return HEALTHY_MUTABLE_CONFIG;
    });

    const executor = createCliOpenShellSandboxCommandExecutor({
      resolveBinary: () => "openshell",
      spawnChild: () => child,
      signalSource,
    });
    const pending = runExecCase({
      command: ["sleep", "30"],
      executor,
      cleanupDeps: cleanupDeps({ inspectMutableConfigPerms: inspect }),
    });
    signalEvents.emit(signal);
    const result = await pending;

    expect(result.exitCode).toBe(code);
    expect(child.kill).toHaveBeenCalledWith(signal);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(order).toEqual([`kill:${signal}`, "close", "cleanup", "release"]);
    expect(signalEvents.listenerCount("SIGTERM")).toBe(0);
    expect(signalEvents.listenerCount("SIGINT")).toBe(0);
  });

  it("does not deliver a second SIGINT when the terminal already signals the child", async () => {
    const childEvents = new EventEmitter();
    const signalEvents = new EventEmitter();
    const child: ProcessSessionChild = {
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
      once: ((event: string, listener: (...args: unknown[]) => void) =>
        childEvents.once(event, listener)) as ProcessSessionChild["once"],
    };
    const signalSource: ProcessSessionSignals = {
      add: (name, listener) => signalEvents.on(name, listener),
      remove: (name, listener) => signalEvents.off(name, listener),
    };
    const inspect = vi.fn(() => {
      expect(signalEvents.listenerCount("SIGINT")).toBe(1);
      signalEvents.emit("SIGINT");
      return HEALTHY_MUTABLE_CONFIG;
    });

    const executor = createCliOpenShellSandboxCommandExecutor({
      resolveBinary: () => "openshell",
      spawnChild: () => child,
      signalSource,
    });
    const pending = runExecCase({
      command: ["sleep", "30"],
      executor,
      cleanupDeps: cleanupDeps({ inspectMutableConfigPerms: inspect }),
    });
    signalEvents.emit("SIGINT");
    child.signalCode = "SIGINT";
    childEvents.emit("close", null, "SIGINT");
    const result = await pending;

    expect(result.exitCode).toBe(130);
    expect(child.kill).not.toHaveBeenCalled();
    expect(inspect).toHaveBeenCalledOnce();
    expect(signalEvents.listenerCount("SIGINT")).toBe(0);
  });

  it("refuses repair when inspection cannot prove the contract", async () => {
    const inspect = vi
      .fn<SandboxExecCleanupDeps["inspectMutableConfigPerms"]>()
      .mockReturnValueOnce({
        applies: false,
        skipReason: "unavailable",
        reason: "startup-not-ready",
      });
    const repair = vi.fn();

    const result = await runExecCase({
      outcome: { kind: "completed", exitCode: 0 },
      cleanupDeps: cleanupDeps({
        inspectMutableConfigPerms: inspect,
        repairMutableConfigPerms: repair,
      }),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.join("\n")).toContain(
      "permission inspection unavailable: startup-not-ready",
    );
    expect(repair).not.toHaveBeenCalled();
  });
});
