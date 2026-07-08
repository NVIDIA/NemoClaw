// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  configureDcodeSession,
  makeDcodeSandboxEntry,
} from "../../../../test/helpers/rebuild-dcode-flow-support";
import {
  createRebuildFlowHarness,
  resetRebuildFlowTestEnvironment,
  restoreRebuildFlowTestEnvironment,
  snapshotEnv,
} from "../../../../test/helpers/rebuild-flow-harness";

describe("rebuildSandbox DCode flow: prepared artifact drift", () => {
  beforeEach(resetRebuildFlowTestEnvironment);
  afterEach(restoreRebuildFlowTestEnvironment);

  it("preserves live DCode when retained replacement inputs drift after backup (#6195)", async () => {
    const harness = createRebuildFlowHarness({
      agentName: "langchain-deepagents-code",
      sandboxEntry: makeDcodeSandboxEntry(),
      dcodeRouteResults: [{ ok: true }, { ok: true }, { ok: true }],
      dcodeImageVerificationResults: [true, false],
    });
    configureDcodeSession(harness);

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("the prepared DCode replacement inputs changed before deletion");

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
  it("preserves live DCode when its pinned base image drifts after backup (#6195)", async () => {
    const harness = createRebuildFlowHarness({
      agentName: "langchain-deepagents-code",
      sandboxEntry: makeDcodeSandboxEntry(),
      dcodeRouteResults: [{ ok: true }, { ok: true }, { ok: true }],
      dcodeBaseImageIds: ["sha256:dcode-base", "sha256:dcode-base", "sha256:changed"],
    });
    configureDcodeSession(harness);

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("the prepared DCode replacement inputs changed before deletion");

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
  it("restores the prior gateway and disposes DCode inputs when shields opening throws (#6195)", async () => {
    const restoreEnv = snapshotEnv(["OPENSHELL_GATEWAY"]);
    process.env.OPENSHELL_GATEWAY = "previous-gateway";
    let gatewayAtShields: string | undefined;

    try {
      const harness = createRebuildFlowHarness({
        agentName: "langchain-deepagents-code",
        sandboxEntry: makeDcodeSandboxEntry(),
        dcodeRouteResults: [{ ok: true }, { ok: true }],
        openShieldsWindow: () => {
          gatewayAtShields = process.env.OPENSHELL_GATEWAY;
          throw new Error("shields opening threw unexpectedly");
        },
      });
      configureDcodeSession(harness);

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).rejects.toThrow("shields opening threw unexpectedly");

      expect(gatewayAtShields).toBe("nemoclaw");
      expect(process.env.OPENSHELL_GATEWAY).toBe("previous-gateway");
      expect(harness.prepareManagedDcodeRebuildImageSpy).toHaveBeenCalledOnce();
      expect(harness.openShieldsSpy).toHaveBeenCalledOnce();
      expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
      expect(harness.runOpenshellSpy).not.toHaveBeenCalledWith(
        ["sandbox", "delete", "alpha"],
        expect.anything(),
      );
      expect(harness.onboardSpy).not.toHaveBeenCalled();
      expect(harness.disposePreparedDcodeRebuildImageSpy).toHaveBeenCalledWith(
        harness.preparedDcodeBuildContext,
      );
    } finally {
      restoreEnv();
    }
  });
});
