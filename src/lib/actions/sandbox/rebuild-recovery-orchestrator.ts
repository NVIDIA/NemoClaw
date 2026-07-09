// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { matchesRebuildTargetRegistry } from "../../rebuild-correlation";
import type { Session } from "../../state/onboard-session";
import type {
  RebuildRegistryRecoveryV1,
  RebuildTransactionRecordV1,
} from "../../state/rebuild-transaction";
import type { SandboxEntry } from "../../state/registry";
import type { ToolDisclosure } from "../../tool-disclosure";
import type { RebuildBackupManifest } from "./rebuild-backup-phase";
import type { RebuildBail, RebuildLog } from "./rebuild-credential-preflight";
import type { DcodeRebuildOrchestrator } from "./rebuild-dcode-orchestrator";
import type { RebuildSandboxEntry } from "./rebuild-flow-helpers";
import type { RebuildRecreateOnboardOpts } from "./rebuild-gpu-opt-out";
import { printRebuildPreflightFailure } from "./rebuild-preflight-error";
import {
  type FingerprintedPreparedBuildContext,
  verifyPreparedBuildContext,
} from "./rebuild-prepared-image-context";
import { observeRebuildSession } from "./rebuild-recovery";
import type { RebuildRecoveryPlan } from "./rebuild-recovery-plan";
import type { RebuildResumeConfig } from "./rebuild-resume-config";
import type { RebuildTargetConfig } from "./rebuild-target-preflight";
import type { RebuildTransactionCoordinator } from "./rebuild-transaction-coordinator";

export interface RebuildRecoveryOrchestratorOptions {
  plan: RebuildRecoveryPlan | null;
  transaction: RebuildTransactionCoordinator;
  recoveredTransaction: RebuildTransactionRecordV1 | null;
  sandboxName: string;
  readRegistryEntry: () => SandboxEntry | null;
  readSession: () => Session | null;
  bail: RebuildBail;
  log: RebuildLog;
}

export interface PrepareRebuildRecoveryTransactionInput {
  sandboxEntry: RebuildSandboxEntry;
  registryRecovery: RebuildRegistryRecoveryV1;
  targetConfig: RebuildTargetConfig;
  recreateOptions: RebuildRecreateOnboardOpts;
  backupManifest: RebuildBackupManifest;
  baseImage: string | null;
  fromDockerfile: string | null;
  legacyManagedImageRecoveryAuthorized: boolean;
  shieldsLocked: boolean;
  staleRecovery: boolean;
}

/** Owns recovery-specific transaction preparation and receipt publication. */
export class RebuildRecoveryOrchestrator {
  constructor(private readonly options: RebuildRecoveryOrchestratorOptions) {
    if (options.plan) options.log(`Durable rebuild recovery selected '${options.plan.action}'`);
  }

  get replacementAlreadyPresent(): boolean {
    return this.options.plan?.replacementAlreadyPresent === true;
  }

  async revalidateReplacementBeforeDelete(input: {
    preparedImage: FingerprintedPreparedBuildContext | null;
    dcodePreflight: DcodeRebuildOrchestrator;
    resumeConfig: RebuildResumeConfig;
    toolDisclosure: ToolDisclosure;
    recoveryRecreate: boolean;
    gatewayPort: number;
  }): Promise<boolean> {
    if (this.replacementAlreadyPresent) return true;
    if (input.preparedImage && !verifyPreparedBuildContext(input.preparedImage)) {
      printRebuildPreflightFailure(
        "the retained replacement image context changed after preflight.",
        "Retry the rebuild so the replacement inputs can be staged again.",
        "Replacement sandbox image context changed before delete",
        this.options.bail,
      );
      return false;
    }
    return input.dcodePreflight.revalidateBeforeDelete(
      input.resumeConfig,
      input.toolDisclosure,
      input.recoveryRecreate,
      input.gatewayPort,
    );
  }

  async prepare(input: PrepareRebuildRecoveryTransactionInput): Promise<void> {
    const { recoveredTransaction, transaction } = this.options;
    const intentSandboxEntry =
      recoveredTransaction?.status === "active"
        ? recoveredTransaction.intent.source.registryRecovery.entry
        : input.sandboxEntry;

    if (
      recoveredTransaction?.status !== "active" ||
      (recoveredTransaction.phase === "prepared" && !input.staleRecovery)
    ) {
      await transaction.prepare({
        sandboxEntry: intentSandboxEntry,
        registryRecovery: input.registryRecovery,
        targetConfig: input.targetConfig,
        recreateOptions: input.recreateOptions,
        backupManifest: input.backupManifest,
        imageIdentity: {
          baseImage: input.baseImage,
          fromDockerfile: input.fromDockerfile,
          recordedImage: intentSandboxEntry.imageTag ?? null,
          nemoclawVersion: intentSandboxEntry.nemoclawVersion ?? null,
        },
        legacyManagedImageRecoveryAuthorized: input.legacyManagedImageRecoveryAuthorized,
        shieldsLocked: input.shieldsLocked,
        oldSandboxPresent: !input.staleRecovery,
      });
    }
    await transaction.reconcileObservedDeletion(input.staleRecovery);
    if (this.options.plan?.action === "adopt") {
      await transaction.markReplacementCreated(this.requireCorrelatedReplacement());
    }
  }

  async publishCreatedReplacement(): Promise<void> {
    const replacement =
      this.options.plan?.action === "recreate"
        ? this.requireCorrelatedReplacement()
        : this.requireReplacement();
    await (this.options.plan?.action === "recreate"
      ? this.options.transaction.markReplacementRecreated(replacement)
      : this.options.transaction.markReplacementCreated(replacement));
  }

  private requireReplacement(): RebuildSandboxEntry {
    return (
      this.options.readRegistryEntry() ??
      this.options.bail(
        "The transaction-correlated replacement disappeared before receipt publication.",
      )
    );
  }

  private requireCorrelatedReplacement(): RebuildSandboxEntry {
    const { transaction, readSession, bail } = this.options;
    const record = transaction.record;
    const replacement = this.requireReplacement();
    if (!record) return bail("The rebuild transaction disappeared before receipt publication.");
    if (
      !matchesRebuildTargetRegistry(record, replacement) ||
      observeRebuildSession(record, readSession(), replacement) !== "matching"
    ) {
      return bail(
        "The replacement identity changed before its durable receipt could be published.",
      );
    }
    return replacement;
  }
}
