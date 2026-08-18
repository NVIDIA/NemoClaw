// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  dockerCapture as defaultDockerCapture,
  dockerLogs as defaultDockerLogs,
} from "../adapters/docker";
import {
  createDockerGpuDiagnosticRedactor,
  discoverDockerGpuDiagnosticSensitiveValues,
} from "./docker-gpu-diagnostic-redaction";
import {
  captureDockerGpuPatchSandboxSnapshot,
  classifyDockerGpuPatchFailure,
  collectDockerGpuPatchDiagnostics,
  findOpenShellDockerSandboxContainerIds,
} from "./docker-gpu-patch";
import { DOCKER_GPU_PATCH_TIMEOUT_MS } from "./docker-gpu-patch-constants";
import type {
  DockerContainerInspect,
  DockerGpuPatchDeps,
  DockerGpuPatchDiagnostics,
  DockerGpuPatchFailureClassification,
  DockerGpuPatchFailureContext,
  DockerGpuPatchResult,
} from "./docker-gpu-patch-types";
import { captureDockerContainerFailureEvidence } from "./managed-bootstrap/docker-container-failure-evidence";

const PRE_ROLLBACK_DIAGNOSTICS_TOTAL_BUDGET_MS = 10_000;
const PRE_ROLLBACK_DIAGNOSTICS_CALL_TIMEOUT_MS = 2_000;

type PreRollbackDiagnosticsDeps = Pick<
  DockerGpuPatchDeps,
  "runCaptureOpenshell" | "dockerCapture" | "dockerLogs" | "homedir" | "now"
>;

/**
 * SOURCE_OF_TRUTH_REVIEW
 * invalidState: Docker created a replacement but OpenShell did not reconnect; rollback would
 *   erase its transient process, network, state, and log evidence.
 * sourceBoundary: Docker/OpenShell own that ephemeral state; this wrapper snapshots it
 *   immediately before rollback, and the shared collector remains the sole redaction and
 *   artifact-publication boundary for every caller.
 * whyNotSourceFix: this layer cannot reconnect the external supervisor or retain the failed
 *   replacement without delaying restoration, so capture is best effort and strictly bounded.
 * regressionTest: docker-gpu-pre-rollback-diagnostics.test.ts covers the allowlisted bundle,
 *   redaction, and budget; docker-gpu-sandbox-create-diagnostics.test.ts proves capture precedes
 *   rollback and capture failure cannot block rollback.
 * removalCondition: remove only when the replacement path emits equivalent bounded, redacted
 *   evidence before rollback, or no longer replaces a container.
 */
function boundedDiagnosticsDeps(
  deps: PreRollbackDiagnosticsDeps,
): PreRollbackDiagnosticsDeps & Required<Pick<DockerGpuPatchDeps, "dockerCapture" | "dockerLogs">> {
  const capture = deps.dockerCapture ?? defaultDockerCapture;
  const logs = deps.dockerLogs ?? defaultDockerLogs;
  const deadline = Date.now() + PRE_ROLLBACK_DIAGNOSTICS_TOTAL_BUDGET_MS;
  const boundedOptions = (options: Record<string, unknown> | undefined) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    return {
      ...options,
      timeout: Math.min(PRE_ROLLBACK_DIAGNOSTICS_CALL_TIMEOUT_MS, remaining),
    };
  };
  return {
    ...deps,
    dockerCapture: (args, options) => {
      const bounded = boundedOptions(options);
      if (!bounded) return "";
      return capture(args, bounded);
    },
    dockerLogs: (containerName, options) => {
      const bounded = boundedOptions(options);
      if (!bounded) return "";
      return logs(containerName, bounded);
    },
    runCaptureOpenshell: deps.runCaptureOpenshell
      ? (args, options) => {
          const bounded = boundedOptions(options);
          if (!bounded) return "";
          return deps.runCaptureOpenshell?.(args, bounded) ?? "";
        }
      : undefined,
  };
}

