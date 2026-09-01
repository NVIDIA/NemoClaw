// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createConnectHarness } from "../../../../test/support/connect-flow-test-harness";

beforeEach(() => {
  process.env.NEMOCLAW_TEST_NO_SLEEP = "1";
  vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
    throw new Error(`process.exit(${code ?? 0})`);
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  delete process.env.NEMOCLAW_TEST_NO_SLEEP;
});

describe("connect forward recovery failure", () => {
  it("reports the failed declared port and sanitized OpenShell row (#10496)", async () => {
    const observedRow =
      '{"sandboxName":"alpha","bind":"127.0.0.1","port":"8642","pid":999,"status":"dead"}';
    const harness = createConnectHarness({
      agentName: "hermes",
      sessionAgent: { name: "hermes" },
      processCheck: {
        checked: true,
        wasRunning: true,
        recovered: false,
        forwardRecovered: false,
        forwardRecoveryFailed: true,
        forwardRecoveryFailureDetail:
          "one or more agent-declared host forwards could not be re-established",
        forwardRecoveryFailurePorts: [8642],
        forwardRecoveryObservedRows: [observedRow],
      },
    });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );
    const output = harness.errorSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    expect(output).toContain("openshell forward start --background 8642 alpha");
    expect(output).toContain(observedRow);
    expect(output).not.toContain("openshell forward start --background 18789 alpha");
  });
});
