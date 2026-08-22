// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  type PairingFixtureRuntime,
  runFixture,
  runPatch,
  selfApprovalOptions,
  selfApprovalTransactionJournal as transactionJournal,
  selfApprovalTransactionSnapshots as transactionSnapshots,
  writeFixtureDist,
} from "./helpers/openclaw-device-self-approval-patch-harness";

function openPatchedPairingFixture(): { runtime: PairingFixtureRuntime; tmp: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-device-auth-scope-runtime-"));
  const dist = path.join(tmp, "dist");
  fs.mkdirSync(dist);
  writeFixtureDist(dist);
  const apply = runPatch(dist);
  expect(apply.status, `${apply.stdout}${apply.stderr}`).toBe(0);
  const source = fs.readFileSync(path.join(dist, "device-pairing-fixture.js"), "utf8");
  const runtime = runFixture<PairingFixtureRuntime>(
    source,
    `({
      writes,
      setPairingState,
      setFile,
      getFile,
      getPairingPaths,
      listDevicePairing,
      getPairedDevice,
      getPendingDevicePairing,
      approveDevicePairing,
      approveBootstrapDevicePairing,
      armLateWriterFailure,
      releaseLateWriter,
      armCommittedJournalFailure,
      armIdleJournalFailure,
      armStateDrift
    })`,
  );
  return { runtime, tmp };
}

describe("OpenClaw self-approval stored-auth scope validation (#4462)", () => {
  it.each([
    [
      "mismatched before",
      "before",
      ["operator.pairing", "operator.read"],
      ["operator.pairing"],
      "invalid NemoClaw self-approval journal transition",
    ],
    [
      "unknown after",
      "after",
      ["operator.pairing", "operator.unknown"],
      ["operator.pairing", "operator.unknown"],
      "invalid NemoClaw self-approval journal snapshots",
    ],
    [
      "duplicate after",
      "after",
      ["operator.pairing", "operator.pairing"],
      ["operator.pairing", "operator.pairing"],
      "invalid NemoClaw self-approval journal snapshots",
    ],
  ] as const)(
    "rejects %s paired scopes in a stored transaction journal",
    async (_case, side, pairedScopes, authScopes, expectedError) => {
      const { runtime, tmp } = openPatchedPairingFixture();
      try {
        const snapshots = transactionSnapshots();
        const { journalPath } = runtime.getPairingPaths();
        const journal = transactionJournal("prepared", snapshots);
        const snapshot = journal[side];
        const pairedDevice = snapshot.pairedByDeviceId["device-1"] as unknown as {
          tokens: { operator: { scopes: string[] } };
        };
        pairedDevice.tokens.operator.scopes = [...pairedScopes];
        snapshot.auth.tokens.operator.scopes = [...authScopes];
        runtime.setPairingState(snapshots.before.pendingById, snapshots.before.pairedByDeviceId);
        runtime.setFile(journalPath, journal);

        await expect(runtime.listDevicePairing()).rejects.toThrow(expectedError);
        expect(runtime.getFile(journalPath)).toEqual(journal);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ["mismatched", ["operator.pairing", "operator.read"], "stored device auth changed"],
    ["unknown", ["operator.pairing", "operator.unknown"], "invalid device pairing state"],
    ["duplicate", ["operator.pairing", "operator.pairing"], "invalid device pairing state"],
  ] as const)(
    "rejects %s stored-auth scopes before preparing a journal",
    async (_case, scopes, expectedError) => {
      const { runtime, tmp } = openPatchedPairingFixture();
      try {
        const snapshots = transactionSnapshots();
        const paths = runtime.getPairingPaths();
        runtime.setPairingState(snapshots.before.pendingById, snapshots.before.pairedByDeviceId);
        runtime.armStateDrift(paths.authPath, {
          ...snapshots.before.auth,
          tokens: {
            operator: { token: "token-before", role: "operator", scopes: [...scopes] },
          },
        });

        await expect(
          runtime.approveDevicePairing("request-1", selfApprovalOptions(), "/fixture"),
        ).rejects.toThrow(expectedError);
        expect(runtime.getFile(paths.journalPath)).toBeNull();
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  );
});