function primeSensitiveDiagnosticValues(
  sandboxName: string,
  result: DockerGpuPatchResult,
  deps: PreRollbackDiagnosticsDeps,
): string[] {
  let discoveredContainerIds: string[] = [];
  try {
    discoveredContainerIds = findOpenShellDockerSandboxContainerIds(sandboxName, deps);
  } catch {
    // Known recreate targets still provide useful values when label discovery
    // races with rollback or daemon recovery.
  }
  const targets = [
    result.newContainerId,
    result.oldContainerId,
    result.backupContainerName,
    ...discoveredContainerIds,
  ].filter((target, index, values) => target.length > 0 && values.indexOf(target) === index);
  const sensitiveValues = new Set<string>();
  for (const target of targets) {
    try {
      const output = deps.dockerCapture?.(["inspect", target], {
        ignoreError: true,
        timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
      });
      if (!output?.trim()) continue;
      const parsed = JSON.parse(output);
      const entries = (Array.isArray(parsed) ? parsed : [parsed]) as DockerContainerInspect[];
      for (const entry of entries) {
        for (const value of discoverDockerGpuDiagnosticSensitiveValues(entry)) {
          sensitiveValues.add(value);
        }
      }
    } catch {
      // Diagnostics remain best effort when a short-lived target disappears.
    }
  }
  return [...sensitiveValues];
}

/**
 * Diagnostics bundle plus the verdict computed while the replacement container
 * was still inspectable. The failure path cannot rely on that replacement
 * remaining inspectable after rollback, so `classification` preserves the
 * exit-state evidence for the caller's user-facing failure message (#7996).
 */
export type DockerGpuPreRollbackDiagnostics = {
  classification: DockerGpuPatchFailureClassification;
  diagnostics: DockerGpuPatchDiagnostics | null;
};

export function captureDockerGpuPreRollbackDiagnostics(
  sandboxName: string,
  result: DockerGpuPatchResult,
  deps: PreRollbackDiagnosticsDeps = {},
): DockerGpuPreRollbackDiagnostics | null {
  const context: DockerGpuPatchFailureContext = {
    sandboxName,
    oldContainerId: result.oldContainerId,
    newContainerId: result.newContainerId,
    backupContainerName: result.backupContainerName,
    selectedMode: result.mode,
  };
  const diagnosticDeps = boundedDiagnosticsDeps(deps);
  // Preserve the short-lived failure verdict before optional inspect
  // enrichment can consume the shared capture budget. The replacement State
  // is the only source of its exit code once rollback removes the container.
  const failureEvidence = captureDockerContainerFailureEvidence(
    result.newContainerId,
    diagnosticDeps,
    { enrichInspect: false },
  );
  const snapshot = {
    ...captureDockerGpuPatchSandboxSnapshot(sandboxName, {}, diagnosticDeps),
    patchedContainerState: failureEvidence.state,
  };
  const additionalSensitiveValues = primeSensitiveDiagnosticValues(
    sandboxName,
    result,
    diagnosticDeps,
  );
  const classification = classifyDockerGpuPatchFailure(snapshot, result.mode, {
    managedStartupCommandMissing: failureEvidence.managedStartupCommandMissing,
  });
  const redactedClassification = createDockerGpuDiagnosticRedactor(
    additionalSensitiveValues,
  ).redactValue(classification) as DockerGpuPatchFailureClassification;
  let dockerTopOutput: string | null = null;
  try {
    const dockerCapture = diagnosticDeps.dockerCapture ?? defaultDockerCapture;
    dockerTopOutput = dockerCapture(
      ["top", result.newContainerId, "-eo", "user,pid,ppid,stat,comm"],
      { ignoreError: true, timeout: DOCKER_GPU_PATCH_TIMEOUT_MS },
    );
  } catch {
    // The remaining bundle is still useful when the clone exits before top.
  }
  const diagnostics = collectDockerGpuPatchDiagnostics(
    sandboxName,
    {
      context,
      selectedMode: result.mode,
      snapshot,
      classification,
      additionalSensitiveValues,
      dockerTopOutput,
      cleanupDisposition: "pending-rollback",
    },
    diagnosticDeps,
  );
  if (diagnostics) console.error(`  Pre-rollback diagnostics saved: ${diagnostics.dir}`);
  return { classification: redactedClassification, diagnostics };
}
