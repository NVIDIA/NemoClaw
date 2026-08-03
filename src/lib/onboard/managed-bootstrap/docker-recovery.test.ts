// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { createDockerManagedBootstrapAdapter } from "./docker";
import type { DockerManagedBootstrapJournalStore } from "./docker-journal";
import {
  authority,
  type DockerFixtureOptions,
  durablePreparation,
  fixture,
} from "./docker-test-fixture";

async function prepareTransaction(
  fake: ReturnType<typeof fixture>,
  agent: Parameters<typeof authority>[0] = "hermes",
) {
  const adapter = createDockerManagedBootstrapAdapter(fake.deps);
  const { handle, request, snapshot } = authority(agent);
  const prepared = await adapter.prepareBootstrapReplacement({
    handle,
    snapshot,
    request,
    replacementOptions: { values: {} },
  });
  return {
    adapter,
    handle,
    prepared,
    snapshot,
    durable: durablePreparation(handle, snapshot, prepared),
  };
}

describe("Docker managed bootstrap restart recovery", () => {
  it.each([
    {
      label: "staged",
      options: {
        journalCreateFailures: [new Error("injected crash after durable staged fence")],
      },
      phase: "staged",
    },
    {
      label: "cutover",
      options: {
        journalTransitionFailures: {
          cutover: new Error("injected crash after durable cutover fence"),
        },
      },
      phase: "cutover",
    },
  ] satisfies readonly {
    readonly label: string;
    readonly options: DockerFixtureOptions;
    readonly phase: "cutover" | "staged";
  }[])("reconciles a process restart from the durable $label phase", async ({ options, phase }) => {
    const fake = fixture(options);
    const transaction = await prepareTransaction(fake);

    await expect(
      transaction.adapter.activateBootstrapReplacement({
        handle: transaction.handle,
        snapshot: transaction.snapshot,
        prepared: transaction.prepared,
        durablePreparation: transaction.durable,
      }),
    ).rejects.toThrow(`crash after durable ${phase} fence`);
    expect(fake.journal?.phase).toBe(phase);

    const restarted = createDockerManagedBootstrapAdapter(fake.deps);
    await expect(restarted.recoverUnfinishedTransactions()).resolves.toMatchObject([
      { sourcePhase: phase, outcome: "rolled-back" },
    ]);
    expect(fake.journal).toBeNull();
    expect(fake.finalization?.phase).toBe("rolled-back");
    expect(fake.replacement).toBeNull();
    expect(fake.original?.State?.Running).toBe(true);
    await expect(restarted.recoverUnfinishedTransactions()).resolves.toEqual([]);
  });

  it("finishes rollback-authorized recovery after shared-state rollback is interrupted", async () => {
    const fake = fixture({
      agent: "openclaw",
      journalTransitionFailures: {
        "rollback-authorized": new Error("injected crash after durable rollback fence"),
      },
      sharedState: "pending",
    });
    const transaction = await prepareTransaction(fake, "openclaw");
    const replacement = await transaction.adapter.activateBootstrapReplacement({
      handle: transaction.handle,
      snapshot: transaction.snapshot,
      prepared: transaction.prepared,
      durablePreparation: transaction.durable,
    });

    await expect(
      transaction.adapter.finalizeBootstrap({
        outcome: "rollback",
        handle: transaction.handle,
        snapshot: transaction.snapshot,
        prepared: transaction.prepared,
        durablePreparation: transaction.durable,
        replacement,
        completion: null,
      }),
    ).rejects.toThrow("crash after durable rollback fence");
    expect(fake.journal?.phase).toBe("rollback-authorized");
    expect(fake.sharedState).toBe("pending");

    const restarted = createDockerManagedBootstrapAdapter(fake.deps);
    await expect(restarted.recoverUnfinishedTransactions()).resolves.toMatchObject([
      { sourcePhase: "rollback-authorized", outcome: "rolled-back" },
    ]);
    expect(fake.sharedState).toBe("none");
    expect(fake.replacement).toBeNull();
    expect(fake.original?.State?.Running).toBe(true);
  });

  it("compacts a terminal commit journal after another restart interruption", async () => {
    const fake = fixture({
      agent: "langchain-deepagents-code",
      dockerRemoveFailures: [new Error("injected crash before exact Docker removal")],
      journalRemoveFailures: [new Error("injected crash before terminal journal removal")],
      sharedState: "pending",
    });
    const transaction = await prepareTransaction(fake, "langchain-deepagents-code");
    const replacement = await transaction.adapter.activateBootstrapReplacement({
      handle: transaction.handle,
      snapshot: transaction.snapshot,
      prepared: transaction.prepared,
      durablePreparation: transaction.durable,
    });
    const completion = await transaction.adapter.awaitBootstrap({
      handle: transaction.handle,
      snapshot: transaction.snapshot,
      replacement,
      timeoutSecs: 1,
    });

    await expect(
      transaction.adapter.finalizeBootstrap({
        outcome: "commit",
        handle: transaction.handle,
        snapshot: transaction.snapshot,
        prepared: transaction.prepared,
        durablePreparation: transaction.durable,
        replacement,
        completion,
      }),
    ).rejects.toThrow("crash before exact Docker removal");
    expect(fake.journal?.phase).toBe("shared-state-committed");
    expect(fake.sharedState).toBe("committed");

    const restarted = createDockerManagedBootstrapAdapter(fake.deps);
    await expect(restarted.recoverUnfinishedTransactions()).rejects.toThrow(
      "crash before terminal journal removal",
    );
    expect(fake.journal?.phase).toBe("shared-state-committed");
    expect(fake.finalization?.phase).toBe("committed");

    const journalStore = fake.deps.journalStore;
    if (!journalStore) throw new Error("fixture journal store is missing");
    const reorderedFinalizationStore = {
      ...journalStore,
      loadFinalization(bootstrapIdentity: string) {
        const record = journalStore.loadFinalization(bootstrapIdentity);
        const receipt = record?.commitReceipt;
        if (!record || !receipt) return record;
        return {
          ...record,
          commitReceipt: {
            completedAt: receipt.completedAt,
            transactionPending: receipt.transactionPending,
            bootstrapIdentity: receipt.bootstrapIdentity,
            profileFingerprint: receipt.profileFingerprint,
            replacementSpecHash: receipt.replacementSpecHash,
            originalSpecHash: receipt.originalSpecHash,
            runtimeImageContentId: receipt.runtimeImageContentId,
            image: receipt.image,
            runtimeId: receipt.runtimeId,
            sandbox: receipt.sandbox,
            schemaVersion: receipt.schemaVersion,
          } satisfies typeof receipt,
        };
      },
    } satisfies DockerManagedBootstrapJournalStore;
    const resumed = createDockerManagedBootstrapAdapter({
      ...fake.deps,
      journalStore: reorderedFinalizationStore,
    });
    await expect(resumed.recoverUnfinishedTransactions()).resolves.toMatchObject([
      { sourcePhase: "shared-state-committed", outcome: "committed" },
    ]);
    expect(fake.journal).toBeNull();
    expect(fake.sharedState).toBe("none");
    expect(fake.replacement?.State?.Running).toBe(true);
  });
});
