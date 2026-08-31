// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import type { WebSearchConfig } from "../../inference/web-search";
import type { SandboxMessagingPlan } from "../../messaging";
import { cleanupTempDir, secureTempFile } from "../../onboard/temp-files";
import { hasCompleteOpenClawImagePluginProvenance } from "../../state/openclaw-plugin-restore";
import {
  hasAuthoritativeOpenClawImagePluginProvenance,
  readRebuildPolicyHandoff,
  writeRebuildPolicyHandoff,
} from "../../state/sandbox";
import type { RebuildBail, RebuildLog } from "./rebuild-credential-preflight";
import { backupSandboxStateForRebuild, type RebuildSandboxEntry } from "./rebuild-flow-helpers";
import * as policyGet from "./policy-get";

export { clearRebuildPolicyHandoff, writeRebuildPolicyHandoff } from "../../state/sandbox";

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
  log: RebuildLog;
  bail: RebuildBail;
  relockShieldsIfNeeded: (sandboxStillExists: boolean) => boolean;
}

export interface RebuildBackupPhaseResult {
  backupManifest: RebuildBackupManifest;
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

export function captureRebuildPolicySource(
  sandboxName: string,
  policySourcePath?: string,
): string | null {
  const policy = policyGet.getSandboxPolicy(sandboxName, {
    recordedGatewayOperation: "capture the live policy before sandbox replacement",
  }).yaml;
  if (!policy) return null;
  const resolvedPolicySourcePath =
    policySourcePath ?? secureTempFile("nemoclaw-rebuild-policy", ".yaml");
  fs.writeFileSync(resolvedPolicySourcePath, policy, { mode: 0o600 });
  return resolvedPolicySourcePath;
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
  let backupManifest =
    preparedRecoveryManifest ??
    backupStateForRebuild(
      input.sandboxName,
      input.sandboxEntry,
      input.staleRecovery,
      input.log,
      input.relockShieldsIfNeeded,
      input.bail,
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
  const retainedPolicy = backupManifest ? readRebuildPolicyHandoff(backupManifest) : null;
  if (input.staleRecovery && !retainedPolicy) {
    return input.bail(
      "The live OpenShell policy and its verified rebuild handoff are unavailable. Rebuild will not reconstruct policy from NemoClaw state.",
    );
  }
  const retainedHandoff = backupManifest?.rebuildPolicyHandoff;
  const policySourcePath =
    retainedPolicy && backupManifest && retainedHandoff
      ? fs.realpathSync(path.join(backupManifest.backupPath, retainedHandoff.file))
      : captureRebuildPolicySource(input.sandboxName);
  if (!policySourcePath) {
    return input.bail(
      "The current OpenShell policy could not be captured before sandbox replacement.",
    );
  }
  if (backupManifest && !retainedPolicy) {
    try {
      backupManifest = writeRebuildPolicyHandoff(
        backupManifest,
        fs.readFileSync(policySourcePath, "utf8"),
      );
      const handoff = backupManifest.rebuildPolicyHandoff;
      if (!handoff) throw new Error("rebuild policy handoff was not published");
      return {
        backupManifest,
        policySourcePath: fs.realpathSync(path.join(backupManifest.backupPath, handoff.file)),
      };
    } catch (error) {
      return input.bail(
        `The current OpenShell policy could not be retained for rebuild recovery: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      cleanupTempDir(policySourcePath, "nemoclaw-rebuild-policy");
    }
  }
  return { backupManifest, policySourcePath };
}
