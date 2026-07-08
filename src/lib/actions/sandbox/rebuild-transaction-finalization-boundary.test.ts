// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  createRebuildFlowHarness,
  installRebuildFlowTestHooks,
} from "../../../../test/helpers/rebuild-flow-test-harness";
import type { RebuildFlowHarness } from "../../../../test/helpers/rebuild-flow-test-support";
import { makeActiveTeamsMessagingPlan } from "./rebuild-flow-test-fixtures";

installRebuildFlowTestHooks();

function expectRetainedFailure(harness: RebuildFlowHarness, code: string): void {
  expect(harness.transactionStore.load("alpha")).toMatchObject({
    status: "active",
    phase: "replacement_created",
    failure: { code, retryable: true },
  });
}

describe("rebuild transaction finalization boundary", () => {
  it("keeps guidance when finalization failure metadata cannot be persisted", async () => {
    const harness = createRebuildFlowHarness({
      restoreSandboxState: () => ({
        success: false,
        restoredDirs: [],
        restoredFiles: [],
        failedDirs: ["config"],
        failedFiles: [],
      }),
    });
    vi.spyOn(harness.transactionStore, "recordFailure").mockRejectedValueOnce(
      new Error("simulated journal write failure"),
    );

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("STATE_RESTORE_INCOMPLETE");

    expect(harness.logSpy.mock.calls.flat().join("\n")).toContain("State restore was incomplete");
    expect(harness.transactionStore.load("alpha")).toMatchObject({
      status: "active",
      phase: "replacement_created",
      failure: null,
    });
  });

  it("retains replacement_created when registry reconciliation throws", async () => {
    const secret = "nvapi-abcdefghijklmnopqrstuvwxyz012345";
    const updateSandbox = vi
      .fn()
      .mockReturnValueOnce(true)
      .mockImplementation(() => {
        throw new Error(`ENOSPC while writing ${secret}`);
      });
    const harness = createRebuildFlowHarness({
      updateSandbox,
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("REGISTRY_RECONCILIATION_UNVERIFIED");

    const errors = harness.errorSpy.mock.calls.flat().join("\n");
    expect(errors).toContain("Registry reconciliation failed: ENOSPC while writing <REDACTED>");
    expect(errors).not.toContain(secret);
    expect(harness.logSpy.mock.calls.flat().join("\n")).toContain(
      "Rebuilt registry metadata was not verified",
    );
    expectRetainedFailure(harness, "REGISTRY_RECONCILIATION_UNVERIFIED");
  });

  it("retains replacement_created when registry reconciliation returns false", async () => {
    const updateSandbox = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    const harness = createRebuildFlowHarness({ updateSandbox });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("REGISTRY_RECONCILIATION_UNVERIFIED");

    expect(harness.logSpy.mock.calls.flat().join("\n")).toContain(
      "Rebuilt registry metadata was not verified",
    );
    expectRetainedFailure(harness, "REGISTRY_RECONCILIATION_UNVERIFIED");
  });

  it("retains replacement_created when shields relock is unverified", async () => {
    const harness = createRebuildFlowHarness({
      shieldsWasLocked: true,
      relockShieldsWindow: () => false,
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("SHIELDS_RELOCK_UNVERIFIED");

    expect(harness.relockSpy).toHaveBeenCalledWith("alpha", expect.any(Object), true, "nemoclaw");
    expectRetainedFailure(harness, "SHIELDS_RELOCK_UNVERIFIED");
  });

  it("retains replacement_created when configured messaging forwarding is unverified", async () => {
    const plan = makeActiveTeamsMessagingPlan();
    const harness = createRebuildFlowHarness({
      applyPreset: () => true,
      buildMessagingRebuildPlan: () => plan,
      ensureMessagingHostForwardAfterRebuild: () => false,
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("MESSAGING_HOST_FORWARD_UNVERIFIED");

    expect(harness.ensureMessagingHostForwardAfterRebuildSpy).toHaveBeenCalledWith("alpha", plan);
    expect(harness.logSpy.mock.calls.flat().join("\n")).toContain(
      "Messaging webhook forward was not verified",
    );
    expectRetainedFailure(harness, "MESSAGING_HOST_FORWARD_UNVERIFIED");
  });
});
