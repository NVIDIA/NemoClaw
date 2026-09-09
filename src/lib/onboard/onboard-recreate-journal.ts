// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { decisionSelected } from "../state/onboard-checkpoint-decision";
import * as onboardSession from "../state/onboard-session";
import * as registry from "../state/registry";
import { checkpointGatewayAuthority } from "./gateway-authority-checkpoint";
import { sameGatewayOwner } from "./gateway-ownership";
import { resolveGatewayTeardownAuthority } from "./gateway-teardown-authority";
import {
  observeSandboxOnGateway,
  type SandboxRecreateObserver,
  type SandboxRecreateTarget,
} from "./sandbox-recreate-probe";
import {
  abandonSandboxRecreateTransaction,
  advanceSandboxRecreateTransaction,
  clearCompletedSandboxRecreateTransaction,
  createSandboxRecreateRuntime,
  fingerprintSandboxRecreateValue,
  ownSandboxRecreateTransaction,
  type SandboxRecreateRuntime,
  sandboxRecreatePhaseReached,
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
}

export function fingerprintOnboardRecreateTargetIntent(
  intent: OnboardRecreateTargetIntent,
): string {
  return fingerprintSandboxRecreateValue({ version: 1, ...intent });
}

export interface ManagedMcpRecreateRefusal {
  readonly sandboxName: string;
  readonly cliName: string;
  readonly toolDisclosure: string;
  readonly rebuildFlag: string;
  readonly observabilityFlag: string | null;
}

export function managedMcpRecreateRefusalHints(input: ManagedMcpRecreateRefusal): string[] {
  const observability = input.observabilityFlag ? ` ${input.observabilityFlag}` : "";
  return [
    `  Sandbox '${input.sandboxName}' has managed MCP servers. Refusing the generic onboard recreation path.`,
    `  Run \`${input.cliName} ${input.sandboxName} rebuild --yes --tool-disclosure ${input.toolDisclosure}${observability}${input.rebuildFlag}\` so MCP providers and adapter state are preserved transactionally.`,
  ];
}

export interface OpenOnboardRecreateJournalInput {
  readonly target: SandboxRecreateTarget;
  readonly agentName: string;
  readonly intent: OnboardRecreateTargetIntent;
  readonly note: (message: string) => void;
  readonly observe?: SandboxRecreateObserver;
}

export type OwnedSandboxRecreateRuntime = SandboxRecreateRuntime & {
  complete(): void;
  abandon(): void;
};

/** Capture gateway lifecycle authority and return its delete-edge revalidator. */
export function createOnboardRecreateGatewayAuthorityRevalidator(target: SandboxRecreateTarget): {
  authority: ReturnType<typeof resolveGatewayTeardownAuthority>;
  revalidate: () => void;
} {
  const authority = resolveGatewayTeardownAuthority(target);
  return {
    authority,
    revalidate: () => {
      const currentAuthority = resolveGatewayTeardownAuthority(target);
      if (!sameGatewayOwner(authority, currentAuthority)) {
        throw new Error(
          `Cannot delete sandbox '${target.sandboxName}': its gateway lifecycle authority changed.`,
        );
      }
    },
  };
}

export function openOnboardRecreateJournal(
  input: OpenOnboardRecreateJournalInput,
): OwnedSandboxRecreateRuntime {
  const { target, agentName, note } = input;
  const targetIntentFingerprint = fingerprintOnboardRecreateTargetIntent(input.intent);
  const observe = input.observe ?? observeSandboxOnGateway;
  const gatewayAuthority = createOnboardRecreateGatewayAuthorityRevalidator(target);
  const { authority } = gatewayAuthority;
  const owned = ownSandboxRecreateTransaction({
    sessionStore: {
      loadSession: onboardSession.loadSession,
      updateSession: onboardSession.updateSession,
      compareAndSwapSession: onboardSession.compareAndSwapSession,
    },
    sandboxName: target.sandboxName,
    gatewayName: target.gatewayName,
    gatewayPort: target.gatewayPort,
    targetIntentFingerprint,
    requireSourceEntry: true,
    readRegistryEntry: () => registry.getSandbox(target.sandboxName),
    observe: () => observe(target),
    decorateCheckpoint: (current, checkpoint, now) => ({
      ...checkpoint,
      machineState: current.machine.state,
      updatedAt: now,
      sandboxIdentity: decisionSelected({ name: target.sandboxName, agent: agentName }),
      gatewayAuthority: decisionSelected(checkpointGatewayAuthority(authority)),
    }),
  });
  const { transaction, registryEntry: sourceEntry } = owned;
  if (owned.replacedTransactionId) {
    note(
      `  Replaced void journal ${owned.replacedTransactionId} with ${transaction.id} for '${target.sandboxName}'; its source sandbox is registered and live.`,
    );
  }
  note(
    `  Journaled replacement ${transaction.id} for '${target.sandboxName}' on ${target.gatewayName}:${String(target.gatewayPort)} at phase '${transaction.phase}'.`,
  );

  const runtime = createSandboxRecreateRuntime(
    {
      loadSession: onboardSession.loadSession,
      updateSession: onboardSession.updateSession,
      compareAndSwapSession: onboardSession.compareAndSwapSession,
    },
    {
      id: transaction.id,
      targetGeneration: transaction.targetGeneration,
      targetIntentFingerprint: transaction.targetIntentFingerprint,
    },
    target.sandboxName,
    target.gatewayName,
    sourceEntry,
    (sandboxName, gatewayName) => observe({ ...target, sandboxName, gatewayName }),
    note,
    () => registry.getSandbox(target.sandboxName),
    gatewayAuthority.revalidate,
  );

  return {
    ...runtime,
    get registrationFields() {
      return runtime.registrationFields;
    },
    abandon: () => {
      onboardSession.updateSession((current) => {
        abandonSandboxRecreateTransaction(current, transaction.id);
        return current;
      });
    },
    // This journal has no outer owner, so it retires its own transaction once
    // the replacement registry row commits.
    complete: () => {
      onboardSession.updateSession((current) => {
        for (const next of ["registry_committing", "completed"] as const) {
          const phase = current.checkpoint?.sandboxRecreate?.phase;
          if (phase && sandboxRecreatePhaseReached(phase, next)) continue;
          advanceSandboxRecreateTransaction(current, transaction.id, next);
        }
        clearCompletedSandboxRecreateTransaction(current, transaction.id);
        return current;
      });
    },
  };
}
