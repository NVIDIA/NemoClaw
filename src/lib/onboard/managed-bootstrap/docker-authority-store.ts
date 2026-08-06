// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ManagedBootstrapAuthorityStore,
  ManagedBootstrapDurablePreparationReceipt,
  ManagedBootstrapPreparedAuthority,
} from "./adapter";
import {
  createFileDockerManagedBootstrapJournalStore,
  type DockerManagedBootstrapJournal,
  DockerManagedBootstrapJournalAcknowledgementLostError,
  type DockerManagedBootstrapJournalStore,
  parseDockerManagedBootstrapJournal,
  serializeDockerManagedBootstrapJournal,
} from "./docker-journal";

export interface DockerManagedBootstrapAuthorityStoreDependencies {
  readonly journalStore?: DockerManagedBootstrapJournalStore;
  readonly now?: () => Date;
}

function exactPreparedJournal(
  authority: ManagedBootstrapPreparedAuthority,
): DockerManagedBootstrapJournal {
  const journal = parseDockerManagedBootstrapJournal(authority.rollbackAuthority);
  if (
    journal.phase !== "staged" ||
    journal.preparationReceipt !== null ||
    journal.commitReceipt !== null ||
    journal.providerId !== authority.sandbox.driverId ||
    journal.sandbox.sandboxName !== authority.sandbox.sandboxName ||
    journal.sandbox.sandboxId !== authority.sandbox.sandboxId ||
    journal.sandbox.driverId !== authority.sandbox.driverId ||
    journal.bootstrapIdentity !== authority.bootstrapIdentity ||
    journal.planFingerprint !== authority.planFingerprint ||
    journal.profileFingerprint !== authority.profileFingerprint ||
    journal.runtimeImageContentId !== authority.runtimeImageContentId ||
    journal.originalRuntimeId !== authority.originalRuntimeId ||
    journal.replacementRuntimeId !== authority.preparedRuntimeId ||
    journal.originalSpecHash !== authority.originalSpecHash ||
    journal.replacementSpecHash !== authority.expectedActivatedSpecHash ||
    journal.rollbackTargetRuntimeId !== authority.rollbackTargetRuntimeId ||
    journal.rollbackTargetSpecHash !== authority.rollbackTargetSpecHash ||
    journal.imageReference !== `${authority.image.repository}@${authority.image.manifestDigest}`
  ) {
    throw new Error("Managed bootstrap Docker prepared authority does not match its journal.");
  }
  return journal;
}

function durableReceipt(
  authority: ManagedBootstrapPreparedAuthority,
  now: Date,
): ManagedBootstrapDurablePreparationReceipt {
  return Object.freeze({
    schemaVersion: authority.schemaVersion,
    sandbox: authority.sandbox,
    bootstrapIdentity: authority.bootstrapIdentity,
    authorityFingerprint: authority.authorityFingerprint,
    recordId: `docker-managed-bootstrap/${authority.bootstrapIdentity}`,
    recordedAt: now.toISOString(),
  });
}

function sameJournal(
  left: DockerManagedBootstrapJournal,
  right: DockerManagedBootstrapJournal,
): boolean {
  return (
    serializeDockerManagedBootstrapJournal(left) === serializeDockerManagedBootstrapJournal(right)
  );
}

/**
 * Persist prepared cutover authority in the provider's canonical recovery
 * journal before activation can mutate the original runtime.
 */
export function createDockerManagedBootstrapAuthorityStore(
  stateRoot: string,
  dependencies: DockerManagedBootstrapAuthorityStoreDependencies = {},
): ManagedBootstrapAuthorityStore {
  const journalStore =
    dependencies.journalStore ?? createFileDockerManagedBootstrapJournalStore(stateRoot);
  const now = dependencies.now ?? (() => new Date());
  return Object.freeze({
    async recordPreparedAuthority(authority: ManagedBootstrapPreparedAuthority) {
      const prepared = exactPreparedJournal(authority);
      const existing = journalStore.load(authority.bootstrapIdentity);
      if (existing) {
        const receipt = existing.preparationReceipt;
        if (!receipt) {
          throw new Error(
            "Managed bootstrap Docker prepared authority conflicts with its durable journal.",
          );
        }
        const expected = Object.freeze({ ...prepared, preparationReceipt: receipt });
        if (!sameJournal(existing, expected)) {
          throw new Error(
            "Managed bootstrap Docker prepared authority conflicts with its durable journal.",
          );
        }
        return receipt;
      }
      const receipt = durableReceipt(authority, now());
      const expected = Object.freeze({ ...prepared, preparationReceipt: receipt });
      try {
        journalStore.create(expected);
      } catch (error) {
        if (!(error instanceof DockerManagedBootstrapJournalAcknowledgementLostError)) throw error;
        const recovered = journalStore.load(authority.bootstrapIdentity);
        if (!recovered || !sameJournal(recovered, expected)) throw error;
      }
      const persisted = journalStore.load(authority.bootstrapIdentity);
      if (!persisted || !sameJournal(persisted, expected)) {
        throw new Error("Managed bootstrap Docker prepared authority was not durably re-readable.");
      }
      return receipt;
    },
  });
}
