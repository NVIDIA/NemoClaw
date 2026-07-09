// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Session } from "../../state/onboard-session";
import type { RebuildTransactionRecordV1 } from "../../state/rebuild-transaction";
import type { SandboxEntry } from "../../state/registry";
import type { RebuildBail, RebuildLog } from "./rebuild-credential-preflight";
import type { RebuildLiveState } from "./rebuild-flow-helpers";
import { printRebuildPreflightFailure } from "./rebuild-preflight-error";
import { type RebuildRecoveryPlan, reconcileRebuildRecovery } from "./rebuild-recovery-plan";

export interface RebuildRecoveryPreflightResult {
  liveState: RebuildLiveState;
  plan: RebuildRecoveryPlan | null;
  replacementAlreadyPresent: boolean;
}

/** Collect and apply recovery evidence before target preparation or mutation. */
export async function prepareRebuildRecoveryPreflight(input: {
  transaction: RebuildTransactionRecordV1 | null;
  resolveLiveState: () => Promise<RebuildLiveState | null>;
  readRegistryEntry: () => SandboxEntry | null;
  readSession: () => Session | null;
  restoreRegistry: Parameters<typeof reconcileRebuildRecovery>[0]["restoreRegistry"];
  log: RebuildLog;
  bail: RebuildBail;
}): Promise<RebuildRecoveryPreflightResult | null> {
  const liveState = await input.resolveLiveState();
  if (!liveState) return null;
  const reconciliation = reconcileRebuildRecovery({
    transaction: input.transaction,
    live: liveState.observation,
    readRegistryEntry: input.readRegistryEntry,
    readSession: input.readSession,
    restoreRegistry: input.restoreRegistry,
  });
  if (!reconciliation.ok) {
    input.log("Durable rebuild recovery decision: refuse");
    printRebuildPreflightFailure(
      `the observed replacement cannot be proven to belong to rebuild transaction '${reconciliation.transactionId}' (${reconciliation.code}).`,
      "Inspect the live sandbox, registry row, onboarding session, and validated backup; no recovery side effect was attempted.",
      "Rebuild replacement recovery failed",
      input.bail,
    );
    return null;
  }
  const plan = reconciliation.plan;
  if (plan) input.log(`Durable rebuild recovery decision: ${plan.action}`);
  if (plan?.registryRestored) {
    input.log("Restored missing registry recovery metadata from the rebuild journal");
  }
  return {
    liveState,
    plan,
    replacementAlreadyPresent: plan?.replacementAlreadyPresent === true,
  };
}
