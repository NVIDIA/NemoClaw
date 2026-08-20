// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  connectModulePath,
  createConnectHarness,
  requireDist,
} from "../../../../test/support/connect-flow-test-harness";

describe("connectSandbox lifecycle lock", () => {
  const originalStdoutIsTty = process.stdout.isTTY;

  beforeEach(() => {
    process.env.NEMOCLAW_TEST_NO_SLEEP = "1";
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: originalStdoutIsTty,
    });
    delete process.env.NEMOCLAW_TEST_NO_SLEEP;
    delete require.cache[requireDist.resolve(connectModulePath)];
  });

  it("releases the lifecycle lock before waiting on the interactive shell (#9737)", async () => {
    const harness = createConnectHarness();
    const gatewayState = requireDist(
      "../../src/lib/actions/sandbox/gateway-state.js",
    ) as typeof import("./gateway-state");
    let lockDepth = 0;
    let lockEntries = 0;
    vi.mocked(gatewayState.withConnectSandboxLifecycleLock).mockImplementation((async (
      _sandboxName: string,
      operation: () => Promise<unknown>,
    ) => {
      lockEntries += 1;
      lockDepth += 1;
      try {
        return await operation();
      } finally {
        lockDepth -= 1;
      }
    }) as never);
    harness.ensureLiveSandboxSpy.mockImplementation(async () => {
      expect(lockDepth).toBeGreaterThan(0);
      return { state: "present", output: "Name: alpha\nPhase: Ready\n" };
    });
    let childStarted!: () => void;
    const childStarting = new Promise<void>((resolve) => {
      childStarted = resolve;
    });
    let completeChild!: (result: { status: number; signal: null }) => void;
    const childCompletion = new Promise<{ status: number; signal: null }>((resolve) => {
      completeChild = resolve;
    });
    harness.runSandboxExecChildSpy.mockImplementation(() => {
      expect(lockDepth).toBeGreaterThan(0);
      childStarted();
      return childCompletion;
    });

    const connect = harness.connectSandbox("alpha");
    await childStarting;
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(lockEntries).toBeGreaterThan(0);
    expect(lockDepth).toBe(0);
    let contenderEntered = false;
    await gatewayState.withConnectSandboxLifecycleLock("alpha", async () => {
      contenderEntered = true;
      expect(lockDepth).toBe(1);
    });
    expect(contenderEntered).toBe(true);
    completeChild({ status: 0, signal: null });
    await expect(connect).rejects.toThrow("process.exit(0)");
  });
});
