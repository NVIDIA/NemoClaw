// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { matchesRebuildTargetRegistry } from "../../rebuild-correlation";
import type { Session } from "../../state/onboard-session";
import type { SandboxEntry } from "../../state/registry";
import type { ToolDisclosure } from "../../tool-disclosure";
import type { RebuildBail, RebuildLog } from "./rebuild-credential-preflight";
import type { DcodeRebuildOrchestrator } from "./rebuild-dcode-orchestrator";
import type { RebuildSandboxEntry } from "./rebuild-flow-helpers";
import { printRebuildPreflightFailure } from "./rebuild-preflight-error";
import {
  type FingerprintedPreparedBuildContext,
  verifyPreparedBuildContext,
} from "./rebuild-prepared-image-context";
import { observeRebuildSession, type RebuildRecoveryAction } from "./rebuild-recovery";
import type { RebuildResumeConfig } from "./rebuild-resume-config";
import type {
  RebuildTransactionCoordinator,
  StartOrResumeRebuildTransactionInput,
} from "./rebuild-transaction-coordinator";

export interface RebuildRecoveryOrchestratorOptions {
  plan: RebuildRecoveryAction | null;
  transaction: RebuildTransactionCoordinator;
  sandboxName: string;
  readRegistryEntry: () => SandboxEntry | null;
  readSession: () => Session | null;
  bail: RebuildBail;
  log: RebuildLog;
}

/** Owns recovery-specific transaction preparation and receipt publication. */
export class RebuildRecoveryOrchestrator {
  constructor(private readonly options: RebuildRecoveryOrchestratorOptions) {
    if (options.plan) options.log(`Durable rebuild recovery selected '${options.plan}'`);
  }

  get replacementAlreadyPresent(): boolean {
    return this.options.plan === "adopt" || this.options.plan === "resume";
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

  async prepare(input: StartOrResumeRebuildTransactionInput): Promise<void> {
    await this.options.transaction.startOrResume(input);
    if (this.options.plan === "adopt") {
      await this.options.transaction.markReplacementCreated(this.requireCorrelatedReplacement());
    }
  }

  async publishCreatedReplacement(): Promise<void> {
    const replacement =
      this.options.plan === "recreate"
        ? this.requireCorrelatedReplacement()
        : this.requireReplacement();
    await (this.options.plan === "recreate"
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
