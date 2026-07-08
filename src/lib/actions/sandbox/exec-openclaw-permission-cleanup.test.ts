// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import {
  cleanupFailureMessage,
  runSandboxExecChild,
  runSandboxExecCommand,
  type SandboxExecChild,
  type SandboxExecCleanupDeps,
  type SandboxExecSignalSource,
} from "./exec";

const HEALTHY_MUTABLE_CONFIG = {
  applies: true as const,
  ok: true,
  dirMode: "2770",
  dirOwner: "sandbox:sandbox",
  fileMode: "660",
  fileOwner: "sandbox:sandbox",
  configDir: "/sandbox/.openclaw",
  configFile: "openclaw.json",
  issues: [],
};

const TIGHTENED_MUTABLE_CONFIG = {
  ...HEALTHY_MUTABLE_CONFIG,
  ok: false,
  dirMode: "700",
  fileMode: "600",
  issues: [
    "/sandbox/.openclaw mode 700 (expected 2770 setgid+group-writable)",
    "openclaw.json mode 600 (expected 660 group-writable)",
  ],
};

function cleanupDeps(overrides: Partial<SandboxExecCleanupDeps> = {}): SandboxExecCleanupDeps {
  return {
    getSandbox: () => ({ agent: "openclaw" }),
    inspectMutableConfigPerms: () => HEALTHY_MUTABLE_CONFIG,
    repairMutableConfigPerms: () => ({ applied: true, verified: true, errors: [] }),
    ...overrides,
  };
}

