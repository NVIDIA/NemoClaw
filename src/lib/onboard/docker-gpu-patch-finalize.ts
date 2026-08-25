// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Source-of-truth: this module is a NemoClaw-side workaround. The invalid
// state it recovers from is "OpenShell Docker-driver GPU patch left the
// sandbox in a deleted-backup / failed-new state when the post-recreate
// supervisor reconnect could not confirm the GPU container". The preferred
// source boundary for the fix is OpenShell: a Docker-driver sandbox create
// that natively accepts NVIDIA GPU access would remove the need for the
// post-create container recreation NemoClaw performs here. Until OpenShell
// supports that natively, NemoClaw recreates the container with GPU access
// and uses this module to either restore the pre-patch backup before commit or
// complete the exact stop/remove/start handoff and require OpenShell's final
// Ready acknowledgement. Before removing the old container, NemoClaw commits
// its writable layer to a temporary image and records the exact run arguments
// needed to restore it. Regression coverage:
//   * src/lib/onboard/docker-gpu-patch-finalize.test.ts — direct unit tests
//     for exact final handoff, terminal phase, rollback, and failure outcomes.
//   * src/lib/onboard/docker-gpu-patch-rollback.test.ts — composed
//     recreate-with-rollback scenarios.
//   * src/lib/onboard/docker-gpu-sandbox-create-lifecycle.test.ts — composed create
//     flow driving maybeApplyDuringCreate → waitForSupervisorReconnect →
//     finalizeBackup.
// Removal condition: when OpenShell supports native Docker-driver GPU
// creation/reconnect, drop the NemoClaw post-create container recreation
// and delete this module along with its callers in docker-gpu-patch.ts and
// docker-gpu-sandbox-create.ts.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { shouldStripCredentialEnv } from "../security/credential-env";
import { rejectSymlinksOnPath } from "../state/config-io";
import { hasZeroDockerExitStatus } from "./docker-command-result";
import { DOCKER_GPU_PATCH_TIMEOUT_MS } from "./docker-gpu-patch-constants";
import {
  type ResolvedDockerGpuPatchRollbackDeps,
  removeReplacementContainer,
  resolveDockerGpuPatchRollbackDeps,
  rollbackToBackupContainer,
} from "./docker-gpu-patch-rollback";
import {
  buildDockerGpuCloneRunArgs,
  buildDockerGpuCloneRunOptions,
  fullDockerContainerId,
  parseDockerInspectJson,
} from "./docker-gpu-patch-clone";
import { buildDockerGpuMode } from "./docker-gpu-patch-mode";
import type {
  DockerContainerInspect,
  DockerGpuPatchDeps,
  DockerGpuPatchResult,
} from "./docker-gpu-patch-types";
import {
  waitForOpenShellFinalHandoff,
  waitForOpenShellSandboxLifecycleRelease,
} from "./docker-gpu-supervisor-reconnect";
import {
  OPENSHELL_MANAGED_BY_LABEL,
  OPENSHELL_SANDBOX_ID_LABEL,
  OPENSHELL_SANDBOX_NAME_LABEL,
  queryOpenShellDockerSandboxContainers,
} from "./openshell-docker-sandbox-containers";

export type DockerGpuPatchFinalizeOptions =
  | {
      result: DockerGpuPatchResult;
      supervisorReady: false;
    }
  | {
      result: DockerGpuPatchResult;
      supervisorReady: true;
      sandboxName: string;
      finalHandoffTimeoutSecs: number;
    };

export type DockerGpuPatchFinalizeOutcome = {
  /** True once Docker has removed the old container. */
  backupRemoved: boolean;
  rolledBack: boolean;
  rollbackImageId?: string;
  rollbackImageRemoved?: boolean;
  rollbackRecordPath?: string;
  rollbackRecordRemoved?: boolean;
  replacementStoppedForCommit?: boolean;
  replacementRestarted?: boolean;
  lifecycleReleaseObserved?: boolean;
  finalHandoffAcknowledged?: boolean;
  lastSandboxPhase?: string | null;
  replacementStopConfirmed?: boolean;
  replacementRemovalConfirmed?: boolean;
  replacementPresence?: "absent" | "present" | "unknown";
};

