// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  checkpointGatewayAuthority,
  gatewayOwnerFromCheckpoint,
} from "../../onboard/gateway-authority-checkpoint";
import { describeGatewayOwnerForError, sameGatewayOwner } from "../../onboard/gateway-ownership";
import {
  GatewayAuthorityError,
  gatewayAuthorityFailureLines,
  isManagedPackagedServiceMigration,
  resolveGatewayRebuildAuthority,
} from "../../onboard/gateway-teardown-authority";
import {
  observeSandboxOnGateway,
  type SandboxRecreateObserver,
  type SandboxRecreateTarget,
} from "../../onboard/sandbox-recreate-probe";
import {
  advanceSandboxRecreateTransaction,
  beginSandboxRecreateTransaction,
  clearCompletedSandboxRecreateTransaction,
  fingerprintSandboxRecreateValue,
  planSandboxRecreateRecovery,
  type SandboxRecreateSourcePresence,
  sandboxRecreatePhaseReached,
} from "../../onboard/sandbox-recreate-transaction";
import { decisionSelected } from "../../state/onboard-checkpoint-decision";
import { deriveCheckpointFromSession } from "../../state/onboard-checkpoint-migrate";
import type {
  CheckpointGatewayAuthority,
  CheckpointSandboxRecreatePhase,
} from "../../state/onboard-checkpoint-types";
import * as onboardSession from "../../state/onboard-session";
import * as registry from "../../state/registry";
import type { RebuildRecreateOnboardOpts } from "./rebuild-gpu-opt-out";

export type RebuildRecreateJournalTarget = SandboxRecreateTarget;

export type RebuildSandboxObserver = SandboxRecreateObserver;

export type RebuildRecreateSourcePresence = SandboxRecreateSourcePresence;

export interface RebuildRecreateJournal {
  readonly id: string;
  readonly acceptedTarget: boolean;
  readonly sourceConfirmedAbsent: boolean;
  readonly gatewayAuthority: CheckpointGatewayAuthority;
  readonly targetGeneration: string;
  readonly targetIntentFingerprint: string;
  markDeleting(): void;
  observeSourceForDelete(): RebuildRecreateSourcePresence;
  confirmDeleted(): void;
  completeAcceptedTarget(): void;
}

export function fingerprintRebuildRecreateTargetIntent(
  options: Pick<
    RebuildRecreateOnboardOpts,
    | "agent"
    | "endpointSource"
    | "recreateProvider"
    | "recreateModel"
    | "recreatePreferredInferenceApi"
    | "fromDockerfile"
    | "sandboxGpu"
    | "sandboxGpuDevice"
    | "controlUiPort"
    | "hostMounts"
    | "targetGatewayName"
    | "targetGatewayPort"
    | "toolDisclosure"
    | "dcodeAutoApprovalMode"
    | "observabilityEnabled"
  >,
): string {
  const hostMounts = (options.hostMounts ?? []).map(
    ({ source, target, readOnly, sourceIdentity }) => ({
      source,
      target,
      readOnly,
      sourceIdentity: sourceIdentity
        ? { device: sourceIdentity.device, inode: sourceIdentity.inode }
        : null,
    }),
  );
  return fingerprintSandboxRecreateValue({
    version: 1,
    agent: options.agent ?? null,
    endpointSource: options.endpointSource ?? null,
    provider: options.recreateProvider,
    model: options.recreateModel,
    preferredInferenceApi: options.recreatePreferredInferenceApi,
    fromDockerfile: options.fromDockerfile,
    sandboxGpu: options.sandboxGpu,
    sandboxGpuDevice: options.sandboxGpuDevice,
    controlUiPort: options.controlUiPort,
    // Preserve the version-1 fingerprint for existing mount-free journals.
    // A previous journal with mounts did not bind their source identity and
    // must remain incompatible with the stronger fingerprint.
    ...(hostMounts.length > 0 ? { hostMounts } : {}),
    gatewayName: options.targetGatewayName,
    gatewayPort: options.targetGatewayPort,
    toolDisclosure: options.toolDisclosure,
    dcodeAutoApprovalMode: options.dcodeAutoApprovalMode,
    observabilityEnabled: options.observabilityEnabled,
  });
}

export const observeRebuildSandbox = observeSandboxOnGateway;

export interface OpenRebuildRecreateJournalInput {
  readonly target: RebuildRecreateJournalTarget;
  readonly expectedGatewayAuthority: CheckpointGatewayAuthority;
  readonly agentName: string;
  readonly targetIntentFingerprint: string;
  readonly log: (message: string) => void;
  readonly observe?: RebuildSandboxObserver;
  /**
   * Invoked with ready-to-print lines when gateway authority cannot be
   * revalidated, so the command layer can fail cleanly (#8103).
   */
  readonly onAuthorityRefusal?: (lines: readonly string[]) => void;
}

