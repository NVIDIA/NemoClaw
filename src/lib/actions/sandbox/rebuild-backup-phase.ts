// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  isPolicyObservationError,
  PolicyObservationError,
} from "../../adapters/openshell/policy-state";
import type { OpenShellRuntimeSelection } from "../../adapters/openshell/runtime-selection";
import { formatOpenShellPolicyRecoveryAction } from "../../gateway-start-guidance";
import type { WebSearchConfig } from "../../inference/web-search";
import type { SandboxMessagingPlan } from "../../messaging";
import { resolveDockerSnapshotRecreateGpuDevice } from "../../onboard/runtime-provider/snapshot";
import { secureTempFile } from "../../onboard/temp-files";
import { readRebuildPolicyHandoff, writeRebuildPolicyHandoff } from "../../state/sandbox";
import { captureRecordedSandboxBasePolicy } from "../../policy";
import { isSandboxPolicyCredentialFree } from "../../policy/sandbox-policy-validation";
import type { RebuildBail, RebuildLog } from "./rebuild-credential-preflight";
import { backupSandboxStateForRebuild, type RebuildSandboxEntry } from "./rebuild-flow-helpers";
import type { RebuildRecreateOnboardOpts } from "./rebuild-gpu-opt-out";
import { recordRebuildRecoveryBackup } from "./rebuild-recreate-journal";
import {
  abortOpenClawPostRestoreDoctor,
  beginOpenClawBackupQuiesce,
  finishOpenClawPostRestoreDoctor,
  retireOpenClawPostRestoreDoctorForDelete,
  type OpenClawPostRestoreDoctorWindow,
} from "./runtime/openclaw-lifecycle";

export {
  clearRebuildMcpHandoff,
  clearRebuildPolicyHandoff,
  readRebuildPolicyHandoff,
  readRebuildMcpHandoff,
  writeRebuildMcpHandoff,
  clearHermesOperatorConfigHandoff,
  writeHermesOperatorConfigHandoff,
  writeRebuildPolicyHandoff,
} from "../../state/sandbox";

export type RebuildBackupManifest = Exclude<
  Awaited<ReturnType<typeof backupSandboxStateForRebuild>>,
  undefined
>;

/** Bind replacement creation to the provider-observed GPU selected by the source runtime. */
export function bindRebuildSnapshotGpuAuthority(
  options: RebuildRecreateOnboardOpts,
  manifest: RebuildBackupManifest,
): RebuildRecreateOnboardOpts {
  const sandboxGpuDevice = manifest?.runtimeSnapshot
    ? resolveDockerSnapshotRecreateGpuDevice(manifest.runtimeSnapshot)
    : null;
  if (!sandboxGpuDevice) return options;
  if (options.noGpu === true || options.sandboxGpu === "disable") {
    throw new Error("Captured GPU runtime authority conflicts with the recorded GPU opt-out.");
  }
  return { ...options, sandboxGpu: "enable", sandboxGpuDevice };
}

export interface RebuildBackupPhaseInput {
  sandboxName: string;
  gatewayName: string;
  gatewayPort: number;
  sandboxEntry: RebuildSandboxEntry;
  staleRecovery: boolean;
  preparedRecoveryManifest: RebuildBackupManifest;
  recoveryTransactionId?: string;
  messagingPlan: SandboxMessagingPlan | null;
  webSearchConfig: WebSearchConfig | null;
  log: RebuildLog;
  bail: RebuildBail;
  runtimeSelection?: OpenShellRuntimeSelection;
  capturedOpenClawState?: import("../../state/state-directory-restore").CapturedOpenClawState;
}

export interface RebuildBackupPhaseResult {
  backupManifest: RebuildBackupManifest;
  policySourcePath: string;
  sourceOpenClawDoctorWindow?: OpenClawPostRestoreDoctorWindow;
}

export async function releaseRebuildSourceOpenClawWindow(window: OpenClawPostRestoreDoctorWindow) {
  const finished = await finishOpenClawPostRestoreDoctor(window);
  if (!finished.ok) await abortOpenClawPostRestoreDoctor(window);
  return finished;
}