type PostCommitRollbackPlan = {
  imageId: string;
  oldContainerId: string;
  recordPath: string;
  runArgs: string[];
};

const DOCKER_IMAGE_ID = /^sha256:[0-9a-f]{64}$/iu;
const ROLLBACK_RECORD_VERSION = 1;
const RECOVERY_ENV_KEYS = new Set([
  "OPENSHELL_ENDPOINT",
  "OPENSHELL_SANDBOX_COMMAND",
  "OPENSHELL_OCI_IMAGE_USER",
  "OPENSHELL_SANDBOX_UID",
  "OPENSHELL_SANDBOX_GID",
]);
const RECOVERY_LABEL_KEYS = new Set([
  OPENSHELL_MANAGED_BY_LABEL,
  OPENSHELL_SANDBOX_NAME_LABEL,
  OPENSHELL_SANDBOX_ID_LABEL,
]);
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const OCI_IDENTITY = /^[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)?$/u;
const NUMERIC_IDENTITY = /^(?:0|[1-9][0-9]*)$/u;
const NEMOCLAW_STARTUP_EXECUTABLES = new Set(["nemoclaw-start", "/usr/local/bin/nemoclaw-start"]);

function removeRollbackImage(
  imageId: string,
  deps: ResolvedDockerGpuPatchRollbackDeps,
  options: Record<string, unknown>,
): boolean {
  return hasZeroDockerExitStatus(deps.dockerRun(["image", "rm", "--force", imageId], options));
}

function envAssignment(value: string): { key: string; value: string } | null {
  const separator = value.indexOf("=");
  if (separator <= 0) return null;
  const key = value.slice(0, separator);
  return ENV_KEY.test(key) ? { key, value: value.slice(separator + 1) } : null;
}

function isCredentialFreeHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      ["http:", "https:"].includes(parsed.protocol) &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.search === "" &&
      parsed.hash === ""
    );
  } catch {
    return false;
  }
}

function recoverySandboxCommand(value: string): string | null {
  const tokens = value.trim().split(/\s+/u).filter(Boolean);
  if (tokens.length === 2 && tokens[0] === "sleep" && tokens[1] === "infinity") return value;
  if (tokens.length === 1 && NEMOCLAW_STARTUP_EXECUTABLES.has(tokens[0])) return value;
  if (tokens[0] !== "env") return null;

  const assignments: Array<{ key: string; value: string }> = [];
  let executableIndex = 1;
  while (executableIndex < tokens.length) {
    const assignment = envAssignment(tokens[executableIndex]);
    if (!assignment) break;
    assignments.push(assignment);
    executableIndex += 1;
  }
  if (
    executableIndex !== tokens.length - 1 ||
    !NEMOCLAW_STARTUP_EXECUTABLES.has(tokens[executableIndex])
  ) {
    return null;
  }
  const extraPlaceholderKeys = new Set(
    (assignments.find(({ key }) => key === "NEMOCLAW_EXTRA_PLACEHOLDER_KEYS")?.value ?? "")
      .split(/[\s,]+/u)
      .filter((key) => ENV_KEY.test(key)),
  );
  const retained = assignments
    .filter(
      ({ key, value: assignmentValue }) =>
        !shouldStripCredentialEnv(key) &&
        !extraPlaceholderKeys.has(key) &&
        (!assignmentValue.includes("://") || isCredentialFreeHttpUrl(assignmentValue)),
    )
    .map(({ key, value: assignmentValue }) => `${key}=${assignmentValue}`);
  return ["env", ...retained, tokens[executableIndex]].join(" ");
}

