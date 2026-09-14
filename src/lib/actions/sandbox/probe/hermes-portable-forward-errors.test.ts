// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  connectModulePath,
  createConnectHarness,
  requireDist,
} from "../../../../../test/support/connect-flow-test-harness";

import { configureMissingHermesForwardCapture } from "../../../../../test/support/hermes-portable-forward-recovery-fixture";

describe("Hermes Portable forward recovery errors", () => {
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

  it("reports the original timeout together with unproved cleanup without captured output", async () => {
    const harness = createConnectHarness({
      agentName: "hermes",
      sessionAgent: { name: "hermes" },
      portableReceiptDisposition: { kind: "hermes", phase: "active" },
      portableRecoveryResult: { kind: "already-running" },
    });
    const recovery = requireDist(
      "../../src/lib/actions/sandbox/probe/hermes-portable-forward-recovery.js",
    ) as typeof import("./hermes-portable-forward-recovery");
    configureMissingHermesForwardCapture(harness, {
      afterStart: () => {
        throw Object.assign(
          new recovery.HermesPortableForwardRecoveryError("recovery-failed", {
            cause: "forward-settlement-timed-out",
          }),
          { message: "private captured output canary" },
        );
      },
    });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );
    expect(harness.publishLaunchReadinessSpy).not.toHaveBeenCalled();
    const output = harness.errorSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Do not run another probe or launch");
    expect(output).toContain("Initial recovery failure:");
    expect(output).toContain("did not become healthy before the recovery deadline");
    expect(output).not.toContain("private captured output canary");
  });
});
