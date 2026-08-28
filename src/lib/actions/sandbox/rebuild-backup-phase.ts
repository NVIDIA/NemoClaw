// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import type { WebSearchConfig } from "../../inference/web-search";
import type { SandboxMessagingPlan } from "../../messaging";
import { secureTempFile } from "../../onboard/temp-files";
import { hasCompleteOpenClawImagePluginProvenance } from "../../state/openclaw-plugin-restore";
import { hasAuthoritativeOpenClawImagePluginProvenance } from "../../state/sandbox";
import type { RebuildBail, RebuildLog } from "./rebuild-credential-preflight";
import { backupSandboxStateForRebuild, type RebuildSandboxEntry } from "./rebuild-flow-helpers";
import * as policyGet from "./policy-get";

export type RebuildBackupManifest = Exclude<
  ReturnType<typeof backupSandboxStateForRebuild>,
  undefined
>;

export interface RebuildBackupPhaseInput {
  sandboxName: string;
  sandboxEntry: RebuildSandboxEntry;
  staleRecovery: boolean;
  preparedRecoveryManifest: RebuildBackupManifest;
  messagingPlan: SandboxMessagingPlan | null;
  webSearchConfig: WebSearchConfig | null;
  force?: boolean;
  log: RebuildLog;
  bail: RebuildBail;
  relockShieldsIfNeeded: (sandboxStillExists: boolean) => boolean;
}

export interface RebuildBackupPhaseResult {
  backupManifest: RebuildBackupManifest;
  backupWasForceSkipped: boolean;
  policySourcePath: string;
}

function bailForUnsafeOpenClawPluginProvenance(input: RebuildBackupPhaseInput): never {
  console.error(
    "  Custom-image OpenClaw plugin provenance is missing or invalid; rebuild cannot safely distinguish image-owned plugins from user state.",
  );
  console.error("  The sandbox is untouched — no data was lost.");
  console.error(
    "  To preserve state, onboard the custom image under a new sandbox name and manually migrate only user-owned state.",
  );
  input.relockShieldsIfNeeded(!input.staleRecovery);
  return input.bail("Custom-image OpenClaw plugin provenance is unavailable.");
}

export function runRebuildBackupPhase(
  input: RebuildBackupPhaseInput,
  backupStateForRebuild: typeof backupSandboxStateForRebuild = backupSandboxStateForRebuild,
): RebuildBackupPhaseResult | null {
  const customOpenClaw =
    Boolean(input.sandboxEntry.fromDockerfile) &&
    (!input.sandboxEntry.agent || input.sandboxEntry.agent === "openclaw");
  const preparedRecoveryManifest = input.preparedRecoveryManifest;
  const hasPreparedRecovery = preparedRecoveryManifest !== null;
  const preparedRecoveryIsAuthoritative =
    preparedRecoveryManifest !== null &&
    hasAuthoritativeOpenClawImagePluginProvenance(preparedRecoveryManifest);
  const restoresCustomOpenClawState =
    customOpenClaw && (!input.staleRecovery || hasPreparedRecovery);
  if (
    (hasPreparedRecovery &&
      preparedRecoveryManifest?.reconcileOpenClawImagePluginProvenance === true &&
      !preparedRecoveryIsAuthoritative) ||
    (restoresCustomOpenClawState &&
      !preparedRecoveryIsAuthoritative &&
      (hasPreparedRecovery ||
        !hasCompleteOpenClawImagePluginProvenance(
          input.sandboxEntry.openclawImagePluginInstalls,
          "/sandbox/.openclaw",
        )))
  ) {
    return bailForUnsafeOpenClawPluginProvenance(input);
  }
  const backupManifest =
    preparedRecoveryManifest ??
    backupStateForRebuild(
      input.sandboxName,
      input.sandboxEntry,
      input.staleRecovery,
      input.log,
      input.relockShieldsIfNeeded,
      input.bail,
      { force: input.force },
    );
  if (backupManifest === undefined) return null;
  if (
    backupManifest &&
    (backupManifest.reconcileOpenClawImagePluginProvenance === true ||
      restoresCustomOpenClawState) &&
    !hasAuthoritativeOpenClawImagePluginProvenance(backupManifest)
  ) {
    return bailForUnsafeOpenClawPluginProvenance(input);
  }
  const backupWasForceSkipped =
    input.force === true && !input.staleRecovery && backupManifest === null;

  if (input.staleRecovery) {
    return input.bail(
      "The live OpenShell policy is unavailable. Rebuild will not reconstruct policy from NemoClaw state.",
    );
  }
  const policy = policyGet.getSandboxPolicy(input.sandboxName).yaml;
  if (!policy) {
    return input.bail(
      "The current OpenShell policy could not be captured before sandbox replacement.",
    );
  }
  const policySourcePath = secureTempFile("nemoclaw-rebuild-policy", ".yaml");
  fs.writeFileSync(policySourcePath, policy, { mode: 0o600 });
  return { backupManifest, backupWasForceSkipped, policySourcePath };
}
