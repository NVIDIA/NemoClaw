// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  createHermesPortableUninstallJournalStore,
  hermesPortableUninstallJournalInternals,
  type HermesPortableUninstallAuthority,
  type HermesPortableUninstallJournalStore,
  type HermesPortableUninstallPhase,
} from "../../state/hermes-portable-uninstall/journal";

export {
  HERMES_PORTABLE_UNINSTALL_JOURNAL_FILE,
  hermesPortableUninstallJournalPath,
  inspectHermesPortableUninstallJournal,
  type HermesPortableUninstallAuthority,
  type HermesPortableUninstallJournal,
  type HermesPortableUninstallPhase,
  type HermesPortableUninstallTargetAuthority,
} from "../../state/hermes-portable-uninstall/journal";

export interface HermesPortableUninstallTransactionDeps {
  readonly journalStore?: HermesPortableUninstallJournalStore;
  readonly prepare: () => HermesPortableUninstallAuthority;
  readonly prepareReplacement?: () => HermesPortableUninstallAuthority | null;
  readonly revalidateResources: (
    authority: HermesPortableUninstallAuthority,
    phase: HermesPortableUninstallPhase,
  ) => void;
  readonly reconcileSandboxes: (authority: HermesPortableUninstallAuthority) => number;
  readonly reconcileProviders: (authority: HermesPortableUninstallAuthority) => void;
  readonly reconcileInference: (authority: HermesPortableUninstallAuthority) => void;
  readonly verifyResourcesAbsent: (authority: HermesPortableUninstallAuthority) => void;
  readonly retireRegistry: (authority: HermesPortableUninstallAuthority) => void;
  readonly retireLifecycleReceipts: (authority: HermesPortableUninstallAuthority) => void;
  readonly retirePrivateInferenceState: (authority: HermesPortableUninstallAuthority) => void;
  readonly verifyCompleted: (authority: HermesPortableUninstallAuthority) => void;
  readonly afterPhaseAction?: (phase: HermesPortableUninstallPhase) => void;
}

export interface HermesPortableUninstallTransactionResult {
  readonly phase: "completed";
  readonly sandboxContainersRemoved: number;
  readonly targetCount: number;
}

/** Run or resume the exact schema-5 transaction after its lifecycle and registry locks are held. */
export function runHermesPortableUninstallTransaction(
  stateDir: string,
  deps: HermesPortableUninstallTransactionDeps,
): HermesPortableUninstallTransactionResult {
  const journalStore = deps.journalStore ?? createHermesPortableUninstallJournalStore(stateDir);
  let journal = journalStore.read();
  if (!journal) journal = journalStore.publishPrepared(deps.prepare());
  let sandboxContainersRemoved = 0;
  for (;;) {
    const phase = journal.phase;
    if (phase === "completed") {
      const replacement = deps.prepareReplacement?.() ?? null;
      if (replacement) {
        if (journalStore.authoritySha256(replacement) === journal.authoritySha256) {
          throw new Error("Hermes Portable completed journal matches live replacement authority");
        }
        journal = journalStore.replacePrepared(journal, replacement);
        continue;
      }
      deps.verifyCompleted(journal.authority);
      return {
        phase: "completed",
        sandboxContainersRemoved,
        targetCount: journal.authority.targets.length,
      };
    }
    if (phase === "prepared") {
      deps.revalidateResources(journal.authority, phase);
      sandboxContainersRemoved += deps.reconcileSandboxes(journal.authority);
      deps.afterPhaseAction?.(phase);
      journal = journalStore.replacePhase(journal, "sandboxes-retired");
      continue;
    }
    if (phase === "sandboxes-retired") {
      deps.revalidateResources(journal.authority, phase);
      deps.reconcileProviders(journal.authority);
      deps.afterPhaseAction?.(phase);
      journal = journalStore.replacePhase(journal, "providers-retired");
      continue;
    }
    if (phase === "providers-retired") {
      deps.revalidateResources(journal.authority, phase);
      deps.reconcileInference(journal.authority);
      deps.afterPhaseAction?.(phase);
      journal = journalStore.replacePhase(journal, "inference-retired");
      continue;
    }
    if (phase === "inference-retired") {
      deps.revalidateResources(journal.authority, phase);
      deps.verifyResourcesAbsent(journal.authority);
      deps.afterPhaseAction?.(phase);
      journal = journalStore.replacePhase(journal, "resources-absent");
      continue;
    }
    if (phase === "resources-absent") {
      deps.retireRegistry(journal.authority);
      deps.afterPhaseAction?.(phase);
      journal = journalStore.replacePhase(journal, "registry-retired");
      continue;
    }
    if (phase === "registry-retired") {
      deps.retireLifecycleReceipts(journal.authority);
      deps.afterPhaseAction?.(phase);
      journal = journalStore.replacePhase(journal, "receipts-retired");
      continue;
    }
    deps.retirePrivateInferenceState(journal.authority);
    deps.afterPhaseAction?.(phase);
    journal = journalStore.replacePhase(journal, "completed");
  }
}

export const hermesPortableUninstallTransactionInternals = Object.freeze({
  normalizeAuthority: hermesPortableUninstallJournalInternals.normalizeAuthority,
  normalizeJournal: hermesPortableUninstallJournalInternals.normalizeJournal,
});
