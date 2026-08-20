// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { createConnectHarness } from "../../../../test/support/connect-flow-test-harness";

describe("sandbox start readiness", () => {
  it("waits through the stopped sandbox Error phase after start (#9753)", () => {
    const harness = createConnectHarness({
      listOutputs: ["alpha Error", "alpha Provisioning", "alpha Ready"],
    });

    expect(() =>
      harness.waitForSandboxReadyOrExit("alpha", { allowInitialErrorAfterStart: true }),
    ).not.toThrow();

    expect(harness.captureOpenshellSpy).toHaveBeenCalledTimes(3);
  });

  it("keeps Error terminal outside the post-start grace period (#9753)", () => {
    const harness = createConnectHarness({ listOutputs: ["alpha Error"] });

    expect(() => harness.waitForSandboxReadyOrExit("alpha")).toThrow(
      'process.exit unexpectedly called with "1"',
    );

    expect(harness.captureOpenshellSpy).toHaveBeenCalledTimes(1);
  });

  it("ends the post-start Error grace after the phase advances (#9753)", () => {
    const harness = createConnectHarness({
      listOutputs: ["alpha Error", "alpha Provisioning", "alpha Error"],
    });

    expect(() =>
      harness.waitForSandboxReadyOrExit("alpha", { allowInitialErrorAfterStart: true }),
    ).toThrow('process.exit unexpectedly called with "1"');

    expect(harness.captureOpenshellSpy).toHaveBeenCalledTimes(3);
  });

  it("fails after the stopped sandbox Error phase remains terminal (#9753)", () => {
    const harness = createConnectHarness({
      listOutputs: Array.from({ length: 11 }, () => "alpha Error"),
    });

    expect(() =>
      harness.waitForSandboxReadyOrExit("alpha", { allowInitialErrorAfterStart: true }),
    ).toThrow('process.exit unexpectedly called with "1"');

    expect(harness.captureOpenshellSpy).toHaveBeenCalledTimes(11);
  });

  it.each(["Failed", "CrashLoopBackOff"])(
    "fails immediately when start reports the terminal %s phase (#9753)",
    (phase) => {
      const harness = createConnectHarness({ listOutputs: [`alpha ${phase}`] });

      expect(() =>
        harness.waitForSandboxReadyOrExit("alpha", { allowInitialErrorAfterStart: true }),
      ).toThrow('process.exit unexpectedly called with "1"');

      expect(harness.captureOpenshellSpy).toHaveBeenCalledTimes(1);
    },
  );
});
