// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  connectModulePath,
  createConnectHarness,
  requireDist,
} from "../../../../test/support/connect-flow-test-harness";

describe("connect session Shields relock watcher wiring", () => {
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

  it("watches Shields audit state for a terminal-runtime connect session (#9710)", async () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const harness = createConnectHarness({
      agentName: "langchain-deepagents-code",
      sessionAgent: {
        name: "langchain-deepagents-code",
        runtime: { kind: "terminal", interactive_command: "dcode", headless_command: "dcode -n" },
      },
    });

    await expect(harness.connectSandbox("alpha")).rejects.toThrow("process.exit(0)");

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 1_000);
  });

  it("watches Shields audit state for a sandbox whose registry row stores no agent (#9710)", async () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    // - Production returns null from `getSessionAgent` and stores `agent: null` for OpenClaw.
    // - Both harness defaults are shapes the removed agent gate accepted; neither occurs here.
    const harness = createConnectHarness({
      registryEntry: { agent: null },
      sessionAgent: null,
    });

    await expect(harness.connectSandbox("alpha")).rejects.toThrow("process.exit(0)");

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 1_000);
  });
});
