// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { decisionSelected } from "../state/onboard-checkpoint-decision";
import { deriveCheckpointFromSession } from "../state/onboard-checkpoint-migrate";
import * as onboardSession from "../state/onboard-session";
import * as registry from "../state/registry";
import { checkpointGatewayAuthority } from "./gateway-authority-checkpoint";
import { resolveGatewayTeardownAuthority } from "./gateway-teardown-authority";
import {
  observeSandboxOnGateway,
  type SandboxRecreateObserver,
  type SandboxRecreateTarget,
} from "./sandbox-recreate-probe";
import {
  beginSandboxRecreateTransaction,
  createSandboxRecreateRuntime,
  fingerprintSandboxRecreateValue,
  planSandboxRecreateRecovery,
  type SandboxRecreateRuntime,
} from "./sandbox-recreate-transaction";

export interface OnboardRecreateTargetIntent {
  readonly agent: string | null;
  readonly fromDockerfile: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly preferredInferenceApi: string | null;
  readonly sandboxGpuConfig: unknown;
  readonly gatewayName: string;
  readonly gatewayPort: number;
  readonly toolDisclosure: string;
  readonly dcodeAutoApprovalMode: string | null;
  readonly observabilityEnabled: boolean;
  readonly policyTier: string | null;
}

export function fingerprintOnboardRecreateTargetIntent(
  intent: OnboardRecreateTargetIntent,
): string {
  return fingerprintSandboxRecreateValue({ version: 1, ...intent });
}

export interface OpenOnboardRecreateJournalInput {
  readonly target: SandboxRecreateTarget;
  readonly agentName: string;
  readonly targetIntentFingerprint: string;
  readonly note: (message: string) => void;
  readonly observe?: SandboxRecreateObserver;
}

export function openOnboardRecreateJournal(
  input: OpenOnboardRecreateJournalInput,
): SandboxRecreateRuntime {
  const { target, agentName, targetIntentFingerprint, note } = input;
  const observe = input.observe ?? observeSandboxOnGateway;
  const authority = resolveGatewayTeardownAuthority({
    gatewayName: target.gatewayName,
    gatewayPort: target.gatewayPort,
  });
  const sourceEntry = registry.getSandbox(target.sandboxName);
  if (!sourceEntry) {
    throw new Error(
      `Cannot start sandbox '${target.sandboxName}' recreate transaction without its source registry row.`,
    );
  }
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
  note(
    `  Journaled replacement ${transaction.id} for '${target.sandboxName}' on ${target.gatewayName}:${String(target.gatewayPort)} at phase '${transaction.phase}'.`,
  );

  return createSandboxRecreateRuntime(
    onboardSession,
    {
      id: transaction.id,
      targetGeneration: transaction.targetGeneration,
      targetIntentFingerprint: transaction.targetIntentFingerprint,
    },
    target.sandboxName,
    target.gatewayName,
    sourceEntry,
    (sandboxName) => observe({ ...target, sandboxName }),
    note,
  );
}
