// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRebuildFlowHarness,
  installRebuildFlowTestHooks,
} from "../../../test/helpers/rebuild-flow-test-harness";
import { makePreparedRecoveryManifest } from "./sandbox/rebuild-flow-test-fixtures";
import {
  createRecoveryHarness,
  makeRecoveryManifest,
} from "./upgrade-sandboxes-recovery.test-support";

installRebuildFlowTestHooks();

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("upgrade-sandboxes rebuild transaction handoff (#6437)", () => {
  it("continues an existing old_deleted transaction through the installer runner", async () => {
    let onboardAttempts = 0;
    const flow = createRebuildFlowHarness({
      staleRecovery: true,
      onboard: () => {
        onboardAttempts += 1;
        return onboardAttempts === 1
          ? Promise.reject(new Error("interrupt before replacement receipt"))
          : undefined;
      },
    });

    await expect(
      flow.rebuildSandbox("alpha", ["--yes"], {
        throwOnError: true,
        recoveryManifest: makePreparedRecoveryManifest(),
      }),
    ).rejects.toThrow("Recreate failed");
    const interrupted = flow.transactionStore.load("alpha");
    expect(interrupted).toMatchObject({ status: "active", phase: "old_deleted" });

    const resumed = createRebuildFlowHarness({ staleRecovery: true });
    resumed.onboardSpy.mockClear();
    const upgrade = createRecoveryHarness(["alpha"], {
      latestBackup: makePreparedRecoveryManifest() as ReturnType<typeof makeRecoveryManifest>,
    });
    upgrade.rebuildSpy.mockImplementation((...args) =>
      resumed.rebuildSandbox(args[0], args[1], {
        ...args[2],
        transactionStore: flow.transactionStore,
      }),
    );

    await expect(upgrade.upgradeSandboxes({ auto: true })).resolves.toBeUndefined();

    expect(flow.transactionStore.load("alpha")).toMatchObject({
      transactionId: interrupted?.transactionId,
      status: "completed",
      phase: "completed",
    });
    expect(resumed.onboardSpy).toHaveBeenCalledOnce();
    expect(upgrade.rebuildSpy).toHaveBeenCalledOnce();
  });
});
