// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  fingerprintRebuildRegistryEntry,
  fingerprintRebuildReplacement,
  fingerprintRebuildValue,
  rebuildSessionCorrelation,
} from "../../rebuild-correlation";
import {
  type RebuildRegistryRecoveryV1,
  type RebuildTransactionIntentV1,
  type RebuildTransactionRecordV1,
  type RebuildTransactionStore,
} from "../../state/rebuild-transaction";
import * as sandboxState from "../../state/sandbox";
import type { RebuildBackupManifest } from "./rebuild-backup-phase";
import type { RebuildSandboxEntry } from "./rebuild-flow-helpers";
import type { RebuildRecreateOnboardOpts } from "./rebuild-gpu-opt-out";
import type { RebuildPostRestoreVerification } from "./rebuild-post-restore-phase";
import type { RebuildTargetConfig } from "./rebuild-target-preflight";

export { fingerprintRebuildRegistryEntry, fingerprintRebuildValue };

export function loadRebuildRecovery(
  store: RebuildTransactionStore,
  sandboxName: string,
): {
  transaction: RebuildTransactionRecordV1 | null;
  recoveryManifest: sandboxState.RebuildManifest | null;
} {
  const transaction = store.load(sandboxName);
  if (!transaction || transaction.status === "completed") {
    return { transaction, recoveryManifest: null };
  }
  if (
    fingerprintRebuildRegistryEntry(transaction.intent.source.registryRecovery.entry) !==
    transaction.intent.source.registryFingerprint
  ) {
    throw new Error(
      `Rebuild transaction '${transaction.transactionId}' no longer matches its registry recovery metadata.`,
    );
  }
  const recoveryManifest = sandboxState.getLatestBackup(sandboxName);
  if (
    !recoveryManifest ||
    recoveryManifest.timestamp !== transaction.receipts.backup.manifestTimestamp ||
    fingerprintRebuildValue(recoveryManifest) !== transaction.receipts.backup.manifestFingerprint
  ) {
    throw new Error(
      `Rebuild transaction '${transaction.transactionId}' no longer matches the latest validated backup.`,
    );
  }
  return { transaction, recoveryManifest };
}

async function prepareRebuildTransaction(args: {
  store: RebuildTransactionStore;
  existing: RebuildTransactionRecordV1 | null;
  sandboxName: string;
  sandboxEntry: RebuildSandboxEntry;
  registryRecovery: RebuildRegistryRecoveryV1;
  targetConfig: RebuildTargetConfig;
  recreateOptions: RebuildRecreateOnboardOpts;
  backupManifest: RebuildBackupManifest;
  imageIdentity: unknown;
  legacyManagedImageRecoveryAuthorized: boolean;
  shieldsLocked: boolean;
  oldSandboxPresent: boolean;
}): Promise<RebuildTransactionRecordV1 | null> {
  if (!args.backupManifest) return null;
  const { resumeConfig, durableConfig } = args.targetConfig;
  const intent: RebuildTransactionIntentV1 = {
    sandboxName: args.sandboxName,
    source: {
      agent: args.sandboxEntry.agent ?? null,
      registryFingerprint: fingerprintRebuildRegistryEntry(args.registryRecovery.entry),
      registryRecovery: args.registryRecovery,
      legacyManagedImageRecoveryAuthorized: args.legacyManagedImageRecoveryAuthorized,
      shieldsLocked: args.shieldsLocked,
    },
    target: {
      agent: resumeConfig.agent,
      provider: resumeConfig.provider,
      model: resumeConfig.model,
      credentialEnv: args.targetConfig.credentialEnv,
      endpointFingerprint: resumeConfig.endpointUrl
        ? fingerprintRebuildValue(resumeConfig.endpointUrl)
        : null,
      imageFingerprint: fingerprintRebuildValue(args.imageIdentity),
      configurationFingerprint: fingerprintRebuildValue({
        fromDockerfile: args.targetConfig.fromDockerfile,
        preferredInferenceApi: resumeConfig.preferredInferenceApi,
        compatibleEndpointReasoning: resumeConfig.compatibleEndpointReasoning,
        policyTier: args.recreateOptions.policyTier,
      }),
      gatewayName: args.recreateOptions.targetGatewayName,
      gatewayPort: args.recreateOptions.targetGatewayPort,
      toolDisclosure: durableConfig.toolDisclosure,
      observabilityEnabled: args.recreateOptions.observabilityEnabled,
    },
  };
  const receipts = {
    backup: {
      manifestTimestamp: args.backupManifest.timestamp,
      manifestFingerprint: fingerprintRebuildValue(args.backupManifest),
    },
  };
  if (!args.existing || args.existing.status === "completed") {
    return args.store.create(intent, receipts);
  }
  const intentChanged =
    fingerprintRebuildValue(args.existing.intent) !== fingerprintRebuildValue(intent);
  const backupChanged =
    fingerprintRebuildValue(args.existing.receipts.backup) !==
    fingerprintRebuildValue(receipts.backup);
  if (
    args.existing.phase === "prepared" &&
    args.oldSandboxPresent &&
    (intentChanged || backupChanged)
  ) {
    return args.store.refreshPrepared(args.sandboxName, args.existing.revision, intent, receipts);
  }
  if (intentChanged) {
    throw new Error(
      `Rebuild transaction '${args.existing.transactionId}' intent changed; refusing another destructive effect.`,
    );
  }
  if (backupChanged) {
    throw new Error(
      `Rebuild transaction '${args.existing.transactionId}' recovery inputs changed; refusing another destructive effect.`,
    );
  }
  return args.existing;
}

