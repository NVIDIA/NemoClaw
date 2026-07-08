// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getRebuildTransactionPath,
  REBUILD_TRANSACTION_DIRNAME,
  RebuildTransactionError,
  type RebuildTransactionErrorCode,
  type RebuildTransactionIntentV1,
  type RebuildTransactionReceiptsV1,
  type RebuildTransactionRecordV1,
  RebuildTransactionStore,
} from "./rebuild-transaction";

const SANDBOX = "transaction-test";
const TRANSACTION_ID = "11111111-1111-4111-8111-111111111111";
const FP_A = `sha256:${"a".repeat(64)}`;
const FP_B = `sha256:${"b".repeat(64)}`;
const FP_C = `sha256:${"c".repeat(64)}`;
const FP_D = `sha256:${"d".repeat(64)}`;
const START = Date.parse("2026-07-08T00:00:00.000Z");

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-rebuild-transaction-"));
  tempDirs.push(dir);
  return dir;
}

function intent(overrides: Partial<RebuildTransactionIntentV1> = {}): RebuildTransactionIntentV1 {
  return {
    sandboxName: SANDBOX,
    source: { agent: "openclaw", registryFingerprint: FP_A },
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

function preparedReceipts(): RebuildTransactionReceiptsV1 {
  return {
    backup: {
      manifestTimestamp: "2026-07-08T00-00-00-000Z",
      manifestFingerprint: FP_A,
    },
  };
}

function deletedReceipts(): RebuildTransactionReceiptsV1 {
  return {
    ...preparedReceipts(),
    registryRemoval: {
      entryFingerprint: FP_B,
      wasDefault: true,
      fallbackDefault: "another-sandbox",
      postRemovalDefaultSelectionRevision: 4,
    },
    oldSandboxDeletion: { observedAt: "2026-07-08T00:01:00.000Z" },
  };
}

function replacementReceipts(): RebuildTransactionReceiptsV1 {
  return {
    ...deletedReceipts(),
    replacement: {
      identityFingerprint: FP_C,
      observedAt: "2026-07-08T00:02:00.000Z",
    },
  };
}

function makeStore(root = tempDir()): {
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
    }),
  };
}

function expectCode(action: () => unknown, code: RebuildTransactionErrorCode): void {
  try {
    action();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(RebuildTransactionError);
    expect((error as RebuildTransactionError).code).toBe(code);
  }
}

function writeRawRecord(filePath: string, update: (record: Record<string, unknown>) => void): void {
  const record = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
  update(record);
  fs.writeFileSync(filePath, JSON.stringify(record), { mode: 0o600 });
}

