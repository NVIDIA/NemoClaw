// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createHostLocalCreateJournalStore,
  HOST_LOCAL_CREATE_JOURNAL_DIRECTORY,
  reconcileAndReadHostLocalCreateJournalRecords,
  type HostLocalCreateJournalRecord,
  serializeHostLocalCreateJournalRecord,
} from "./host-local-create-journal";
import { serializeHostLocalInferenceReceipt } from "./host-local-inference";

const TRANSACTION_ID = "a".repeat(64);
const RUNTIME_ID = "b".repeat(64);
const CREATE_INTENT_UNIX_MS = 1_786_000_000_000;
const OWNER_ONE = "11111111-1111-4111-8111-111111111111";
const OWNER_TWO = "22222222-2222-4222-8222-222222222222";
const OWNER_THREE = "33333333-3333-4333-8333-333333333333";
let stateDirectory = "";

beforeEach(() => {
  stateDirectory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-host-local-create-journal-")),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(stateDirectory, { force: true, recursive: true });
});

function prepared(): HostLocalCreateJournalRecord {
  return {
    schemaVersion: 1,
    transactionId: TRANSACTION_ID,
    phase: "prepared",
    providerId: "docker",
    service: "llama-cpp",
    containerName: "nemoclaw-llama-cpp",
    runtimeId: null,
    createIntentUnixMs: null,
    specSha256: "d".repeat(64),
    networkId: "e".repeat(64),
    apiKeyIdentitySha256: "1".repeat(64),
    apiKeyRootIdentitySha256: "2".repeat(64),
    engineAuthority: {
      schemaVersion: 1,
      providerId: "docker",
      operation: "host-local-inference",
      engineId: "docker",
      authorityId: "docker:local",
      bindingSha256: "f".repeat(64),
    },
    receiptTargetSha256: "3".repeat(64),
    serializedReceipt: null,
    receiptSha256: null,
  };
}

function serializedReceipt(): string {
  const authority = prepared();
  return serializeHostLocalInferenceReceipt({
    schemaVersion: 1,
    providerId: authority.providerId,
    service: "llama-cpp",
    engineAuthority: authority.engineAuthority,
    endpoint: { host: "host.openshell.internal", port: 49152, networkName: "internal" },
    runtime: {
      kind: "container",
      runtimeId: RUNTIME_ID,
      name: authority.containerName,
      imageRef: `ghcr.io/nvidia/llama-cpp@sha256:${"4".repeat(64)}`,
      probeImageRef: `quay.io/curl/curl@sha256:${"5".repeat(64)}`,
      specSha256: authority.specSha256,
      model: {
        planDigest: `sha256:${"6".repeat(64)}`,
        recipeId: "llama-cpp.nemotron.spark.v1",
        generation: TRANSACTION_ID,
        digest: `sha256:${"7".repeat(64)}`,
        sizeBytes: 64,
      },
      gpu: { vendor: "nvidia", count: 1 },
    },
  });
}

function journalPath(): string {
  return path.join(stateDirectory, HOST_LOCAL_CREATE_JOURNAL_DIRECTORY, `${TRANSACTION_ID}.json`);
}

function executionPath(name: ".execution-lease.json" | ".execution-recovery.json"): string {
  return path.join(stateDirectory, HOST_LOCAL_CREATE_JOURNAL_DIRECTORY, name);
}

describe("existing journal reads", () => {
  it("does not create an absent journal directory", () => {
    expect(reconcileAndReadHostLocalCreateJournalRecords(stateDirectory)).toEqual([]);
    expect(fs.existsSync(path.dirname(journalPath()))).toBe(false);
  });

  it("repairs a recoverable exclusive-publish orphan", () => {
    const store = createHostLocalCreateJournalStore(stateDirectory);
    store.create(prepared());
    const orphan = path.join(
      path.dirname(journalPath()),
      `.${path.basename(journalPath())}.${OWNER_ONE}.tmp`,
    );
    fs.linkSync(journalPath(), orphan);

    expect(reconcileAndReadHostLocalCreateJournalRecords(stateDirectory)).toEqual([prepared()]);
    expect(fs.existsSync(orphan)).toBe(false);
  });
});