export function retireRebuildSourceOpenClawWindowForDelete(
  window: OpenClawPostRestoreDoctorWindow,
) {
  return retireOpenClawPostRestoreDoctorForDelete(window);
}

export async function captureRebuildPolicyDocument(
  sandboxName: string,
  gatewayName: string,
  runtimeSelection?: OpenShellRuntimeSelection,
): Promise<string> {
  let policy: string;
  try {
    policy = await captureRecordedSandboxBasePolicy(
      sandboxName,
      "capture the live policy before sandbox replacement",
      runtimeSelection,
    );
  } catch (error) {
    if (!isPolicyObservationError(error)) throw error;
    const retryCommand = `nemoclaw ${sandboxName} rebuild`;
    const recovery = error.policyReadError
      ? formatOpenShellPolicyRecoveryAction(error.policyReadError, retryCommand, gatewayName)
      : `Inspect \`openshell status\`, correct the policy-read failure, then retry \`${retryCommand}\`.`;
    throw new PolicyObservationError(
      [
        `Cannot read the current OpenShell policy before rebuilding sandbox '${sandboxName}' through recorded gateway '${gatewayName}'.`,
        error.message,
        recovery,
      ].join(" "),
      {
        cause: error,
        ...(error.policyReadError === undefined ? {} : { policyReadError: error.policyReadError }),
      },
    );
  }
  if (!isSandboxPolicyCredentialFree(policy)) {
    throw new Error(
      `Cannot prepare a rebuild policy handoff for sandbox '${sandboxName}' because its live OpenShell policy contains a literal credential value. Replace literal credentials with supported OpenShell credential bindings or resolver placeholders, then retry the rebuild.`,
    );
  }
  return policy;
}

function writeRebuildPolicySource(policy: string, policySourcePath?: string): string {
  const resolvedPolicySourcePath =
    policySourcePath ?? secureTempFile("nemoclaw-rebuild-policy", ".yaml");
  fs.writeFileSync(resolvedPolicySourcePath, policy, { mode: 0o600 });
  return resolvedPolicySourcePath;
}

