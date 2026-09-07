// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  enforceManagedBootstrapRecoveryForSandbox,
  ManagedBootstrapRecoveryBlockedError,
  recoverManagedBootstrapTransactions,
} from "./adapter";
import { createDockerManagedBootstrapAdapter } from "./docker";
import {
  type DockerManagedBootstrapJournalStore,
  DockerManagedBootstrapLegacyRecordRequiresAgentError,
} from "./docker-journal";
import {
  authority,
  type DockerFixtureOptions,
  durablePreparation,
  fixture,
  IDENTITY,
  NEW_ID,
  OLD_ID,
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

function expectEventBefore(events: readonly string[], before: string, after: string): void {
  expect(events).toContain(before);
  expect(events).toContain(after);
  expect(events.indexOf(before)).toBeLessThan(events.indexOf(after));
}

function dockerMutationEvents(events: readonly string[]): readonly string[] {
  return events.filter((event) => /^(?:create:|rename:|rm:|start:|stop:)/u.test(event));
}

describe("Docker managed bootstrap restart recovery", () => {
  it("scopes an exact legacy journal to its durable sandbox without inventing agent authority", async () => {
    const fake = fixture();
    const delegate = fake.deps.journalStore as DockerManagedBootstrapJournalStore;
    const legacyStore: DockerManagedBootstrapJournalStore = {
      ...delegate,
      listUnfinishedIdentities: () => [IDENTITY],
      load() {
        throw new DockerManagedBootstrapLegacyRecordRequiresAgentError({
          bootstrapIdentity: IDENTITY,
          journalContext: {
            schemaVersion: 2,
            phase: "cutover",
            bootstrapIdentity: IDENTITY,
            providerId: "docker",
            sandbox: authority().handle.sandbox,
            originalRuntimeId: OLD_ID,
            replacementRuntimeId: NEW_ID,
          },
          recordKind: "journal",
          schemaVersion: 2,
        });
      },
    };
    const adapter = createDockerManagedBootstrapAdapter({
      ...fake.deps,
      journalStore: legacyStore,
    });

    const report = await recoverManagedBootstrapTransactions(adapter);
    expect(report).toMatchObject({
      receipts: [],
      failures: [
        {
          bootstrapIdentity: IDENTITY,
          providerId: "docker",
          sourcePhase: null,
          sandbox: authority().handle.sandbox,
          code: "legacy-agent-required",
          blockingScope: "sandbox",
          retryable: true,
          detail: expect.stringContaining(OLD_ID),
        },
      ],
    });
    const warn = vi.fn();
    expect(enforceManagedBootstrapRecoveryForSandbox(report, "bravo", warn)).toBe(report);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unrelated sandbox 'alpha'"));
    expect(() => enforceManagedBootstrapRecoveryForSandbox(report, "alpha", warn)).toThrow(
      ManagedBootstrapRecoveryBlockedError,
    );
    expect(dockerMutationEvents(fake.events)).toEqual([]);
    expect(fake.events).toEqual([]);
    expect(fake.journal).toBeNull();
  });

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
  }[])("retains owner cleanup after a process restart from the durable $label phase", async ({
    options,
    phase,
  }) => {
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
    await expect(restarted.recoverUnfinishedTransactions()).resolves.toMatchObject({
      receipts: [],
      failures: [
        {
          bootstrapIdentity: IDENTITY,
          sourcePhase: "owner-cleanup-required",
          code: "owner-cleanup-required",
          blockingScope: "sandbox",
          retryable: true,
        },
      ],
    });
    expect(fake.journal?.phase).toBe("owner-cleanup-required");
    expect(fake.finalization).toBeNull();
    expect(fake.replacement).toBeNull();
    expect(fake.original?.State?.Running).toBe(false);
    expectEventBefore(fake.events, `rm:${NEW_ID}`, "journal:owner-cleanup-required");

    const ownerTransitions = fake.events.filter(
      (event) => event === "journal:owner-cleanup-required",
    ).length;
    const mutationsAfterFirstRecovery = dockerMutationEvents(fake.events);
    await expect(restarted.recoverUnfinishedTransactions()).resolves.toMatchObject({
      receipts: [],
      failures: [{ code: "owner-cleanup-required" }],
    });
    expect(fake.events.filter((event) => event === "journal:owner-cleanup-required")).toHaveLength(
      ownerTransitions,
    );
    expect(fake.journal?.phase).toBe("owner-cleanup-required");
    expect(fake.finalization).toBeNull();
    expect(dockerMutationEvents(fake.events)).toEqual(mutationsAfterFirstRecovery);

    fake.removeOriginalExternally();
    await expect(restarted.recoverUnfinishedTransactions()).resolves.toMatchObject({
      receipts: [
        {
          bootstrapIdentity: IDENTITY,
          sourcePhase: "owner-cleanup-required",
          outcome: "rolled-back",
        },
      ],
      failures: [],
    });
    expect(fake.journal).toBeNull();
    expect(fake.finalization?.phase).toBe("rolled-back");
    expect(fake.replacement).toBeNull();
    await expect(restarted.recoverUnfinishedTransactions()).resolves.toEqual({
      receipts: [],
      failures: [],
    });
  });

  it("publishes owner cleanup only after shared rollback, replacement cleanup, and restoration", async () => {
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
    await expect(restarted.recoverUnfinishedTransactions()).resolves.toMatchObject({
      receipts: [],
      failures: [{ sourcePhase: "owner-cleanup-required", code: "owner-cleanup-required" }],
    });
    expect(fake.sharedState).toBe("none");
    expect(fake.replacement).toBeNull();
    expect(fake.original?.State?.Running).toBe(false);
    expect(fake.journal?.phase).toBe("owner-cleanup-required");
    expect(fake.finalization).toBeNull();
    expectEventBefore(fake.events, "shared:rollback", `rm:${NEW_ID}`);
    expectEventBefore(fake.events, `rm:${NEW_ID}`, "journal:owner-cleanup-required");

    const mutationsAfterFirstRecovery = dockerMutationEvents(fake.events);
    await expect(restarted.recoverUnfinishedTransactions()).resolves.toMatchObject({
      receipts: [],
      failures: [{ sourcePhase: "owner-cleanup-required", code: "owner-cleanup-required" }],
    });
    expect(dockerMutationEvents(fake.events)).toEqual(mutationsAfterFirstRecovery);

    fake.removeOriginalExternally();
    await expect(restarted.recoverUnfinishedTransactions()).resolves.toMatchObject({
      receipts: [{ outcome: "rolled-back", sourcePhase: "owner-cleanup-required" }],
      failures: [],
    });
  });

  it("retains owner authority while exact runtime presence is unknown", async () => {
    const fake = fixture({
      journalCreateFailures: [new Error("injected crash after durable staged fence")],
    });
    const transaction = await prepareTransaction(fake);
    await expect(
      transaction.adapter.activateBootstrapReplacement({
        handle: transaction.handle,
        snapshot: transaction.snapshot,
        prepared: transaction.prepared,
        durablePreparation: transaction.durable,
      }),
    ).rejects.toThrow("crash after durable staged fence");

    const restarted = createDockerManagedBootstrapAdapter(fake.deps);
    await restarted.recoverUnfinishedTransactions();
    expect(fake.journal?.phase).toBe("owner-cleanup-required");
    fake.setDockerInspectUnknown(OLD_ID, true);

    await expect(restarted.recoverUnfinishedTransactions()).resolves.toMatchObject({
      receipts: [],
      failures: [
        {
          sourcePhase: "owner-cleanup-required",
          code: "commit-state-indeterminate",
          blockingScope: "sandbox",
          retryable: true,
        },
      ],
    });
    expect(fake.journal?.phase).toBe("owner-cleanup-required");
    expect(fake.finalization).toBeNull();

    fake.setDockerInspectUnknown(OLD_ID, false);
    fake.removeOriginalExternally();
    await expect(restarted.recoverUnfinishedTransactions()).resolves.toMatchObject({
      receipts: [{ outcome: "rolled-back" }],
      failures: [],
    });
  });

  it("retains durable commit authority when image receipt retirement fails", async () => {
    const fake = fixture({
      agent: "langchain-deepagents-code",
      dockerRemoveFailures: [new Error("injected crash before exact Docker removal")],
      sharedReceiptClearFailures: [new Error("injected image receipt cleanup failure")],
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
    await expect(restarted.recoverUnfinishedTransactions()).resolves.toMatchObject({
      receipts: [],
      failures: [
        {
          sourcePhase: "shared-state-committed",
          code: "durable-cleanup-pending",
          blockingScope: "sandbox",
          retryable: true,
        },
      ],
    });
    expect(fake.journal?.phase).toBe("shared-state-committed");
    expect(fake.finalization).toBeNull();
    expect(fake.sharedState).toBe("committed");

    const mutationsAfterFailedRetirement = dockerMutationEvents(fake.events);
    await expect(restarted.recoverUnfinishedTransactions()).resolves.toMatchObject({
      receipts: [{ outcome: "committed", sourcePhase: "shared-state-committed" }],
      failures: [],
    });
    expect(fake.journal).toBeNull();
    expect(fake.finalization?.phase).toBe("committed");
    expect(fake.sharedState).toBe("none");
    expect(dockerMutationEvents(fake.events)).toEqual(mutationsAfterFailedRetirement);
  });

  it("retains durable commit authority after a non-zero Docker removal result", async () => {
    const fake = fixture({
      dockerRemoveFailures: [new Error("injected crash before exact Docker removal")],
      dockerRemoveResults: [{ status: 1, stderr: "injected non-zero Docker removal" }],
      sharedState: "pending",
    });
    const transaction = await prepareTransaction(fake);
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

    const restarted = createDockerManagedBootstrapAdapter(fake.deps);
    await expect(restarted.recoverUnfinishedTransactions()).resolves.toMatchObject({
      receipts: [],
      failures: [
        {
          sourcePhase: "shared-state-committed",
          code: "durable-cleanup-pending",
          detail: expect.stringContaining("injected non-zero Docker removal"),
        },
      ],
    });
    expect(fake.journal?.phase).toBe("shared-state-committed");
    expect(fake.finalization).toBeNull();
    expect(fake.original).not.toBeNull();

    await expect(restarted.recoverUnfinishedTransactions()).resolves.toMatchObject({
      receipts: [{ sourcePhase: "shared-state-committed", outcome: "committed" }],
      failures: [],
    });
    expect(fake.journal).toBeNull();
    expect(fake.finalization?.phase).toBe("committed");
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

    const restarted = createDockerManagedBootstrapAdapter(fake.deps);
    await expect(restarted.recoverUnfinishedTransactions()).resolves.toMatchObject({
      receipts: [],
      failures: [
        {
          sourcePhase: "shared-state-committed",
          code: "provider-recovery-failed",
          detail: "injected crash before terminal journal removal",
        },
      ],
    });
    expect(fake.journal?.phase).toBe("shared-state-committed");
    expect(fake.finalization?.phase).toBe("committed");

    const resumed = createDockerManagedBootstrapAdapter(fake.deps);
    await expect(resumed.recoverUnfinishedTransactions()).resolves.toMatchObject({
      receipts: [{ sourcePhase: "shared-state-committed", outcome: "committed" }],
      failures: [],
    });
    expect(fake.journal).toBeNull();
    expect(fake.sharedState).toBe("none");
    expect(fake.replacement?.State?.Running).toBe(true);
  });

  it("isolates identity-first failures and returns bounded lossless mixed evidence", async () => {
    const fake = fixture({
      dockerRemoveFailures: [new Error("injected crash before exact Docker removal")],
      journalRemoveFailures: [new Error("injected crash before terminal journal removal")],
      sharedState: "pending",
    });
    const transaction = await prepareTransaction(fake);
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
    await createDockerManagedBootstrapAdapter(fake.deps).recoverUnfinishedTransactions();
    expect(fake.finalization?.phase).toBe("committed");
    expect(fake.journal).not.toBeNull();

    const badIdentity = "0".repeat(64);
    const delegate = fake.deps.journalStore as DockerManagedBootstrapJournalStore;
    const failUnreadableRecord = (): never => {
      throw new Error(`${"💥".repeat(3000)}\0tail`);
    };
    const mixedStore: DockerManagedBootstrapJournalStore = {
      ...delegate,
      listUnfinishedIdentities: () => [badIdentity, IDENTITY],
      load(bootstrapIdentity) {
        return bootstrapIdentity === badIdentity
          ? failUnreadableRecord()
          : delegate.load(bootstrapIdentity);
      },
    };
    const adapter = createDockerManagedBootstrapAdapter({ ...fake.deps, journalStore: mixedStore });

    const report = await recoverManagedBootstrapTransactions(adapter);

    expect(report.receipts).toMatchObject([
      { bootstrapIdentity: IDENTITY, sourcePhase: "shared-state-committed", outcome: "committed" },
    ]);
    expect(report.failures).toMatchObject([
      {
        bootstrapIdentity: badIdentity,
        providerId: "docker",
        sourcePhase: null,
        sandbox: null,
        code: "provider-recovery-failed",
      },
    ]);
    expect(report.failures[0]?.detail).not.toContain("\0");
    expect(Buffer.byteLength(report.failures[0]?.detail ?? "", "utf8")).toBeLessThanOrEqual(8192);
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.receipts)).toBe(true);
    expect(Object.isFrozen(report.failures)).toBe(true);
    expect(report.receipts.every(Object.isFrozen)).toBe(true);
    expect(report.failures.every(Object.isFrozen)).toBe(true);
    expect(fake.journal).toBeNull();
  });
});