function advanceToReplacement(store: RebuildTransactionStore): RebuildTransactionRecordV1 {
  const prepared = store.create(intent(), preparedReceipts());
  const deleted = store.transition(SANDBOX, prepared.revision, "old_deleted", deletedReceipts());
  return store.transition(SANDBOX, deleted.revision, "replacement_created", replacementReceipts());
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("RebuildTransactionStore", () => {
  it("round-trips the versioned prepared record with secure paths and permissions", () => {
    const { stateDir, store } = makeStore();

    const created = store.create(intent(), preparedReceipts());
    const filePath = getRebuildTransactionPath(SANDBOX, stateDir);

    expect(store.load(SANDBOX)).toEqual(created);
    expect(created).toMatchObject({
      version: 1,
      transactionId: TRANSACTION_ID,
      revision: 1,
      status: "active",
      phase: "prepared",
      failure: null,
      completedAt: null,
    });
    expect(path.basename(filePath)).not.toContain(SANDBOX);
    expect(fs.statSync(path.dirname(filePath)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(filePath)).filter((name) => name.endsWith(".tmp"))).toEqual(
      [],
    );
  });

  it("returns null only when no transaction exists", () => {
    const { store } = makeStore();
    expect(store.load(SANDBOX)).toBeNull();
  });

  it("advances every V1 phase with monotonic revisions and clears prior failures", () => {
    const { store } = makeStore();
    const prepared = store.create(intent(), preparedReceipts());
    const failed = store.recordFailure(SANDBOX, prepared.revision, {
      code: "DELETE_RETRY_REQUIRED",
      recordedAt: "2026-07-08T00:00:30.000Z",
      retryable: true,
    });
    const deleted = store.transition(SANDBOX, failed.revision, "old_deleted", deletedReceipts());
    const replacement = store.transition(
      SANDBOX,
      deleted.revision,
      "replacement_created",
      replacementReceipts(),
    );
    const completed = store.complete(SANDBOX, replacement.revision);

    expect([prepared.phase, deleted.phase, replacement.phase, completed.phase]).toEqual([
      "prepared",
      "old_deleted",
      "replacement_created",
      "completed",
    ]);
    expect([
      prepared.revision,
      failed.revision,
      deleted.revision,
      replacement.revision,
      completed.revision,
    ]).toEqual([1, 2, 3, 4, 5]);
    expect(deleted.failure).toBeNull();
    expect(completed).toMatchObject({ status: "completed", failure: null });
    expect(completed.completedAt).not.toBeNull();
    expect(store.load(SANDBOX)).toEqual(completed);
  });

  it("rejects stale revisions without overwriting the newer generation", () => {
    const { store } = makeStore();
    const prepared = store.create(intent(), preparedReceipts());
    const failed = store.recordFailure(SANDBOX, prepared.revision, {
      code: "FIRST_WRITER",
      recordedAt: "2026-07-08T00:00:30.000Z",
      retryable: true,
    });

    expectCode(
      () =>
        store.recordFailure(SANDBOX, prepared.revision, {
          code: "STALE_WRITER",
          recordedAt: "2026-07-08T00:00:31.000Z",
          retryable: true,
        }),
      "REVISION_CONFLICT",
    );
    expect(store.load(SANDBOX)).toEqual(failed);
  });

  it("allows only one active record per sandbox", () => {
    const { store } = makeStore();
    const first = store.create(intent(), preparedReceipts());

    expectCode(() => store.create(intent(), preparedReceipts()), "ALREADY_EXISTS");
    expect(store.load(SANDBOX)).toEqual(first);
  });

  it("makes completion idempotent without allowing a terminal record to become active", () => {
    const { store } = makeStore();
    const replacement = advanceToReplacement(store);
    const completed = store.complete(SANDBOX, replacement.revision);

    expect(store.complete(SANDBOX, completed.revision)).toEqual(completed);
    expectCode(() => store.complete(SANDBOX, replacement.revision), "REVISION_CONFLICT");
    expectCode(
      () =>
        store.transition(SANDBOX, completed.revision, "replacement_created", replacementReceipts()),
      "INVALID_TRANSITION",
    );
    expect(store.load(SANDBOX)).toEqual(completed);
  });

  it("persists a failure after deletion and clears it when replacement is observed", () => {
    const { store } = makeStore();
    const prepared = store.create(intent(), preparedReceipts());
    const deleted = store.transition(SANDBOX, prepared.revision, "old_deleted", deletedReceipts());
    const failed = store.recordFailure(SANDBOX, deleted.revision, {
      code: "REPLACEMENT_RETRY_REQUIRED",
      recordedAt: "2026-07-08T00:01:30.000Z",
      retryable: true,
    });

    expect(store.load(SANDBOX)).toEqual(failed);
    const replacement = store.transition(
      SANDBOX,
      failed.revision,
      "replacement_created",
      replacementReceipts(),
    );
    expect(replacement.failure).toBeNull();
  });

  it("rejects skipped, reversed, and prematurely completed transitions", () => {
    const { store } = makeStore();
    const prepared = store.create(intent(), preparedReceipts());

    expectCode(
      () =>
        store.transition(SANDBOX, prepared.revision, "replacement_created", replacementReceipts()),
      "INVALID_TRANSITION",
    );
    expectCode(() => store.complete(SANDBOX, prepared.revision), "INVALID_TRANSITION");
    expectCode(() => makeStore().store.create(intent(), replacementReceipts()), "INVALID_INPUT");
  });

  it("does not allow a later phase to replace an existing receipt", () => {
    const { store } = makeStore();
    const prepared = store.create(intent(), preparedReceipts());
    const changedBackup: RebuildTransactionReceiptsV1 = {
      ...deletedReceipts(),
      backup: { ...preparedReceipts().backup, manifestFingerprint: FP_D },
    };

    expectCode(
      () => store.transition(SANDBOX, prepared.revision, "old_deleted", changedBackup),
      "INVALID_TRANSITION",
    );
    expect(store.load(SANDBOX)).toEqual(prepared);
  });

  it("leaves the prior valid record when atomic replacement fails", () => {
    const { stateDir, store } = makeStore();
    const prepared = store.create(intent(), preparedReceipts());
    vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("simulated rename failure"), {
        code: "EIO",
      });
    });

    expect(() =>
      store.transition(SANDBOX, prepared.revision, "old_deleted", deletedReceipts()),
    ).toThrow("simulated rename failure");

    expect(store.load(SANDBOX)).toEqual(prepared);
    const transactionDir = path.join(stateDir, REBUILD_TRANSACTION_DIRNAME);
    expect(fs.readdirSync(transactionDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("fails closed for malformed JSON and unknown future versions", () => {
    const { stateDir, store } = makeStore();
    store.create(intent(), preparedReceipts());
    const filePath = getRebuildTransactionPath(SANDBOX, stateDir);

    writeRawRecord(filePath, (record) => {
      record.version = 2;
    });
    expectCode(() => store.load(SANDBOX), "UNSUPPORTED_VERSION");

    fs.writeFileSync(filePath, "{not-json", { mode: 0o600 });
    expectCode(() => store.load(SANDBOX), "CORRUPT");
  });

  it.each([
    [
      "transaction ID",
      (record: Record<string, unknown>) => {
        record.transactionId = "not-a-uuid";
      },
    ],
    [
      "revision",
      (record: Record<string, unknown>) => {
        record.revision = -1;
      },
    ],
    [
      "phase/status",
      (record: Record<string, unknown>) => {
        record.status = "completed";
      },
    ],
    [
      "timestamp",
      (record: Record<string, unknown>) => {
        record.updatedAt = "yesterday";
      },
    ],
  ])("rejects a malformed %s", (_label, mutate) => {
    const { stateDir, store } = makeStore();
    store.create(intent(), preparedReceipts());
    writeRawRecord(getRebuildTransactionPath(SANDBOX, stateDir), mutate);
    expectCode(() => store.load(SANDBOX), "CORRUPT");
  });

  it("rejects an incomplete registry-removal receipt", () => {
    const { stateDir, store } = makeStore();
    const prepared = store.create(intent(), preparedReceipts());
    store.transition(SANDBOX, prepared.revision, "old_deleted", deletedReceipts());
    writeRawRecord(getRebuildTransactionPath(SANDBOX, stateDir), (record) => {
      const receipts = record.receipts as Record<string, unknown>;
      const removal = receipts.registryRemoval as Record<string, unknown>;
      delete removal.wasDefault;
    });

    expectCode(() => store.load(SANDBOX), "CORRUPT");
  });

  it("rejects invalid and traversal-shaped sandbox names before path construction", () => {
    const { stateDir, store } = makeStore();
    for (const name of ["../escape", "has/slash", "UPPER", "", "a".repeat(64)]) {
      expectCode(() => store.load(name), "INVALID_INPUT");
      expectCode(() => getRebuildTransactionPath(name, stateDir), "INVALID_INPUT");
    }
  });

  it("does not adopt a valid record stored under another sandbox key", () => {
    const { stateDir, store } = makeStore();
    store.create(intent(), preparedReceipts());
    const otherName = "other-sandbox";
    const otherPath = getRebuildTransactionPath(otherName, stateDir);
    fs.copyFileSync(getRebuildTransactionPath(SANDBOX, stateDir), otherPath);

    expectCode(() => store.load(otherName), "CORRUPT");
  });

  it("rejects symlinked transaction directories and record files", () => {
    const root = tempDir();
    vi.stubEnv("HOME", root);
    const stateDir = path.join(root, ".nemoclaw", "state");
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const attackerDir = path.join(root, "attacker");
    fs.mkdirSync(attackerDir);
    fs.symlinkSync(attackerDir, path.join(stateDir, REBUILD_TRANSACTION_DIRNAME));
    const store = makeStore(root).store;

    expect(() => store.create(intent(), preparedReceipts())).toThrow(/symbolic link/);

    fs.unlinkSync(path.join(stateDir, REBUILD_TRANSACTION_DIRNAME));
    const created = store.create(intent(), preparedReceipts());
    const filePath = getRebuildTransactionPath(SANDBOX, stateDir);
    fs.unlinkSync(filePath);
    const attackerFile = path.join(attackerDir, "record.json");
    fs.writeFileSync(attackerFile, JSON.stringify(created), { mode: 0o600 });
    fs.symlinkSync(attackerFile, filePath);

    expectCode(() => store.load(SANDBOX), "CORRUPT");
  });

  it("normalizes allow-listed data and emits a redacted diagnostic projection", () => {
    const { stateDir, store } = makeStore();
    const secret = "secret-sentinel-do-not-persist";
    const untrustedIntent = {
      ...intent(),
      token: secret,
      target: {
        ...intent().target,
        endpointUrl: `https://user:${secret}@example.test/v1`,
        environment: { NVIDIA_API_KEY: secret },
      },
    } as unknown as RebuildTransactionIntentV1;

    const record = store.create(untrustedIntent, preparedReceipts());
    const serialized = fs.readFileSync(getRebuildTransactionPath(SANDBOX, stateDir), "utf8");
    const diagnostic = JSON.stringify(store.diagnostic(record));

    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("endpointUrl");
    expect(serialized).not.toContain("environment");
    expect(diagnostic).not.toContain("NVIDIA_API_KEY");
    expect(diagnostic).not.toContain("provider");
    expect(store.diagnostic(record)).toMatchObject({
      sandboxName: SANDBOX,
      phase: "prepared",
      receipts: {
        backup: true,
        registryRemoval: false,
        oldSandboxDeletion: false,
        replacement: false,
      },
    });
  });

  it("repairs loose state-directory and record permissions while loading", () => {
    const { stateDir, store } = makeStore();
    store.create(intent(), preparedReceipts());
    const filePath = getRebuildTransactionPath(SANDBOX, stateDir);
    fs.chmodSync(path.dirname(filePath), 0o755);
    fs.chmodSync(filePath, 0o644);

    expect(store.load(SANDBOX)).not.toBeNull();
    expect(fs.statSync(path.dirname(filePath)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
  });
});
