// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { captureOpenshell } from "../../adapters/openshell/runtime";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "../../adapters/openshell/timeouts";
import { checkpointGatewayAuthority } from "../../onboard/gateway-authority-checkpoint";
import { resolveGatewayTeardownAuthority } from "../../onboard/gateway-teardown-authority";
import {
  advanceSandboxRecreateTransaction,
  beginSandboxRecreateTransaction,
  fingerprintSandboxLiveIdentity,
  fingerprintSandboxRecreateValue,
  planSandboxRecreateRecovery,
  type SandboxRecreateObservation,
  sandboxRecreatePhaseReached,
} from "../../onboard/sandbox-recreate-transaction";
import { parseSandboxPhase } from "../../state/gateway";
import { decisionSelected } from "../../state/onboard-checkpoint-decision";
import { deriveCheckpointFromSession } from "../../state/onboard-checkpoint-migrate";
import type { CheckpointSandboxRecreatePhase } from "../../state/onboard-checkpoint-types";
import * as onboardSession from "../../state/onboard-session";
import * as registry from "../../state/registry";
import { isExplicitMissingSandboxGatewayOutput } from "./gateway-state";
import type { RebuildRecreateOnboardOpts } from "./rebuild-gpu-opt-out";

export interface RebuildRecreateJournalTarget {
  readonly sandboxName: string;
  readonly gatewayName: string;
  readonly gatewayPort: number;
}

export type RebuildSandboxObserver = (
  target: RebuildRecreateJournalTarget,
) => SandboxRecreateObservation;

export interface RebuildRecreateJournal {
  readonly id: string;
  readonly targetGeneration: string;
  readonly targetIntentFingerprint: string;
  markDeleting(): void;
  confirmDeleted(): void;
}

export function fingerprintRebuildRecreateTargetIntent(
  options: Pick<
    RebuildRecreateOnboardOpts,
    | "agent"
    | "fromDockerfile"
    | "sandboxGpu"
    | "sandboxGpuDevice"
    | "controlUiPort"
    | "targetGatewayName"
    | "targetGatewayPort"
    | "toolDisclosure"
    | "dcodeAutoApprovalMode"
    | "observabilityEnabled"
    | "policyTier"
  >,
): string {
  return fingerprintSandboxRecreateValue({
    version: 1,
    agent: options.agent ?? null,
    fromDockerfile: options.fromDockerfile,
    sandboxGpu: options.sandboxGpu,
    sandboxGpuDevice: options.sandboxGpuDevice,
    controlUiPort: options.controlUiPort,
    gatewayName: options.targetGatewayName,
    gatewayPort: options.targetGatewayPort,
    toolDisclosure: options.toolDisclosure,
    dcodeAutoApprovalMode: options.dcodeAutoApprovalMode,
    observabilityEnabled: options.observabilityEnabled,
    policyTier: options.policyTier,
  });
}

export function observeRebuildSandbox(
  target: RebuildRecreateJournalTarget,
): SandboxRecreateObservation {
  const probe = captureOpenshell(["sandbox", "get", "-g", target.gatewayName, target.sandboxName], {
    ignoreError: true,
    includeStderr: true,
    includeStreams: true,
    timeout: OPENSHELL_PROBE_TIMEOUT_MS,
  });
  const stdout = String(probe.stdout ?? (probe.status === 0 ? probe.output : "")).trim();
  const combined = `${stdout}\n${String(probe.stderr ?? probe.output ?? "")}`.trim();
  const failedCleanly =
    !probe.error && !probe.signal && probe.status !== null && probe.status !== 0;
  if (failedCleanly && isExplicitMissingSandboxGatewayOutput(combined, target.sandboxName)) {
    return { state: "missing", liveIdentityFingerprint: null };
  }
  if (probe.status === 0 && stdout.length > 0) {
    const liveIdentityFingerprint = fingerprintSandboxLiveIdentity(stdout);
    if (!liveIdentityFingerprint) {
      throw new Error(
        `Cannot journal sandbox '${target.sandboxName}' replacement: OpenShell did not report a stable sandbox Id on gateway '${target.gatewayName}'.`,
      );
    }
    const phase = parseSandboxPhase(combined);
    return {
      state: phase === "Ready" || phase === "Running" ? "ready" : "not_ready",
      liveIdentityFingerprint,
    };
  }
  throw new Error(
    `Cannot journal sandbox '${target.sandboxName}' replacement: gateway '${target.gatewayName}' reported neither a live sandbox nor explicit absence.`,
  );
}

export interface OpenRebuildRecreateJournalInput {
  readonly target: RebuildRecreateJournalTarget;
  readonly agentName: string;
  readonly targetIntentFingerprint: string;
  readonly log: (message: string) => void;
  readonly observe?: RebuildSandboxObserver;
}

export function openRebuildRecreateJournal(
  input: OpenRebuildRecreateJournalInput,
): RebuildRecreateJournal {
  const { target, agentName, targetIntentFingerprint, log } = input;
  const observe = input.observe ?? observeRebuildSandbox;
  const authority = resolveGatewayTeardownAuthority({
    gatewayName: target.gatewayName,
    gatewayPort: target.gatewayPort,
  });
  const sourceEntry = registry.getSandbox(target.sandboxName);
  const observation = observe(target);
  const active = onboardSession.loadSession()?.checkpoint?.sandboxRecreate ?? null;
  if (active) {
    const recovery = planSandboxRecreateRecovery(active, observation, sourceEntry);
    if (recovery.action === "reject") {
      throw new Error(
        `Cannot resume sandbox '${target.sandboxName}' replacement: ${recovery.reason}.`,
      );
    }
  }

  const session = onboardSession.updateSession((current) => {
    const checkpoint = current.checkpoint ?? deriveCheckpointFromSession(current);
    current.checkpoint = {
      ...checkpoint,
      machineState: current.machine.state,
      updatedAt: new Date().toISOString(),
      sandboxIdentity: decisionSelected({ name: target.sandboxName, agent: agentName }),
      gatewayAuthority: decisionSelected(checkpointGatewayAuthority(authority)),
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
    targetGeneration: transaction.targetGeneration,
    targetIntentFingerprint: transaction.targetIntentFingerprint,
    markDeleting: () => {
      if (sandboxRecreatePhaseReached(phase, "deleted")) return;
      advance("deleting");
    },
    confirmDeleted: () => {
      if (observe(target).state !== "missing") {
        throw new Error(
          `Cannot continue sandbox '${target.sandboxName}' replacement: OpenShell still reports the journaled source after delete.`,
        );
      }
      advance("deleted");
    },
  };
}