function recoveryRunValue(flag: string, value: string): string | null {
  if (flag === "--label") {
    const separator = value.indexOf("=");
    const key = separator > 0 ? value.slice(0, separator) : "";
    return RECOVERY_LABEL_KEYS.has(key) ? value : null;
  }
  const assignment = envAssignment(value);
  if (!assignment) return null;
  if (flag !== "--env" || !RECOVERY_ENV_KEYS.has(assignment.key)) return null;
  if (assignment.key === "OPENSHELL_SANDBOX_COMMAND") {
    const command = recoverySandboxCommand(assignment.value);
    return command === null ? null : `${assignment.key}=${command}`;
  }
  if (assignment.key === "OPENSHELL_ENDPOINT")
    return isCredentialFreeHttpUrl(assignment.value) ? value : null;
  if (assignment.key === "OPENSHELL_OCI_IMAGE_USER")
    return OCI_IDENTITY.test(assignment.value) ? value : null;
  if (assignment.key === "OPENSHELL_SANDBOX_UID" || assignment.key === "OPENSHELL_SANDBOX_GID")
    return assignment.value === "" || NUMERIC_IDENTITY.test(assignment.value) ? value : null;
  return value;
}

function recoveryRunArgs(runArgs: readonly string[], imageId: string): string[] {
  const imageIndex = runArgs.indexOf(imageId);
  if (imageIndex < 0)
    throw new Error("Docker rollback arguments do not include the rollback image.");
  const persisted: string[] = [];
  for (let index = 0; index < imageIndex; index += 1) {
    const value = runArgs[index];
    if (value === "--env" || value === "--label") {
      if (index + 1 >= imageIndex) {
        throw new Error(`Docker rollback argument '${value}' has no value.`);
      }
      const persistedValue = recoveryRunValue(value, runArgs[index + 1]);
      index += 1;
      if (persistedValue !== null) persisted.push(value, persistedValue);
      continue;
    }
    persisted.push(value);
  }
  return [...persisted, imageId];
}

