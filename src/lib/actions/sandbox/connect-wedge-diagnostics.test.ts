// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import {
  connectModulePath,
  createConnectHarness,
  requireDist,
} from "../../../../test/support/connect-flow-test-harness";

describe("connectSandbox wedge diagnostic failures", () => {
  let exitSpy: MockInstance;

  beforeEach(() => {
    vi.stubEnv("NEMOCLAW_TEST_NO_SLEEP", "1");
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    delete require.cache[requireDist.resolve(connectModulePath)];
  });

  it("preserves the classified recovery exit when wedge diagnostics reject", async () => {
    const harness = createConnectHarness({
      processCheck: {
        checked: true,
        wasRunning: false,
        recovered: false,
        forwardRecovered: false,
        recoveryFailureDetail: "the recovered gateway did not become responsive",
      },
    });
    harness.sandboxRunBufferedSpy.mockRejectedValueOnce(new Error("untrusted diagnostic failure"));

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );

    const errorOutput = harness.errorSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    expect(errorOutput).toContain(
      "Recovery detail: the recovered gateway did not become responsive.",
    );
    expect(errorOutput).toContain("Check /tmp/gateway.log inside the sandbox for details.");
    expect(errorOutput).not.toContain("untrusted diagnostic failure");
    expect(harness.sandboxRunBufferedSpy).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("preserves the automatic-recovery failure exit when wedge diagnostics reject", async () => {
    const harness = createConnectHarness({
      processCheck: {
        checked: true,
        wasRunning: false,
        recovered: false,
      },
    });
    harness.sandboxRunBufferedSpy.mockRejectedValueOnce(new Error("untrusted diagnostic failure"));

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );

    const errorOutput = harness.errorSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    expect(errorOutput).toContain(
      "Probe failed: OpenClaw gateway is not running in 'alpha' and automatic recovery failed.",
    );
    expect(errorOutput).toContain("Check /tmp/gateway.log inside the sandbox for details.");
    expect(errorOutput).not.toContain("untrusted diagnostic failure");
    expect(harness.sandboxRunBufferedSpy).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
