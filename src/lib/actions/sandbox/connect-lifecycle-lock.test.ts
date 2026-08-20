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
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
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
    harness.runSandboxExecChildSpy.mockImplementation(async () => {
      expect(lockDepth).toBe(0);
      return { status: 0, signal: null };
    });

    await expect(harness.connectSandbox("alpha")).rejects.toThrow("process.exit(0)");

    expect(lockEntries).toBeGreaterThan(0);
    expect(lockDepth).toBe(0);
  });
});