function writeRollbackRecord(
  sandboxName: string,
  oldContainerId: string,
  imageId: string,
  runArgs: readonly string[],
  deps: DockerGpuPatchDeps,
): string | null {
  const directory = path.join(
    (deps.homedir ?? os.homedir)(),
    ".nemoclaw",
    "recovery",
    "docker-gpu",
  );
  const recordPath = path.join(
    directory,
    `${encodeURIComponent(sandboxName)}-${oldContainerId.slice(0, 12)}.json`,
  );
  try {
    rejectSymlinksOnPath(directory);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    rejectSymlinksOnPath(directory);
    fs.chmodSync(directory, 0o700);
    fs.writeFileSync(
      recordPath,
      `${JSON.stringify(
        {
          version: ROLLBACK_RECORD_VERSION,
          sandboxName,
          rollbackImageId: imageId,
          recoveryAction: {
            command: "docker",
            args: ["run", "--detach", ...recoveryRunArgs(runArgs, imageId)],
          },
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    fs.chmodSync(recordPath, 0o600);
    return recordPath;
  } catch {
    return null;
  }
}

function removeRollbackRecord(recordPath: string): boolean {
  try {
    fs.rmSync(recordPath, { force: true });
    return !fs.existsSync(recordPath);
  } catch {
    return false;
  }
}

function preparePostCommitRollback(
  result: DockerGpuPatchResult,
  sandboxName: string,
  deps: DockerGpuPatchDeps,
  resolved: ResolvedDockerGpuPatchRollbackDeps,
  options: Record<string, unknown>,
): PostCommitRollbackPlan | null {
  const oldContainerId = fullDockerContainerId(result.oldContainerId);
  if (!oldContainerId) return null;
  let inspect: DockerContainerInspect;
  try {
    inspect = parseDockerInspectJson(
      resolved.dockerCapture(["inspect", "--type", "container", oldContainerId], {
        ignoreError: true,
        timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
      }),
    );
  } catch {
    return null;
  }

  const committed = resolved.dockerRun(["commit", oldContainerId], options);
  if (!hasZeroDockerExitStatus(committed)) return null;
  const imageId = String(committed.stdout ?? "").trim();
  if (!DOCKER_IMAGE_ID.test(imageId)) return null;

  try {
    const cloneOptions = buildDockerGpuCloneRunOptions(inspect);
    cloneOptions.containerName = result.originalName;
    cloneOptions.image = imageId;
    const runArgs = buildDockerGpuCloneRunArgs(
      inspect,
      buildDockerGpuMode("startup-command"),
      cloneOptions,
    );
    const recordPath = writeRollbackRecord(sandboxName, oldContainerId, imageId, runArgs, deps);
    if (!recordPath) {
      if (!removeRollbackImage(imageId, resolved, options)) {
        console.warn(`  Could not remove temporary Docker rollback image ${imageId}.`);
      }
      return null;
    }
    return {
      imageId,
      oldContainerId,
      recordPath,
      runArgs,
    };
  } catch {
    if (!removeRollbackImage(imageId, resolved, options)) {
      console.warn(`  Could not remove temporary Docker rollback image ${imageId}.`);
    }
    return null;
  }
}

function restorePostCommitRollback(
  plan: PostCommitRollbackPlan,
  result: DockerGpuPatchResult,
  resolved: ResolvedDockerGpuPatchRollbackDeps,
  options: Record<string, unknown>,
): Pick<
  DockerGpuPatchFinalizeOutcome,
  | "rolledBack"
  | "rollbackImageId"
  | "rollbackImageRemoved"
  | "rollbackRecordPath"
  | "rollbackRecordRemoved"
  | "replacementStopConfirmed"
  | "replacementRemovalConfirmed"
  | "replacementPresence"
> {
  const replacementContainerId = fullDockerContainerId(result.newContainerId);
  if (!replacementContainerId) {
    return {
      rolledBack: false,
      rollbackImageId: plan.imageId,
      rollbackImageRemoved: false,
      rollbackRecordPath: plan.recordPath,
      rollbackRecordRemoved: false,
      replacementStopConfirmed: false,
      replacementRemovalConfirmed: false,
      replacementPresence: "unknown",
    };
  }
  const removal = removeReplacementContainer(replacementContainerId, resolved);
  const restored =
    removal.replacementPresence === "absent"
      ? resolved.dockerRunDetached(plan.runArgs, options)
      : null;
  const restoredContainerId =
    restored !== null && hasZeroDockerExitStatus(restored)
      ? fullDockerContainerId(String(restored.stdout ?? ""))
      : null;
  const rollbackRecordRemoved =
    restoredContainerId !== null && removeRollbackRecord(plan.recordPath);
  return {
    rolledBack: restoredContainerId !== null,
    rollbackImageId: plan.imageId,
    rollbackImageRemoved: false,
    ...(rollbackRecordRemoved
      ? { rollbackRecordRemoved: true }
      : { rollbackRecordPath: plan.recordPath, rollbackRecordRemoved: false }),
    ...removal,
  };
}

function isExactRunningReplacement(
  sandboxName: string,
  replacementContainerId: string,
  dockerRun: NonNullable<DockerGpuPatchDeps["dockerRun"]>,
  timeoutMs: number,
): boolean {
  const expectedContainerId = fullDockerContainerId(replacementContainerId);
  if (!expectedContainerId || timeoutMs <= 0) return false;
  try {
    const deadline = Date.now() + timeoutMs;
    const containers = queryOpenShellDockerSandboxContainers(sandboxName, { dockerRun }, timeoutMs);
    if (
      !containers.ok ||
      containers.ids.length !== 1 ||
      fullDockerContainerId(containers.ids[0]) !== expectedContainerId
    ) {
      return false;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return false;
    const inspect = dockerRun(
      [
        "inspect",
        "--type",
        "container",
        "--format",
        "{{json .State.Running}}",
        expectedContainerId,
      ],
      {
        ignoreError: true,
        suppressOutput: true,
        timeout: Math.min(DOCKER_GPU_PATCH_TIMEOUT_MS, remainingMs),
      },
    );
    return hasZeroDockerExitStatus(inspect) && String(inspect.stdout ?? "").trim() === "true";
  } catch {
    return false;
  }
}

export function finalizeDockerGpuPatchBackup(
  options: DockerGpuPatchFinalizeOptions,
  deps: DockerGpuPatchDeps = {},
): DockerGpuPatchFinalizeOutcome {
  const resolved = resolveDockerGpuPatchRollbackDeps(deps);
  const containerOpts = {
    ignoreError: true,
    suppressOutput: true,
    timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
  };
  if (options.result.backupRemoved) {
    return { backupRemoved: true, rolledBack: false };
  }
  if (options.supervisorReady) {
    // Stop the exact replacement before retiring the exact backup, then start
    // the replacement afterward. The final start is the authoritative Docker
    // lifecycle event. Keep a committed rollback image until OpenShell accepts
    // the exact replacement as Ready (#9531).
    if (!deps.runOpenshell || !deps.runCaptureOpenshell) {
      return {
        backupRemoved: false,
        rolledBack: false,
        replacementStoppedForCommit: false,
        finalHandoffAcknowledged: false,
        lastSandboxPhase: null,
      };
    }
    const stopResult = resolved.dockerStop(options.result.newContainerId, containerOpts);
    if (!hasZeroDockerExitStatus(stopResult)) {
      return {
        backupRemoved: false,
        rolledBack: false,
        replacementStoppedForCommit: false,
      };
    }
    const rollbackPlan = preparePostCommitRollback(
      options.result,
      options.sandboxName,
      deps,
      resolved,
      containerOpts,
    );
    if (!rollbackPlan) {
      const replacementRestarted = hasZeroDockerExitStatus(
        resolved.dockerStart(options.result.newContainerId, containerOpts),
      );
      return {
        backupRemoved: false,
        rolledBack: false,
        replacementStoppedForCommit: true,
        replacementRestarted,
        finalHandoffAcknowledged: false,
        lastSandboxPhase: null,
      };
    }
    const rmResult = resolved.dockerRm(rollbackPlan.oldContainerId, containerOpts);
    const backupRemoved = hasZeroDockerExitStatus(rmResult);
    if (!backupRemoved) {
      const rollbackImageRemoved = removeRollbackImage(
        rollbackPlan.imageId,
        resolved,
        containerOpts,
      );
      const rollbackRecordRemoved = removeRollbackRecord(rollbackPlan.recordPath);
      const replacementRestarted = hasZeroDockerExitStatus(
        resolved.dockerStart(options.result.newContainerId, containerOpts),
      );
      return {
        backupRemoved: false,
        rolledBack: false,
        ...(rollbackImageRemoved
          ? { rollbackImageRemoved: true }
          : { rollbackImageId: rollbackPlan.imageId, rollbackImageRemoved: false }),
        ...(rollbackRecordRemoved
          ? { rollbackRecordRemoved: true }
          : { rollbackRecordPath: rollbackPlan.recordPath, rollbackRecordRemoved: false }),
        replacementStoppedForCommit: true,
        replacementRestarted,
        finalHandoffAcknowledged: false,
        lastSandboxPhase: null,
      };
    }
    console.log(
      `  Waiting for OpenShell to retire the previous lifecycle record before restarting the replacement (up to ${options.finalHandoffTimeoutSecs}s)...`,
    );
    const lifecycleReleaseObserved = waitForOpenShellSandboxLifecycleRelease(
      options.sandboxName,
      options.finalHandoffTimeoutSecs,
      {
        runOpenshell: deps.runOpenshell,
        sleep: deps.sleep,
        soleLabeledReplacementCorroboratesRetiringPhase: (remainingMs) => {
          const expectedContainerId = fullDockerContainerId(options.result.newContainerId);
          if (!expectedContainerId || remainingMs <= 0) return false;
          const containers = queryOpenShellDockerSandboxContainers(
            options.sandboxName,
            { dockerRun: resolved.dockerRun },
            remainingMs,
          );
          return (
            containers.ok &&
            containers.ids.length === 1 &&
            fullDockerContainerId(containers.ids[0]) === expectedContainerId
          );
        },
      },
    );
    if (!lifecycleReleaseObserved) {
      const rollback = restorePostCommitRollback(
        rollbackPlan,
        options.result,
        resolved,
        containerOpts,
      );
      return {
        backupRemoved: true,
        ...rollback,
        replacementStoppedForCommit: true,
        replacementRestarted: false,
        lifecycleReleaseObserved: false,
        finalHandoffAcknowledged: false,
        lastSandboxPhase: null,
      };
    }
    const startResult = resolved.dockerStart(options.result.newContainerId, containerOpts);
    const replacementRestarted = hasZeroDockerExitStatus(startResult);
    if (!replacementRestarted) {
      const rollback = restorePostCommitRollback(
        rollbackPlan,
        options.result,
        resolved,
        containerOpts,
      );
      return {
        backupRemoved: true,
        ...rollback,
        replacementStoppedForCommit: true,
        replacementRestarted,
        finalHandoffAcknowledged: false,
        lastSandboxPhase: null,
      };
    }
    console.log(
      `  Waiting for OpenShell to confirm the final replacement handoff (up to ${options.finalHandoffTimeoutSecs}s)...`,
    );
    const acknowledgement = waitForOpenShellFinalHandoff(
      options.sandboxName,
      options.finalHandoffTimeoutSecs,
      {
        runCaptureOpenshell: deps.runCaptureOpenshell,
        runOpenshell: deps.runOpenshell,
        sleep: deps.sleep,
        replacementIsExactAndRunning: (remainingMs) =>
          isExactRunningReplacement(
            options.sandboxName,
            options.result.newContainerId,
            resolved.dockerRun,
            remainingMs,
          ),
      },
    );
    if (!acknowledgement.acknowledged) {
      const rollback = restorePostCommitRollback(
        rollbackPlan,
        options.result,
        resolved,
        containerOpts,
      );
      return {
        backupRemoved: true,
        ...rollback,
        replacementStoppedForCommit: true,
        replacementRestarted: true,
        lifecycleReleaseObserved: true,
        finalHandoffAcknowledged: false,
        lastSandboxPhase: acknowledgement.lastSandboxPhase,
      };
    }
    const rollbackImageRemoved = removeRollbackImage(rollbackPlan.imageId, resolved, containerOpts);
    const rollbackRecordRemoved = removeRollbackRecord(rollbackPlan.recordPath);
    if (!rollbackImageRemoved) {
      console.warn(`  Could not remove temporary Docker rollback image ${rollbackPlan.imageId}.`);
    }
    if (!rollbackRecordRemoved) {
      console.warn(`  Could not remove Docker rollback record ${rollbackPlan.recordPath}.`);
    }
    return {
      backupRemoved: true,
      rolledBack: false,
      ...(rollbackImageRemoved
        ? { rollbackImageRemoved: true }
        : { rollbackImageId: rollbackPlan.imageId, rollbackImageRemoved: false }),
      ...(rollbackRecordRemoved
        ? { rollbackRecordRemoved: true }
        : { rollbackRecordPath: rollbackPlan.recordPath, rollbackRecordRemoved: false }),
      replacementStoppedForCommit: true,
      replacementRestarted: true,
      lifecycleReleaseObserved: true,
      finalHandoffAcknowledged: true,
      lastSandboxPhase: acknowledgement.lastSandboxPhase,
    };
  }
  const rollback = rollbackToBackupContainer(
    {
      newContainerId: options.result.newContainerId,
      backupContainerName: options.result.backupContainerName,
      originalName: options.result.originalName,
    },
    resolved,
  );
  return { backupRemoved: false, ...rollback };
}
