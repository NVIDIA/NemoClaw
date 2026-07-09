// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, vi } from "vitest";

import {
  RebuildTransactionError,
  type RebuildTransactionErrorCode,
  type RebuildTransactionIntentV1,
  type RebuildTransactionReceiptsV1,
  type RebuildTransactionRecordV1,
  RebuildTransactionStore,
} from "../../src/lib/state/rebuild-transaction";

export const SANDBOX = "transaction-test";
export const TRANSACTION_ID = "11111111-1111-4111-8111-111111111111";
export const FP_A = `sha256:${"a".repeat(64)}`;
export const FP_B = `sha256:${"b".repeat(64)}`;
export const FP_C = `sha256:${"c".repeat(64)}`;
export const FP_D = `sha256:${"d".repeat(64)}`;
const START = Date.parse("2026-07-08T00:00:00.000Z");

const tempDirs: string[] = [];

export function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-rebuild-transaction-"));
  tempDirs.push(dir);
  return dir;
}

export function intent(
  overrides: Partial<RebuildTransactionIntentV1> = {},
): RebuildTransactionIntentV1 {
  return {
    sandboxName: SANDBOX,
    source: {
      agent: "openclaw",
      registryFingerprint: FP_A,
      registryRecovery: {
        entry: { name: SANDBOX, agent: "openclaw" },
        wasDefault: true,
        defaultSelectionRevision: 3,
      },
      legacyManagedImageRecoveryAuthorized: false,
      shieldsLocked: false,
    },
    target: {
      agent: "openclaw",
      provider: "nvidia",
      model: "nvidia/test-model",
      credentialEnv: "NVIDIA_API_KEY",
      endpointFingerprint: FP_B,
      imageFingerprint: FP_C,
      configurationFingerprint: FP_D,
      gatewayName: "nemoclaw",
      gatewayPort: 18000,
      toolDisclosure: "progressive",
      observabilityEnabled: false,
    },
    ...overrides,
  };
}

export function preparedReceipts(): RebuildTransactionReceiptsV1 {
  return {
    backup: {
      manifestTimestamp: "2026-07-08T00-00-00-000Z",
      manifestFingerprint: FP_A,
    },
  };
}

export function deletedReceipts(): RebuildTransactionReceiptsV1 {
  return {
    ...preparedReceipts(),
    oldSandboxDeletion: { observedAt: "2026-07-08T00:01:00.000Z" },
  };
}

export function replacementReceipts(): RebuildTransactionReceiptsV1 {
  return {
    ...deletedReceipts(),
    replacement: {
      identityFingerprint: FP_C,
      observedAt: "2026-07-08T00:02:00.000Z",
    },
  };
}

export function makeStore(
  root = tempDir(),
  replacementIdentityMatches: (
    sandboxName: string,
    identityFingerprint: string,
    transaction: RebuildTransactionRecordV1,
  ) => boolean = () => true,
): {
  stateDir: string;
  store: RebuildTransactionStore;
} {
  let tick = 0;
  const stateDir = path.join(root, ".nemoclaw", "state");
  return {
    stateDir,
    store: new RebuildTransactionStore({
      stateDir,
      now: () => new Date(START + tick++ * 1_000),
      transactionId: () => TRANSACTION_ID,
      replacementIdentityMatches,
    }),
  };
}

export async function expectCode(
  action: () => unknown | Promise<unknown>,
  code: RebuildTransactionErrorCode,
): Promise<void> {
  try {
    await action();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(RebuildTransactionError);
    expect((error as RebuildTransactionError).code).toBe(code);
  }
}

export function writeRawRecord(
  filePath: string,
  update: (record: Record<string, unknown>) => void,
): void {
  const record = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
  update(record);
  fs.writeFileSync(filePath, JSON.stringify(record), { mode: 0o600 });
}

export async function advanceToReplacement(
  store: RebuildTransactionStore,
): Promise<RebuildTransactionRecordV1> {
  const prepared = await store.create(intent(), preparedReceipts());
  const deleted = await store.transition(
    SANDBOX,
    prepared.revision,
    "old_deleted",
    deletedReceipts(),
  );
  return store.transition(SANDBOX, deleted.revision, "replacement_created", replacementReceipts());
}

export function cleanupRebuildTransactionTests(): void {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}
