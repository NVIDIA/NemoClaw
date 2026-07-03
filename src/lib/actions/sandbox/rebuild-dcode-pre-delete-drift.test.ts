// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  configureDcodeSession,
  expectNoDcodeMutation,
  makeDcodeSandboxEntry,
} from "../../../../test/helpers/rebuild-dcode-flow-support";
import {
  createRebuildFlowHarness,
  resetRebuildFlowTestEnvironment,
  restoreRebuildFlowTestEnvironment,
} from "../../../../test/helpers/rebuild-flow-harness";

describe("rebuildSandbox DCode flow: pre-delete drift", () => {
  beforeEach(resetRebuildFlowTestEnvironment);
  afterEach(restoreRebuildFlowTestEnvironment);

  it("rejects registry drift during the final DCode preflight before shields and backup (#6195)", async () => {
    const originalEntry = makeDcodeSandboxEntry();
    const driftedEntry = { ...originalEntry, model: "nvidia/changed-during-preflight" };
    const harness = createRebuildFlowHarness({
      agentName: "langchain-deepagents-code",
      sandboxEntry: originalEntry,
      sandboxEntryReads: [
        originalEntry, // Initial rebuild target.
        originalEntry, // Messaging-conflict gateway selection (#5954).
        originalEntry, // Prepared DCode target capture.
        driftedEntry, // Final pre-backup target verification.
      ],
      dcodeRouteResults: [{ ok: true }, { ok: true }],
    });
    configureDcodeSession(harness);

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("the recorded sandbox target changed during preflight");

    expect(harness.preflightDcodeRouteSpy).toHaveBeenCalledTimes(2);
    expect(harness.prepareManagedDcodeRebuildImageSpy).toHaveBeenCalledOnce();
    expect(harness.disposePreparedDcodeRebuildImageSpy).toHaveBeenCalledWith(
      harness.preparedDcodeBuildContext,
    );
    expectNoDcodeMutation(harness);
  });
  it("disposes the prepared DCode image when the final route recheck fails (#6195)", async () => {
    const harness = createRebuildFlowHarness({
      agentName: "langchain-deepagents-code",
      sandboxEntry: makeDcodeSandboxEntry(),
      dcodeRouteResults: [
        { ok: true },
        { ok: false, detail: "existing sandbox inference probe returned HTTP 401" },
      ],
    });
    configureDcodeSession(harness);

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Recorded inference route smoke check failed");

    expect(harness.preflightDcodeRouteSpy).toHaveBeenCalledTimes(2);
    expect(harness.prepareManagedDcodeRebuildImageSpy).toHaveBeenCalledOnce();
    expect(harness.disposePreparedDcodeRebuildImageSpy).toHaveBeenCalledWith(
      harness.preparedDcodeBuildContext,
    );
    expectNoDcodeMutation(harness);
  });
  it("preserves the live DCode sandbox when its registry target drifts after backup (#6195)", async () => {
    const originalEntry = makeDcodeSandboxEntry();
    const driftedEntry = { ...originalEntry, model: "nvidia/changed-at-delete-edge" };
    const harness = createRebuildFlowHarness({
      agentName: "langchain-deepagents-code",
      sandboxEntry: originalEntry,
      sandboxEntryReads: [
        originalEntry, // Initial rebuild target.
        originalEntry, // Messaging-conflict gateway selection (#5954).
        originalEntry, // Prepared DCode target capture.
        originalEntry, // Final pre-backup target verification.
        originalEntry, // Delete-edge target verification input.
        driftedEntry, // Registry reread at the destructive boundary.
      ],
      dcodeRouteResults: [{ ok: true }, { ok: true }, { ok: true }],
    });
    configureDcodeSession(harness);

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("the recorded sandbox target changed during preflight");

    expect(harness.openShieldsSpy).toHaveBeenCalledOnce();
    expect(harness.backupSandboxStateSpy).toHaveBeenCalledOnce();
    expect(harness.runOpenshellSpy).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
    expect(harness.removeSandboxRegistryEntrySpy).not.toHaveBeenCalled();
    expect(harness.onboardSpy).not.toHaveBeenCalled();
    expect(harness.relockSpy).toHaveBeenCalledWith("alpha", expect.any(Object), true, "nemoclaw");
    expect(harness.disposePreparedDcodeRebuildImageSpy).toHaveBeenCalledWith(
      harness.preparedDcodeBuildContext,
    );
  });
  it("preserves the live DCode sandbox when its credential route drifts after backup (#6195)", async () => {
    const harness = createRebuildFlowHarness({
      agentName: "langchain-deepagents-code",
      sandboxEntry: makeDcodeSandboxEntry(),
      dcodeRouteResults: [
        { ok: true },
        { ok: true },
        { ok: false, detail: "existing sandbox inference probe returned HTTP 401" },
      ],
    });
    configureDcodeSession(harness);

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Recorded inference route smoke check failed");

    expect(harness.preflightDcodeRouteSpy).toHaveBeenCalledTimes(3);
    expect(harness.openShieldsSpy).toHaveBeenCalledOnce();
    expect(harness.backupSandboxStateSpy).toHaveBeenCalledOnce();
    expect(harness.runOpenshellSpy).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
    expect(harness.removeSandboxRegistryEntrySpy).not.toHaveBeenCalled();
    expect(harness.onboardSpy).not.toHaveBeenCalled();
    expect(harness.relockSpy).toHaveBeenCalledWith("alpha", expect.any(Object), true, "nemoclaw");
    expect(harness.disposePreparedDcodeRebuildImageSpy).toHaveBeenCalledWith(
      harness.preparedDcodeBuildContext,
    );
  });
});