export function openRebuildRecreateJournal(
  input: OpenRebuildRecreateJournalInput,
): RebuildRecreateJournal {
  const { target, agentName, targetIntentFingerprint, log } = input;
  const observe = input.observe ?? observeRebuildSandbox;
  // Authority revalidation runs before the destroy phase. Handing the refusal
  // to the caller lets rebuild report the migration and its remedy instead of
  // crashing with a Node stack trace (#8103). The dedicated rebuild resolver
  // permits its narrowly defined managed-service migration.
  let authority: ReturnType<typeof resolveGatewayRebuildAuthority>;
  try {
    authority = resolveGatewayRebuildAuthority({
      gatewayName: target.gatewayName,
      gatewayPort: target.gatewayPort,
    });
    const expectedAuthority = gatewayOwnerFromCheckpoint(input.expectedGatewayAuthority);
    if (
      !sameGatewayOwner(expectedAuthority, authority) &&
      !isManagedPackagedServiceMigration(expectedAuthority, authority)
    ) {
      throw new GatewayAuthorityError(
        "Gateway lifecycle authority changed after authoritative rebuild preflight " +
          `(${describeGatewayOwnerForError(expectedAuthority)} -> ${describeGatewayOwnerForError(authority)}). ` +
          "Retry the rebuild; the current run will not delete the source sandbox.",
      );
    }
  } catch (error) {
    if (!(error instanceof GatewayAuthorityError)) throw error;
    input.onAuthorityRefusal?.(gatewayAuthorityFailureLines(error, "sandbox rebuild"));
    throw error;
  }
  const gatewayAuthority = checkpointGatewayAuthority(authority);
  const sourceEntry = registry.getSandbox(target.sandboxName);
  const observation = observe(target);
  const active = onboardSession.loadSession()?.checkpoint?.sandboxRecreate ?? null;
  const recovery = active
    ? planSandboxRecreateRecovery(active, observation, sourceEntry)
    : { action: "continue_delete" as const };
  if (recovery.action === "reject") {
    throw new Error(
      `Cannot resume sandbox '${target.sandboxName}' replacement: ${recovery.reason}.`,
    );
  }
  // A registered, ready same-name sandbox carrying the journaled target
  // generation and identity is the replacement this rebuild already proved.
  // The caller must retire the transaction instead of deleting it again.
  const acceptedTarget = recovery.action === "accept_target";

  const session = onboardSession.updateSession((current) => {
    const checkpoint = current.checkpoint ?? deriveCheckpointFromSession(current);
    current.checkpoint = {
      ...checkpoint,
      machineState: current.machine.state,
      updatedAt: new Date().toISOString(),
      sandboxIdentity: decisionSelected({ name: target.sandboxName, agent: agentName }),
      gatewayAuthority: decisionSelected(gatewayAuthority),
    };
    beginSandboxRecreateTransaction(current, {
      sandboxName: target.sandboxName,
      gatewayName: target.gatewayName,
      gatewayPort: target.gatewayPort,
      sourceEntry,
      observation,
      targetIntentFingerprint,
    });
    return current;
  });

  const transaction = session.checkpoint?.sandboxRecreate;
  if (!transaction) {
    throw new Error(
      `Sandbox '${target.sandboxName}' replacement journal could not be recorded before deletion.`,
    );
  }
  log(
    `Journaled replacement ${transaction.id} for '${target.sandboxName}' on ${target.gatewayName}:${String(target.gatewayPort)} at phase '${transaction.phase}'`,
  );

  let phase: CheckpointSandboxRecreatePhase = transaction.phase;
  const advance = (next: CheckpointSandboxRecreatePhase): void => {
    onboardSession.updateSession((current) => {
      phase = advanceSandboxRecreateTransaction(current, transaction.id, next).phase;
      return current;
    });
  };

  return {
    id: transaction.id,
    acceptedTarget,
    sourceConfirmedAbsent: recovery.action === "continue_create",
    gatewayAuthority,
    targetGeneration: transaction.targetGeneration,
    targetIntentFingerprint: transaction.targetIntentFingerprint,
    markDeleting: () => {
      if (sandboxRecreatePhaseReached(phase, "deleted")) return;
      advance("deleting");
    },
    observeSourceForDelete: () => {
      const current = observe(target);
      if (current.state === "missing") return "missing";
      if (
        !transaction.sourceLiveIdentityFingerprint ||
        current.liveIdentityFingerprint !== transaction.sourceLiveIdentityFingerprint
      ) {
        throw new Error(
          `Cannot delete sandbox '${target.sandboxName}': the live same-name sandbox is not the journaled source.`,
        );
      }
      return "source";
    },
    confirmDeleted: () => {
      if (observe(target).state !== "missing") {
        throw new Error(
          `Cannot continue sandbox '${target.sandboxName}' replacement: OpenShell still reports the journaled source after delete.`,
        );
      }
      advance("deleted");
    },
    completeAcceptedTarget: () => {
      if (!acceptedTarget) {
        throw new Error(
          `Sandbox '${target.sandboxName}' replacement journal cannot be retired before its replacement is proven.`,
        );
      }
      for (const next of ["registry_committing", "completed"] as const) {
        if (!sandboxRecreatePhaseReached(phase, next)) advance(next);
      }
      onboardSession.updateSession((current) => {
        clearCompletedSandboxRecreateTransaction(current, transaction.id);
        return current;
      });
    },
  };
}