export async function runRebuildBackupPhase(
  input: RebuildBackupPhaseInput,
  backupStateForRebuild: typeof backupSandboxStateForRebuild = backupSandboxStateForRebuild,
): Promise<RebuildBackupPhaseResult | null> {
  const preparedRecoveryManifest = input.preparedRecoveryManifest;
  const preparedRetainedPolicy = preparedRecoveryManifest
    ? readRebuildPolicyHandoff(preparedRecoveryManifest)
    : null;
  const capturedPolicy =
    input.staleRecovery || preparedRetainedPolicy
      ? null
      : await captureRebuildPolicyDocument(
          input.sandboxName,
          input.gatewayName,
          input.runtimeSelection,
        );
  let sourceBackupWindow: OpenClawPostRestoreDoctorWindow | null = null;
  input.capturedOpenClawState?.assertCurrent();
  if (
    !preparedRecoveryManifest &&
    !input.capturedOpenClawState &&
    !input.staleRecovery &&
    (input.sandboxEntry.agent ?? "openclaw") === "openclaw"
  ) {
    input.log("Entering verified OpenClaw gateway-quiesce window before state backup");
    const begun = await beginOpenClawBackupQuiesce(input.sandboxName, input.runtimeSelection);
    if (!begun.ok) {
      return input.bail(
        `OpenClaw state backup could not enter its gateway-down maintenance window (${begun.stage}: ${begun.detail}).`,
      );
    }
    sourceBackupWindow = begun.window;
  }
  let transferSourceWindow = false;
  try {
    let backupManifest: RebuildBackupManifest | undefined =
      preparedRecoveryManifest ??
      (await backupStateForRebuild(
        input.sandboxName,
        input.sandboxEntry,
        input.staleRecovery,
        input.log,
        input.bail,
        ...(input.capturedOpenClawState ? ([input.capturedOpenClawState] as const) : ([] as const)),
      ));
    if (backupManifest === undefined) return null;
    const retainedPolicy = backupManifest ? readRebuildPolicyHandoff(backupManifest) : null;
    if (input.staleRecovery && !retainedPolicy) {
      return input.bail(
        "The live OpenShell policy and its verified rebuild handoff are unavailable. Rebuild will not reconstruct policy from NemoClaw state.",
      );
    }
    const retainedHandoff = backupManifest?.rebuildPolicyHandoff;
    if (
      retainedPolicy &&
      backupManifest &&
      retainedHandoff &&
      !isSandboxPolicyCredentialFree(retainedPolicy)
    ) {
      const retainedHandoffPath = path.join(backupManifest.backupPath, retainedHandoff.file);
      const recoveryTransactionId = input.recoveryTransactionId ?? randomUUID();
      try {
        recordRebuildRecoveryBackup({
          sandboxName: input.sandboxName,
          agentName: backupManifest.agentType,
          transactionId: recoveryTransactionId,
          gatewayName: input.gatewayName,
          gatewayPort: input.gatewayPort,
          backupManifest,
        });
      } catch (error) {
        return input.bail(
          `Cannot bind the retained credential-bearing policy handoff to a bounded recovery transaction: ${error instanceof Error ? error.message : String(error)} Recovery remains at '${backupManifest.backupPath}'.`,
        );
      }
      return input.bail(
        `The retained rebuild policy handoff for sandbox '${input.sandboxName}' contains a literal credential value and cannot restore the deleted sandbox. Recovery:\n` +
          `  1. Recover any required data from the backup before deletion. Keep the backup and policy handoff until that recovery is complete.\n` +
          `  2. Restore access to recorded gateway '${input.gatewayName}', select it with \`openshell gateway select ${input.gatewayName}\`, and confirm \`openshell status\` is healthy.\n` +
          `  3. Only then run \`nemoclaw ${input.sandboxName} destroy --yes\` and confirm OpenShell reports the sandbox deleted. Do not use \`--force\` for this recovery. If deletion is unconfirmed, preserve the recovery state and restore gateway access before retrying cleanup.\n` +
          "  4. Create a fresh sandbox under a new name by replacing `<new-sandbox>` in `nemoclaw onboard --name <new-sandbox>`. Do not retry rebuild with the unsafe handoff.\n" +
          `  5. After required data is recovered and old-sandbox deletion is confirmed, retire only this failed transaction with \`nemoclaw ${input.sandboxName} rebuild --retire-recovery ${recoveryTransactionId} --yes\`. This removes the credential-bearing policy handoff at '${retainedHandoffPath}' while retaining the remaining backup.`,
      );
    }
    if (retainedPolicy && backupManifest && retainedHandoff) {
      transferSourceWindow = true;
      return {
        backupManifest,
        policySourcePath: fs.realpathSync(
          path.join(backupManifest.backupPath, retainedHandoff.file),
        ),
        ...(sourceBackupWindow ? { sourceOpenClawDoctorWindow: sourceBackupWindow } : {}),
      };
    }
    const policy =
      capturedPolicy ??
      (await captureRebuildPolicyDocument(
        input.sandboxName,
        input.gatewayName,
        input.runtimeSelection,
      ));
    if (backupManifest && !retainedPolicy) {
      try {
        backupManifest = writeRebuildPolicyHandoff(backupManifest, policy);
        const handoff = backupManifest.rebuildPolicyHandoff;
        if (!handoff) throw new Error("rebuild policy handoff was not published");
        transferSourceWindow = true;
        return {
          backupManifest,
          policySourcePath: fs.realpathSync(path.join(backupManifest.backupPath, handoff.file)),
          ...(sourceBackupWindow ? { sourceOpenClawDoctorWindow: sourceBackupWindow } : {}),
        };
      } catch (error) {
        return input.bail(
          `The current OpenShell policy could not be retained for rebuild recovery: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    transferSourceWindow = true;
    return {
      backupManifest,
      policySourcePath: writeRebuildPolicySource(policy),
      ...(sourceBackupWindow ? { sourceOpenClawDoctorWindow: sourceBackupWindow } : {}),
    };
  } finally {
    if (sourceBackupWindow && !transferSourceWindow) {
      await releaseRebuildSourceOpenClawWindow(sourceBackupWindow);
    }
  }
}
