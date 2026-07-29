// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expectNoSandboxDelete } from "../../../../test/helpers/rebuild-delete-assertions";
import {
  createRebuildFlowHarness,
  resetRebuildFlowTestEnvironment,
  restoreRebuildFlowTestEnvironment,
} from "../../../../test/helpers/rebuild-flow-harness";

const BUILDX_REPAIR_DETAIL =
  "Docker Buildx is required for sandbox rebuilds. " +
  "Install or repair Docker Buildx, then verify it with 'docker buildx version'. " +
  "Rerun the rebuild after that command succeeds. " +
  "NemoClaw stopped before deleting the existing sandbox.";

describe("rebuildSandbox Buildx mutation boundary", () => {
  beforeEach(resetRebuildFlowTestEnvironment);
  afterEach(restoreRebuildFlowTestEnvironment);

  it("keeps the sandbox intact until Buildx is repaired, then allows a retry (#7111)", async () => {
    const blocked = createRebuildFlowHarness({
      rebuildImagePreflightResult: { ok: false, detail: BUILDX_REPAIR_DETAIL },
    });

    await expect(
      blocked.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Replacement sandbox image preflight failed");

    expect(blocked.preflightRebuildImageSpy).toHaveBeenCalledOnce();
    expect(blocked.backupSandboxStateSpy).not.toHaveBeenCalled();
    expect(blocked.registryUpdateSpy).not.toHaveBeenCalled();
    expectNoSandboxDelete(blocked.runOpenshellSpy);
    expect(blocked.removeSandboxRegistryEntrySpy).not.toHaveBeenCalled();
    expect(blocked.onboardSpy).not.toHaveBeenCalled();

    restoreRebuildFlowTestEnvironment();
    resetRebuildFlowTestEnvironment();
    const repaired = createRebuildFlowHarness();

    await expect(
      repaired.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(repaired.preflightRebuildImageSpy).toHaveBeenCalledOnce();
    expect(repaired.registryUpdateSpy).toHaveBeenCalled();
    expect(repaired.backupSandboxStateSpy).toHaveBeenCalledOnce();
    expect(repaired.removeSandboxRegistryEntrySpy).toHaveBeenCalledOnce();
    expect(repaired.onboardSpy).toHaveBeenCalledOnce();
  });
});
