// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  selectedModelProvenance,
  readModelSelectionProvenance,
  type ModelSelectionProvenance,
} from "../../../domain/telemetry/provenance";
import type { Session } from "../../../state/onboard-session";
import type {
  createProviderRecoveryReceiptLedger,
  ProviderRecoveryReceipt,
} from "../../rebuild-route-handoff";
import {
  type SandboxRecoveryAuthority,
  shouldRecoverRecordedProvider,
} from "../../provider-recovery";

export type RecoveryAuthority = SandboxRecoveryAuthority;

type ProviderRecoveryReceiptLedger = ReturnType<typeof createProviderRecoveryReceiptLedger>;

interface ProviderRecoveryDeps {
  getSandboxRecoveryAuthority(
    sandboxName: string,
    sessionId: string | null | undefined,
  ): SandboxRecoveryAuthority;
}

interface ProviderRecoverySetupOptions {
  reservationSessionId?: string;
  isRecordedProviderRecoveryAuthorized?: () => boolean;
}

interface ProviderRecoveryOptions {
  /**
   * Authorization minted after locked rebuild preflight and activated against
   * this onboard session. Its presence lets the recreate path recover the
   * recorded provider while the pending sandbox step is still incomplete; the
   * mutation-lock recheck below re-binds it to the live reservation owner.
   */
  recoveryReceipt?: ProviderRecoveryReceipt | null;
  recoveryReceiptLedger?: ProviderRecoveryReceiptLedger;
  gatewayName?: string;
  now?: () => number;
}

export function createRecovery(
  fresh: boolean,
  sandboxName: string | null,
  session: Session | null,
  deps: ProviderRecoveryDeps,
  options: ProviderRecoveryOptions = {},
): {
  sessionId: string | null;
  shouldRecover(): boolean;
  setupOptions(
    recoveredRecordedProvider: boolean,
    selectedSandboxName: string,
    currentSessionId: string | undefined,
  ): ProviderRecoverySetupOptions;
} {
  const sessionId = session?.sessionId ?? null;
  const receipt = options.recoveryReceipt ?? null;
  const receiptAuthorizesIncompleteSession = Boolean(
    receipt &&
    receipt.sessionId &&
    receipt.sessionId === sessionId &&
    receipt.sandboxName === sandboxName,
  );
  const now = options.now ?? (() => Date.now());
  return {
    sessionId,
    shouldRecover: () =>
      shouldRecoverRecordedProvider({
        fresh,
        sandboxName,
        sandboxRecoveryAuthority: sandboxName
          ? deps.getSandboxRecoveryAuthority(sandboxName, sessionId)
          : "missing",
        sessionSandboxName:
          session?.steps?.sandbox?.status === "complete" || receiptAuthorizesIncompleteSession
            ? (session?.sandboxName ?? null)
            : null,
      }),
    setupOptions(recoveredRecordedProvider, selectedSandboxName, currentSessionId) {
      if (!recoveredRecordedProvider) return { reservationSessionId: currentSessionId };
      return {
        reservationSessionId: sessionId ?? undefined,
        isRecordedProviderRecoveryAuthorized: () => {
          const reservationOwned =
            deps.getSandboxRecoveryAuthority(selectedSandboxName, sessionId) !== "unauthorized";
          if (!receipt || !options.recoveryReceiptLedger || !options.gatewayName) {
            return reservationOwned;
          }
          return options.recoveryReceiptLedger.validateInLock(receipt, {
            sandboxName: selectedSandboxName,
            gatewayName: options.gatewayName,
            sessionId,
            nowMs: now(),
            reservationOwned,
          });
        },
      };
    },
  };
}

/** Carry selection origin only while the current route matches the selected model and provider. */
export function providerModelProvenanceUpdate(
  provenance: ModelSelectionProvenance | null,
  route: Parameters<typeof selectedModelProvenance>[0],
): { modelSelectionProvenance?: ModelSelectionProvenance } {
  if (!provenance || provenance.model !== route.model || provenance.provider !== route.provider)
    return {};
  const bound = selectedModelProvenance({ ...route, modelSource: provenance.modelSource });
  return bound ? { modelSelectionProvenance: bound } : {};
}

export { readModelSelectionProvenance };

/** A recovered selection may retain its receipt only while the exact model/provider still matches. */
export function selectedOrRecoveredModelProvenance(
  selection: {
    model: string | null;
    provider: string;
    modelSelectionProvenance?: ModelSelectionProvenance;
    recoveredFromSandbox?: boolean;
  },
  previous: ModelSelectionProvenance | null,
): ModelSelectionProvenance | null {
  return (
    readModelSelectionProvenance(selection.modelSelectionProvenance) ??
    (selection.recoveredFromSandbox &&
    previous?.model === selection.model &&
    previous.provider === selection.provider
      ? previous
      : null)
  );
}
