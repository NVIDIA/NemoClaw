// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRebuildFlowHarness,
  installRebuildFlowTestHooks,
} from "../../../test/helpers/rebuild-flow-test-harness";
import { getRebuildTransactionPath, RebuildTransactionStore } from "../state/rebuild-transaction";
import { makePreparedRecoveryManifest } from "./sandbox/rebuild-flow-test-fixtures";
import {
  createRecoveryHarness,
  makeRecoveryManifest,
} from "./upgrade-sandboxes-recovery.test-support";

installRebuildFlowTestHooks();
const transactionRoots: string[] = [];

afterEach(() => {
  for (const root of transactionRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("upgrade-sandboxes rebuild transaction handoff (#6437)", () => {
  it("isolates a corrupt transaction while completing unrelated recovery", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-upgrade-transactions-"));
    transactionRoots.push(stateDir);
    const transactionStore = new RebuildTransactionStore({ stateDir });
    const corruptSandbox = "corrupt-box";
    const recoverableSandbox = "alpha";
    const corruptPath = getRebuildTransactionPath(corruptSandbox, stateDir);
    fs.mkdirSync(path.dirname(corruptPath), { recursive: true });
    const corruptRecord = '{"version":999,"transactionId":"corrupt-alpha"}\n';
    fs.writeFileSync(corruptPath, corruptRecord, { mode: 0o600 });

    const upgrade = createRecoveryHarness([corruptSandbox, recoverableSandbox], {
      latestBackup: makePreparedRecoveryManifest() as ReturnType<typeof makeRecoveryManifest>,
    });
    const errors: string[] = [];
    upgrade.rebuildSpy.mockImplementation((sandboxName, args, options) => {
      const flow = createRebuildFlowHarness({
        sandboxEntry: { name: sandboxName },
        sessionSandboxName: sandboxName,
        staleRecovery: true,
      });
      vi.spyOn(console, "error").mockImplementation((message) => errors.push(String(message)));
      return flow.rebuildSandbox(sandboxName, args, { ...options, transactionStore });
    });
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    await expect(upgrade.upgradeSandboxes({ auto: true })).rejects.toThrow("process.exit(1)");

    expect(upgrade.rebuildSpy.mock.calls.map((call) => call[0])).toEqual([
      corruptSandbox,
      recoverableSandbox,
    ]);
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/unsupported schema version 999/i),
        expect.stringMatching(/Failed to recover 'corrupt-box'/i),
      ]),
    );
    expect(errors).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/Failed to recover 'alpha'/i)]),
    );
    expect(fs.readFileSync(corruptPath, "utf8")).toBe(corruptRecord);
    expect(transactionStore.load(recoverableSandbox)).toMatchObject({
      status: "completed",
      phase: "completed",
      intent: { sandboxName: recoverableSandbox },
    });
  });

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