export class RebuildTransactionCoordinator {
  private transaction: RebuildTransactionRecordV1 | null;

  constructor(
    private readonly store: RebuildTransactionStore,
    private readonly sandboxName: string,
    recovered: RebuildTransactionRecordV1 | null,
  ) {
    this.transaction = recovered;
  }

  get phase(): RebuildTransactionRecordV1["phase"] | null {
    return this.transaction?.phase ?? null;
  }

  get sessionCorrelation() {
    return this.transaction ? rebuildSessionCorrelation(this.transaction) : null;
  }

  async prepare(
    args: Omit<
      Parameters<typeof prepareRebuildTransaction>[0],
      "store" | "existing" | "sandboxName"
    >,
  ): Promise<void> {
    this.transaction = await prepareRebuildTransaction({
      ...args,
      store: this.store,
      existing: this.transaction,
      sandboxName: this.sandboxName,
    });
  }

  async reconcileObservedDeletion(staleRecovery: boolean): Promise<void> {
    if (!staleRecovery || this.transaction?.phase !== "prepared") return;
    this.transaction = await this.store.transition(
      this.sandboxName,
      this.transaction.revision,
      "old_deleted",
      {
        ...this.transaction.receipts,
        oldSandboxDeletion: { observedAt: new Date().toISOString() },
      },
    );
  }

  async markDeleted(): Promise<void> {
    if (this.transaction?.phase !== "prepared") return;
    this.transaction = await this.store.transition(
      this.sandboxName,
      this.transaction.revision,
      "old_deleted",
      {
        ...this.transaction.receipts,
        oldSandboxDeletion: { observedAt: new Date().toISOString() },
      },
    );
  }

  async markReplacementCreated(identity: unknown): Promise<void> {
    if (this.transaction?.phase !== "old_deleted") return;
    this.transaction = await this.store.transition(
      this.sandboxName,
      this.transaction.revision,
      "replacement_created",
      {
        ...this.transaction.receipts,
        replacement: this.replacementReceipt(identity),
      },
    );
  }

  async markReplacementRecreated(identity: unknown): Promise<void> {
    if (this.transaction?.phase !== "replacement_created") return;
    this.transaction = await this.store.refreshReplacementReceipt(
      this.sandboxName,
      this.transaction.revision,
      this.replacementReceipt(identity),
    );
  }

  async recordReplacementFailure(): Promise<void> {
    if (this.transaction?.phase !== "old_deleted") return;
    this.transaction = await this.store.recordFailure(this.sandboxName, this.transaction.revision, {
      code: "REPLACEMENT_RETRY_REQUIRED",
      recordedAt: new Date().toISOString(),
      retryable: true,
    });
  }

  private replacementReceipt(identity: unknown) {
    return {
      identityFingerprint: fingerprintRebuildReplacement(identity as RebuildSandboxEntry),
      observedAt: new Date().toISOString(),
    };
  }

  async finalize(verification: RebuildPostRestoreVerification): Promise<boolean> {
    if (!verification.complete) {
      const code = verification.required[0];
      if (this.transaction?.phase === "replacement_created" && code) {
        try {
          this.transaction = await this.store.recordFailure(
            this.sandboxName,
            this.transaction.revision,
            { code, recordedAt: new Date().toISOString(), retryable: true },
          );
        } catch {
          // Completion remains blocked even when best-effort failure metadata
          // cannot be published; the caller must still emit recovery guidance.
        }
      }
      return false;
    }
    if (this.transaction?.phase === "replacement_created") {
      this.transaction = await this.store.complete(this.sandboxName, this.transaction.revision);
    }
    return true;
  }
}