function executionSource(transactionId: string, ownerId: string, ownerPid: number): string {
  return `${JSON.stringify({ schemaVersion: 1, transactionId, ownerId, ownerPid })}\n`;
}

describe("host-local create journal", () => {
  it("durably records network intent before accepting its exact immutable ID", () => {
    const store = createHostLocalCreateJournalStore(stateDirectory);
    const intent = {
      ...prepared(),
      phase: "network-creating" as const,
      networkId: null,
      createIntentUnixMs: CREATE_INTENT_UNIX_MS,
    };

    expect(store.create(intent)).toEqual(intent);
    expect(store.recordNetworkCreated(TRANSACTION_ID, "e".repeat(64))).toMatchObject({
      phase: "prepared",
      networkId: "e".repeat(64),
      createIntentUnixMs: null,
    });
  });

  it("durably resumes every create and receipt-publication phase without secrets (#8414)", () => {
    const fsync = vi.spyOn(fs, "fsyncSync");
    const first = createHostLocalCreateJournalStore(stateDirectory);
    expect(first.create(prepared()).phase).toBe("prepared");
    expect(first.recordCreating(TRANSACTION_ID, CREATE_INTENT_UNIX_MS).phase).toBe("creating");
    expect(first.recordCreated(TRANSACTION_ID, RUNTIME_ID).phase).toBe("created");

    const restarted = createHostLocalCreateJournalStore(stateDirectory);
    expect(restarted.recordStarted(TRANSACTION_ID).phase).toBe("started");
    const receipt = serializedReceipt();
    const preparedReceipt = restarted.prepareReceipt(TRANSACTION_ID, receipt);
    expect(preparedReceipt).toMatchObject({
      phase: "receipt-prepared",
      serializedReceipt: receipt,
      receiptSha256: createHash("sha256").update(receipt).digest("hex"),
    });
    const finalized = restarted.finalize(TRANSACTION_ID);
    expect(finalized.phase).toBe("finalized");
    expect(restarted.finalize(TRANSACTION_ID)).toEqual(finalized);
    expect(restarted.list()).toEqual([finalized]);

    const serialized = fs.readFileSync(journalPath(), "utf8");
    expect(serialized).toBe(serializeHostLocalCreateJournalRecord(finalized));
    expect(serialized).not.toMatch(
      /hostPath|apiKeyHostPath|apiKeyValue|HF_TOKEN|filesystemIdentity/u,
    );
    expect(fs.statSync(path.dirname(journalPath())).mode & 0o777).toBe(0o700);
    expect(fs.statSync(journalPath()).mode & 0o777).toBe(0o600);
    expect(fsync.mock.calls.length).toBeGreaterThanOrEqual(9);
  });

  it("rejects duplicate creation and out-of-order transitions (#8395)", () => {
    const store = createHostLocalCreateJournalStore(stateDirectory);
    store.create(prepared());
    expect(() => store.create(prepared())).toThrow("transaction already exists");
    expect(() => store.recordCreated(TRANSACTION_ID, RUNTIME_ID)).toThrow(
      "only a creating transaction can record creation",
    );
    expect(() => store.recordStarted(TRANSACTION_ID)).toThrow(
      "only a created transaction can record start",
    );
    expect(() => store.prepareReceipt(TRANSACTION_ID, serializedReceipt())).toThrow(
      "only a started transaction can prepare receipt publication",
    );
    expect(() => store.finalize(TRANSACTION_ID)).toThrow(
      "only a receipt-prepared transaction can finalize",
    );
  });

  it("rejects noncanonical receipt bytes before publication intent is durable (#8414)", () => {
    const store = createHostLocalCreateJournalStore(stateDirectory);
    store.create(prepared());
    store.recordCreating(TRANSACTION_ID, CREATE_INTENT_UNIX_MS);
    store.recordCreated(TRANSACTION_ID, RUNTIME_ID);
    store.recordStarted(TRANSACTION_ID);

    expect(() => store.prepareReceipt(TRANSACTION_ID, serializedReceipt().trim())).toThrow(
      "Host-local create journal is invalid: prepared receipt is invalid",
    );
    expect(store.load(TRANSACTION_ID)?.phase).toBe("started");
  });

  it("rejects a canonical receipt that differs from create authority before publication (#8414)", () => {
    const store = createHostLocalCreateJournalStore(stateDirectory);
    store.create(prepared());
    store.recordCreating(TRANSACTION_ID, CREATE_INTENT_UNIX_MS);
    store.recordCreated(TRANSACTION_ID, RUNTIME_ID);
    store.recordStarted(TRANSACTION_ID);
    const receipt = JSON.parse(serializedReceipt());
    const mismatchedReceipt = serializeHostLocalInferenceReceipt({
      ...receipt,
      runtime: {
        ...receipt.runtime,
        model: {
          ...receipt.runtime.model,
          generation: "c".repeat(64),
        },
      },
    });

    expect(() => store.prepareReceipt(TRANSACTION_ID, mismatchedReceipt)).toThrow(
      "prepared receipt differs from create authority",
    );
    expect(store.load(TRANSACTION_ID)?.phase).toBe("started");
  });

  it.each([
    ["receipt without its digest", { serializedReceipt: "hostPath=/secret\n" }],
    ["digest without its receipt", { receiptSha256: "9".repeat(64) }],
  ])("rejects partial %s journal state (#8414)", (_name, partial) => {
    expect(() =>
      serializeHostLocalCreateJournalRecord({
        ...prepared(),
        ...partial,
      }),
    ).toThrow("Host-local create journal is invalid: phase and receipt fields disagree");
  });

  it("rejects receipt or digest tampering after a durable publication prepare (#8414)", () => {
    const store = createHostLocalCreateJournalStore(stateDirectory);
    store.create(prepared());
    store.recordCreating(TRANSACTION_ID, CREATE_INTENT_UNIX_MS);
    store.recordCreated(TRANSACTION_ID, RUNTIME_ID);
    store.recordStarted(TRANSACTION_ID);
    store.prepareReceipt(TRANSACTION_ID, serializedReceipt());

    const record = JSON.parse(fs.readFileSync(journalPath(), "utf8"));
    record.receiptSha256 = "8".repeat(64);
    fs.writeFileSync(journalPath(), `${JSON.stringify(record)}\n`, { mode: 0o600 });
    expect(() => store.load(TRANSACTION_ID)).toThrow(
      "Host-local create journal is invalid: prepared receipt digest changed",
    );
  });

  it("rejects a symlinked journal record instead of following it (#8395)", () => {
    const store = createHostLocalCreateJournalStore(stateDirectory);
    store.create(prepared());
    const outside = path.join(stateDirectory, "outside.json");
    fs.renameSync(journalPath(), outside);
    fs.symlinkSync(outside, journalPath());

    expect(() => store.load(TRANSACTION_ID)).toThrow("ELOOP");
  });

  it("rejects a non-private journal directory (#8395)", () => {
    const root = path.join(stateDirectory, HOST_LOCAL_CREATE_JOURNAL_DIRECTORY);
    fs.mkdirSync(root, { mode: 0o700 });
    fs.chmodSync(root, 0o770);

    expect(() => createHostLocalCreateJournalStore(stateDirectory).list()).toThrow(
      "private current-user-owned directory",
    );
  });

  it("retires an exact generation idempotently and persists the deletion (#8395)", () => {
    const fsync = vi.spyOn(fs, "fsyncSync");
    const store = createHostLocalCreateJournalStore(stateDirectory);
    store.create(prepared());
    fsync.mockClear();

    store.retire(TRANSACTION_ID);
    expect(store.load(TRANSACTION_ID)).toBeNull();
    expect(fsync).toHaveBeenCalled();
    store.retire(TRANSACTION_ID);
  });

  it("gives one live process exclusive durable execution ownership (#8395)", () => {
    const first = createHostLocalCreateJournalStore(stateDirectory, {
      createOwnerId: () => OWNER_ONE,
      ownerPid: 101,
      processIsAlive: () => true,
    });
    const lease = first.acquireExecution(TRANSACTION_ID);
    first.assertExecution(lease);

    const contender = createHostLocalCreateJournalStore(stateDirectory, {
      createOwnerId: () => OWNER_TWO,
      ownerPid: 202,
      processIsAlive: () => true,
    });
    expect(() => contender.acquireExecution("3".repeat(64))).toThrow(
      "already owned by a live process",
    );
    expect(() => contender.releaseExecution({ ...lease, ownerId: OWNER_TWO })).toThrow(
      "execution ownership changed",
    );

    first.releaseExecution(lease);
    const replacement = contender.acquireExecution("3".repeat(64));
    contender.assertExecution(replacement);
    contender.releaseExecution(replacement);
  });

  it("recovers only a dead execution owner through the durable recovery marker (#8395)", () => {
    const abandonedStore = createHostLocalCreateJournalStore(stateDirectory, {
      createOwnerId: () => OWNER_ONE,
      ownerPid: 101,
      processIsAlive: (pid) => pid === 101,
    });
    const abandoned = abandonedStore.acquireExecution(TRANSACTION_ID);

    const recoveryStore = createHostLocalCreateJournalStore(stateDirectory, {
      createOwnerId: () => OWNER_TWO,
      ownerPid: 202,
      processIsAlive: (pid) => pid === 202,
    });
    const recovered = recoveryStore.acquireExecution("3".repeat(64));
    expect(recovered).toMatchObject({ ownerId: OWNER_TWO, ownerPid: 202 });
    expect(() => abandonedStore.assertExecution(abandoned)).toThrow("execution ownership changed");
    recoveryStore.releaseExecution(recovered);
  });

  it.each([false, true])(
    "reclaims a dead recovery marker with and without an abandoned lease [case %#] (#8395)",
    (withLease) => {
      fs.rmSync(stateDirectory, { force: true, recursive: true });
      fs.mkdirSync(stateDirectory, { mode: 0o700 });
      const setup = createHostLocalCreateJournalStore(stateDirectory, {
        createOwnerId: () => OWNER_ONE,
        ownerPid: 101,
        processIsAlive: () => true,
      });
      setup.list();
      withLease ? setup.acquireExecution(TRANSACTION_ID) : undefined;
      fs.writeFileSync(
        executionPath(".execution-recovery.json"),
        executionSource("2".repeat(64), OWNER_TWO, 202),
        { mode: 0o600 },
      );

      const recovered = createHostLocalCreateJournalStore(stateDirectory, {
        createOwnerId: () => OWNER_THREE,
        ownerPid: 303,
        processIsAlive: (pid) => pid === 303,
      });
      const lease = recovered.acquireExecution("3".repeat(64));
      expect(lease).toMatchObject({ ownerId: OWNER_THREE, ownerPid: 303 });
      expect(fs.existsSync(executionPath(".execution-recovery.json"))).toBe(false);
      recovered.releaseExecution(lease);
    },
  );

  it("preserves live recovery-marker exclusion (#8395)", () => {
    const setup = createHostLocalCreateJournalStore(stateDirectory);
    setup.list();
    fs.writeFileSync(
      executionPath(".execution-recovery.json"),
      executionSource("2".repeat(64), OWNER_TWO, 202),
      { mode: 0o600 },
    );
    const contender = createHostLocalCreateJournalStore(stateDirectory, {
      createOwnerId: () => OWNER_THREE,
      ownerPid: 303,
      processIsAlive: (pid) => pid === 202 || pid === 303,
    });
    expect(() => contender.acquireExecution("3".repeat(64))).toThrow(
      "recovery is already owned by a live process",
    );
  });

  it("reconciles the exact orphan hard link from a crashed exclusive publish (#8395)", () => {
    const store = createHostLocalCreateJournalStore(stateDirectory, {
      createOwnerId: () => OWNER_ONE,
    });
    store.create(prepared());
    const journalOrphan = path.join(
      path.dirname(journalPath()),
      `.${path.basename(journalPath())}.${OWNER_ONE}.tmp`,
    );
    fs.linkSync(journalPath(), journalOrphan);
    expect(fs.statSync(journalPath()).nlink).toBe(2);
    expect(store.load(TRANSACTION_ID)).toEqual(prepared());
    expect(fs.existsSync(journalOrphan)).toBe(false);
    expect(fs.statSync(journalPath()).nlink).toBe(1);

    const lease = store.acquireExecution(TRANSACTION_ID);
    const leasePath = executionPath(".execution-lease.json");
    const leaseOrphan = path.join(
      path.dirname(leasePath),
      `.${path.basename(leasePath)}.${OWNER_TWO}.tmp`,
    );
    fs.linkSync(leasePath, leaseOrphan);
    store.assertExecution(lease);
    expect(fs.existsSync(leaseOrphan)).toBe(false);
    expect(fs.statSync(leasePath).nlink).toBe(1);
    store.releaseExecution(lease);
  });

  it.each([
    [
      "before identity inspection",
      (orphan: string) => {
        const lstatSync = fs.lstatSync.bind(fs);
        vi.spyOn(fs, "lstatSync").mockImplementation(((target, options) => {
          switch (target === orphan) {
            case true:
              fs.unlinkSync(orphan);
              throw Object.assign(new Error("candidate disappeared"), { code: "ENOENT" });
            default:
              return lstatSync(target, options);
          }
        }) as typeof fs.lstatSync);
      },
    ],
    [
      "before unlink",
      (orphan: string) => {
        const unlinkSync = fs.unlinkSync.bind(fs);
        vi.spyOn(fs, "unlinkSync").mockImplementation((target) => {
          switch (target === orphan) {
            case true:
              unlinkSync(orphan);
              throw Object.assign(new Error("candidate disappeared"), { code: "ENOENT" });
            default:
              unlinkSync(target);
          }
        });
      },
    ],
  ])("accepts the exact orphan disappearing %s (#8395)", (_name, arrangeRace) => {
    const store = createHostLocalCreateJournalStore(stateDirectory, {
      createOwnerId: () => OWNER_ONE,
    });
    store.create(prepared());
    const journalOrphan = path.join(
      path.dirname(journalPath()),
      `.${path.basename(journalPath())}.${OWNER_ONE}.tmp`,
    );
    fs.linkSync(journalPath(), journalOrphan);
    arrangeRace(journalOrphan);

    expect(store.load(TRANSACTION_ID)).toEqual(prepared());
    expect(fs.existsSync(journalOrphan)).toBe(false);
  });

  it("preserves a publication error when temporary cleanup also fails (#8395)", () => {
    const store = createHostLocalCreateJournalStore(stateDirectory);
    vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => {
      throw new Error("publication failed");
    });
    vi.spyOn(fs, "unlinkSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("cleanup failed"), { code: "EIO" });
    });

    expect(() => store.create(prepared())).toThrow("publication failed");
  });

  it("lets a live publisher finish when a concurrent reader reconciles its hard link (#8395)", () => {
    const writer = createHostLocalCreateJournalStore(stateDirectory);
    const reader = createHostLocalCreateJournalStore(stateDirectory);
    const linkSync = fs.linkSync.bind(fs);
    let reconciled = false;
    vi.spyOn(fs, "linkSync").mockImplementation((existingPath, newPath) => {
      linkSync(existingPath, newPath);
      switch (!reconciled && newPath === journalPath()) {
        case true:
          reconciled = true;
          expect(reader.load(TRANSACTION_ID)).toEqual(prepared());
      }
    });

    expect(writer.create(prepared())).toEqual(prepared());
    expect(reconciled).toBe(true);
    expect(writer.load(TRANSACTION_ID)).toEqual(prepared());
  });
});