describe("runSandboxExecCommand mutable OpenClaw cleanup (#6047)", () => {
  it("preserves a nonzero command status when the mutable contract is already healthy", async () => {
    const repair = vi.fn(() => ({ applied: true as const, verified: true, errors: [] }));
    const completion = await runSandboxExecCommand(
      "openshell",
      "alpha",
      ["false"],
      {},
      () => ({ status: 42 }),
      cleanupDeps({ repairMutableConfigPerms: repair }),
    );

    expect(completion).toEqual({ code: 42, commandCode: 42 });
    expect(repair).not.toHaveBeenCalled();
  });

  it("repairs a tightened tree after the command, re-inspects it, and preserves status 42", async () => {
    const order: string[] = [];
    const inspect = vi
      .fn<SandboxExecCleanupDeps["inspectMutableConfigPerms"]>()
      .mockImplementationOnce(() => {
        order.push("inspect-before");
        return TIGHTENED_MUTABLE_CONFIG;
      })
      .mockImplementationOnce(() => {
        order.push("inspect-after");
        return HEALTHY_MUTABLE_CONFIG;
      });
    const repair = vi.fn(() => {
      order.push("repair");
      return { applied: true as const, verified: true, errors: [] };
    });

    const completion = await runSandboxExecCommand(
      "openshell",
      "alpha",
      ["bash", "-c", "openclaw doctor --fix"],
      {},
      () => {
        order.push("command");
        return { status: 42 };
      },
      cleanupDeps({ inspectMutableConfigPerms: inspect, repairMutableConfigPerms: repair }),
    );

    expect(completion).toEqual({ code: 42, commandCode: 42 });
    expect(order).toEqual(["command", "inspect-before", "repair", "inspect-after"]);
  });

  it("lets cleanup failure override status 42 and reports both statuses", async () => {
    const completion = await runSandboxExecCommand(
      "openshell",
      "alpha",
      ["false"],
      {},
      () => ({ status: 42 }),
      cleanupDeps({
        inspectMutableConfigPerms: () => TIGHTENED_MUTABLE_CONFIG,
        repairMutableConfigPerms: () => ({
          applied: true,
          verified: false,
          errors: ["chmod denied"],
        }),
      }),
    );

    expect(completion).toMatchObject({ code: 1, commandCode: 42 });
    expect(completion.cleanupError).toContain("chmod denied");
    expect(cleanupFailureMessage(completion.commandCode, completion.cleanupError || "")).toContain(
      "command exit 42; cleanup exit 1",
    );
  });

  it("treats an active shields lock as a benign cleanup skip", async () => {
    const inspect = vi.fn(() => ({
      applies: false as const,
      skipReason: "locked" as const,
      reason: "shields up (config intentionally locked)",
    }));
    const repair = vi.fn(() => ({
      applied: false as const,
      skipReason: "locked" as const,
      reason: "shields are up (config is locked); refusing to weaken permissions",
    }));

    const completion = await runSandboxExecCommand(
      "openshell",
      "alpha",
      ["true"],
      {},
      () => ({ status: 0 }),
      cleanupDeps({ inspectMutableConfigPerms: inspect, repairMutableConfigPerms: repair }),
    );

    expect(completion).toEqual({ code: 0, commandCode: 0 });
    expect(repair).toHaveBeenCalledOnce();
  });

  it.each([
    ["Hermes", { agent: "hermes" }],
    ["a custom agent", { agent: "langchain-deepagents-code" }],
    ["an unregistered sandbox", null],
  ])("does not apply OpenClaw cleanup to %s", async (_label, entry) => {
    const inspect = vi.fn(() => HEALTHY_MUTABLE_CONFIG);
    const repair = vi.fn(() => ({ applied: true as const, verified: true, errors: [] }));

    const completion = await runSandboxExecCommand(
      "openshell",
      "alpha",
      ["true"],
      {},
      () => ({ status: 0 }),
      cleanupDeps({
        getSandbox: () => entry,
        inspectMutableConfigPerms: inspect,
        repairMutableConfigPerms: repair,
      }),
    );

    expect(completion).toEqual({ code: 0, commandCode: 0 });
    expect(inspect).not.toHaveBeenCalled();
    expect(repair).not.toHaveBeenCalled();
  });

  it("still verifies cleanup after an OpenShell transport failure", async () => {
    const inspect = vi.fn(() => HEALTHY_MUTABLE_CONFIG);
    const completion = await runSandboxExecCommand(
      "openshell",
      "alpha",
      ["true"],
      {},
      () => ({ status: null, error: new Error("ENOENT") }),
      cleanupDeps({ inspectMutableConfigPerms: inspect }),
    );

    expect(completion).toEqual({ code: 1, commandCode: 1, invocationError: "ENOENT" });
    expect(inspect).toHaveBeenCalledOnce();
  });

  it("reports registry read failure as cleanup failure after the command", async () => {
    const inspect = vi.fn(() => HEALTHY_MUTABLE_CONFIG);
    const completion = await runSandboxExecCommand(
      "openshell",
      "alpha",
      ["false"],
      {},
      () => ({ status: 42 }),
      cleanupDeps({
        getSandbox: () => {
          throw new Error("invalid registry JSON");
        },
        inspectMutableConfigPerms: inspect,
      }),
    );

    expect(completion).toMatchObject({ code: 1, commandCode: 42 });
    expect(completion.cleanupError).toContain("sandbox registry lookup failed");
    expect(completion.cleanupError).toContain("invalid registry JSON");
    expect(inspect).not.toHaveBeenCalled();
  });

  it("forwards TERM to the direct child, reaps it, and still runs cleanup", async () => {
    const signal = "SIGTERM" as const;
    const code = 143;
    const childEvents = new EventEmitter();
    const signalEvents = new EventEmitter();
    const order: string[] = [];
    const child: SandboxExecChild = {
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
        childEvents.once(event, listener)) as SandboxExecChild["once"],
    };
    const signalSource: SandboxExecSignalSource = {
      add: (name, listener) => signalEvents.on(name, listener),
      remove: (name, listener) => signalEvents.off(name, listener),
    };
    const inspect = vi.fn(() => {
      order.push("cleanup");
      expect(signalEvents.listenerCount(signal)).toBe(1);
      signalEvents.emit(signal);
      return HEALTHY_MUTABLE_CONFIG;
    });

    const pending = runSandboxExecCommand(
      "openshell",
      "alpha",
      ["sleep", "30"],
      {},
      (binary, args) => runSandboxExecChild(binary, args, {}, () => child, signalSource),
      cleanupDeps({ inspectMutableConfigPerms: inspect }),
    );
    signalEvents.emit(signal);
    const completion = await pending;

    expect(completion).toEqual({ code, commandCode: code });
    expect(child.kill).toHaveBeenCalledWith(signal);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(order).toEqual([`kill:${signal}`, "close", "cleanup"]);
    expect(signalEvents.listenerCount("SIGTERM")).toBe(0);
    expect(signalEvents.listenerCount("SIGINT")).toBe(0);
  });

  it("does not deliver a second SIGINT when the terminal already signals the child", async () => {
    const childEvents = new EventEmitter();
    const signalEvents = new EventEmitter();
    const child: SandboxExecChild = {
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
      once: ((event: string, listener: (...args: unknown[]) => void) =>
        childEvents.once(event, listener)) as SandboxExecChild["once"],
    };
    const signalSource: SandboxExecSignalSource = {
      add: (name, listener) => signalEvents.on(name, listener),
      remove: (name, listener) => signalEvents.off(name, listener),
    };
    const inspect = vi.fn(() => {
      expect(signalEvents.listenerCount("SIGINT")).toBe(1);
      signalEvents.emit("SIGINT");
      return HEALTHY_MUTABLE_CONFIG;
    });

    const pending = runSandboxExecCommand(
      "openshell",
      "alpha",
      ["sleep", "30"],
      {},
      (binary, args) => runSandboxExecChild(binary, args, {}, () => child, signalSource),
      cleanupDeps({ inspectMutableConfigPerms: inspect }),
    );
    signalEvents.emit("SIGINT");
    child.signalCode = "SIGINT";
    childEvents.emit("close", null, "SIGINT");
    const completion = await pending;

    expect(completion).toEqual({ code: 130, commandCode: 130 });
    expect(child.kill).not.toHaveBeenCalled();
    expect(inspect).toHaveBeenCalledOnce();
    expect(signalEvents.listenerCount("SIGINT")).toBe(0);
  });

  it("fails when post-repair inspection cannot prove the contract", async () => {
    const inspect = vi
      .fn<SandboxExecCleanupDeps["inspectMutableConfigPerms"]>()
      .mockReturnValueOnce(TIGHTENED_MUTABLE_CONFIG)
      .mockReturnValueOnce({
        applies: false,
        skipReason: "unavailable",
        reason: "could not stat config (container stopped)",
      });

    const completion = await runSandboxExecCommand(
      "openshell",
      "alpha",
      ["true"],
      {},
      () => ({ status: 0 }),
      cleanupDeps({ inspectMutableConfigPerms: inspect }),
    );

    expect(completion).toMatchObject({ code: 1, commandCode: 0 });
    expect(completion.cleanupError).toContain("post-repair permission verification unavailable");
  });

  it("accepts shields becoming locked between repair and re-inspection", async () => {
    const inspect = vi
      .fn<SandboxExecCleanupDeps["inspectMutableConfigPerms"]>()
      .mockReturnValueOnce(TIGHTENED_MUTABLE_CONFIG)
      .mockReturnValueOnce({
        applies: false,
        skipReason: "locked",
        reason: "shields up (config intentionally locked)",
      });

    const completion = await runSandboxExecCommand(
      "openshell",
      "alpha",
      ["false"],
      {},
      () => ({ status: 42 }),
      cleanupDeps({ inspectMutableConfigPerms: inspect }),
    );

    expect(completion).toEqual({ code: 42, commandCode: 42 });
    expect(inspect).toHaveBeenCalledTimes(2);
  });
});
