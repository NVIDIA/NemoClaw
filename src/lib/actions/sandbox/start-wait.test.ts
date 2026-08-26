// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createConnectHarness } from "../../../../test/support/connect-flow-test-harness";

describe("sandbox start readiness", () => {
  it("waits through the stopped sandbox Error phase after start (#9753)", async () => {
    const harness = createConnectHarness({
      listOutputs: ["alpha Error", "alpha Provisioning", "alpha Ready"],
    });

    await expect(
      harness.waitForSandboxReadyOrExit("alpha", { allowInitialErrorAfterStart: true }),
    ).resolves.toBeUndefined();

    expect(harness.captureOpenshellSpy).toHaveBeenCalledTimes(3);
  });

  it("keeps Error terminal outside the post-start grace period (#9753)", async () => {
    const harness = createConnectHarness({ listOutputs: ["alpha Error"] });

    await expect(harness.waitForSandboxReadyOrExit("alpha")).rejects.toThrow(
      'process.exit unexpectedly called with "1"',
    );

    expect(harness.captureOpenshellSpy).toHaveBeenCalledTimes(1);
  });

  it("ends the post-start Error grace after the phase advances (#9753)", async () => {
    const harness = createConnectHarness({
      listOutputs: ["alpha Error", "alpha Provisioning", "alpha Error"],
    });

    await expect(
      harness.waitForSandboxReadyOrExit("alpha", { allowInitialErrorAfterStart: true }),
    ).rejects.toThrow('process.exit unexpectedly called with "1"');

    expect(harness.captureOpenshellSpy).toHaveBeenCalledTimes(3);
  });

  it("fails after the stopped sandbox Error phase remains terminal (#9753)", async () => {
    const harness = createConnectHarness({
      listOutputs: Array.from({ length: 11 }, () => "alpha Error"),
    });

    await expect(
      harness.waitForSandboxReadyOrExit("alpha", { allowInitialErrorAfterStart: true }),
    ).rejects.toThrow('process.exit unexpectedly called with "1"');

    expect(harness.captureOpenshellSpy).toHaveBeenCalledTimes(11);
  });

  it.each(["Failed", "CrashLoopBackOff"])(
    "fails immediately when start reports the terminal %s phase (#9753)",
    async (phase) => {
      const harness = createConnectHarness({ listOutputs: [`alpha ${phase}`] });

      await expect(
        harness.waitForSandboxReadyOrExit("alpha", { allowInitialErrorAfterStart: true }),
      ).rejects.toThrow('process.exit unexpectedly called with "1"');

      expect(harness.captureOpenshellSpy).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    {
      error: {
        kind: "authentication",
        message: "OpenShell could not authenticate the sandbox observation.",
      },
      guidance: "could not authenticate",
    },
    {
      error: {
        kind: "schema",
        message: "The OpenShell CLI and gateway sandbox schemas do not match.",
      },
      guidance: "schemas do not match",
    },
    {
      error: { kind: "timeout", message: "OpenShell sandbox observation timed out." },
      guidance: "readiness request for sandbox 'alpha' timed out",
    },
    {
      error: {
        kind: "command",
        reason: "failed",
        message: "The OpenShell sandbox observation failed.",
      },
      guidance: "readiness request for sandbox 'alpha' failed",
    },
    {
      error: {
        kind: "transport",
        reason: "unreachable",
        message: "OpenShell could not reach the selected gateway.",
      },
      guidance: "gateway is not running or unreachable",
    },
  ] as const)(
    "prints accurate $error.kind readiness failure guidance (#9803)",
    async (testCase) => {
      const harness = createConnectHarness();
      const observer = {
        listSandboxes: vi.fn().mockResolvedValue({ ok: false, error: testCase.error }),
      } as never;

      await expect(harness.waitForSandboxReadyOrExit("alpha", { observer })).rejects.toThrow(
        'process.exit unexpectedly called with "1"',
      );

      const output = harness.errorSpy.mock.calls.flat().join("\n");
      expect(output).toContain(testCase.guidance);
      expect(output.includes("gateway is not running or unreachable")).toBe(
        testCase.error.kind === "transport",
      );
    },
  );
});
