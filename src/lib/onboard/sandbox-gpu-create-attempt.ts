// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { hasSandboxListEntry } from "../state/gateway";
import type { SandboxGpuProofResult } from "../state/registry";
import { classifySandboxCreateFailure } from "../validation";
import {
  canFallbackToDockerGpuCompatibility,
  type DockerGpuRoutePlan,
  initialDockerGpuRoute,
  type SelectedDockerGpuRoute,
} from "./docker-gpu-route";
import {
  type OpenShellDockerSandboxContainerQuery,
  queryOpenShellDockerSandboxContainers,
} from "./openshell-docker-sandbox-containers";

export type SandboxGpuCreateFailureStage = "create" | "readiness" | "gpu-proof";

export type SandboxGpuCreateAttemptSuccess<T> = {
  ok: true;
  route: SelectedDockerGpuRoute;
  value: T;
};

export type SandboxGpuCreateAttemptFailure = {
  ok: false;
  route: SelectedDockerGpuRoute;
  stage: SandboxGpuCreateFailureStage;
  error: unknown;
  fallbackEligible: boolean;
};

export type SandboxGpuCreateAttemptResult<T> =
  | SandboxGpuCreateAttemptSuccess<T>
  | SandboxGpuCreateAttemptFailure;

export type SandboxGpuCreatePlanFailure = SandboxGpuCreateAttemptFailure & {
  cleanupRefused?: string;
  preparationRefused?: string;
};

export type SandboxGpuCreatePlanResult<T> =
  | SandboxGpuCreateAttemptSuccess<T>
  | SandboxGpuCreatePlanFailure;

export type NativeGpuFallbackCleanupResult = {
  safe: boolean;
  reason: string | null;
  deleteStatus: number | null;
  sandboxPresent: boolean | null;
  containerIds: string[] | null;
};

type CommandResult = {
  status?: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
};

export type NativeGpuFallbackCleanupDeps = {
  runOpenshell(args: string[], options?: Record<string, unknown>): CommandResult;
  queryContainers?: (sandboxName: string) => OpenShellDockerSandboxContainerQuery;
  sleep?: (seconds: number) => void;
};

/**
 * Source-of-truth boundary for the localized native-GPU fallback (#6110).
 *
 * The invalid state is an ordinary-Linux native attempt whose OpenShell GPU
 * create, GPU-backed readiness, or CUDA-usability proof fails for an explicitly
 * GPU-specific reason. OpenShell owns native `sandbox create --gpu` injection
 * and the resulting device initialization; NemoClaw only classifies that
 * boundary and proves CUDA usability. Build, upload, TLS, provider, policy,
 * dashboard, and inference failures remain on their existing error paths.
 *
 * NemoClaw cannot source-fix the native injector because supported deployments
 * can combine different OpenShell and Docker versions that cannot be upgraded
 * atomically. The classification, orchestration, and cleanup regressions live
 * in `sandbox-gpu-create-failure-classification.test.ts`,
 * `sandbox-gpu-fallback-orchestration.test.ts`, and
 * `sandbox-gpu-cleanup-verification.test.ts`; the live fallback scenario proves
 * the same boundary against OpenShell.
 *
 * Retire ordinary-Linux automatic fallback only when the minimum supported
 * OpenShell is greater than 0.0.72 and that pinned minimum passes native GPU
 * create, readiness, and CUDA proof across every supported ordinary-Linux
 * environment. This is a version-bound acceptance gate, not a claim about an
 * unverified future release. Docker Desktop WSL and Jetson/Tegra compatibility
 * retirement remain separately gated by their native support.
 */
export function isNativeGpuCreatePreBuildRejection(output: string): boolean {
  const text = String(output ?? "");
  return (
    /(?:unexpected|unrecognized|unknown|unsupported)\s+(?:argument|option|flag)[^\n]*--gpu\b/i.test(
      text,
    ) || /--gpu\b[^\n]*(?:is not supported|was rejected)/i.test(text)
  );
}

function isDockerBuildFailureOutput(output: string): boolean {
  return (
    /\b(?:docker|image)\s+build\b[^\n]*(?:failed|failure|error)/i.test(output) ||
    /\bfailed to (?:build|compile|install)\b/i.test(output) ||
    /\bfailed to solve\b|\breturned a non-zero code\b/i.test(output)
  );
}

export function isNativeGpuCreateRoutingFailure(output: string): boolean {
  const text = String(output ?? "");
  // The create stream can include nested Docker build output. Keep those
  // failures on the build path even when a Dockerfile happens to mention the
  // OpenShell `--gpu` flag; only explicit create/injection evidence may retry.
  if (isDockerBuildFailureOutput(text)) return false;
  const failure = classifySandboxCreateFailure(output);
  if (failure.kind === "gpu_cdi_injection_failed") return true;
  if (failure.kind !== "unknown") return false;
  return (
    isNativeGpuCreatePreBuildRejection(text) ||
    /--gpu\b[^\n]*injection failed/i.test(text) ||
    /(?:native gpu injection|gpu device injection|gpu sandbox create)[^\n]*(?:failed|rejected|unsupported)/i.test(
      text,
    )
  );
}

/** Require explicit GPU injection/device-init evidence for a readiness retry. */
export function isNativeGpuReadinessRoutingFailure(output: string): boolean {
  const text = String(output ?? "");
  if (isDockerBuildFailureOutput(text)) return false;
  return (
    isNativeGpuCreateRoutingFailure(text) ||
    /(?:cuda|nvidia|gpu)[^\n]*(?:device|driver|injection|initializ(?:e|ation))[^\n]*(?:failed|error|unavailable)/i.test(
      text,
    ) ||
    /(?:failed|error|unavailable)[^\n]*(?:cuda|nvidia|gpu)[^\n]*(?:device|driver|injection|initializ(?:e|ation))/i.test(
      text,
    )
  );
}

export function isHardNativeGpuProofFailure(proof: SandboxGpuProofResult): boolean {
  return proof.status === "failed";
}

function commandText(result: CommandResult): string {
  return `${String(result.stdout ?? "")}\n${String(result.stderr ?? "")}`.trim();
}

/** Delete a failed native attempt and prove two stable, status-bearing absences. */
export function cleanupNativeGpuAttemptForFallback(
  sandboxName: string,
  deps: NativeGpuFallbackCleanupDeps,
  options: { maxAttempts?: number; stableAbsenceChecks?: number } = {},
): NativeGpuFallbackCleanupResult {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 5);
  const stableAbsenceChecks = Math.max(1, options.stableAbsenceChecks ?? 2);
  const deletion = deps.runOpenshell(["sandbox", "delete", sandboxName], {
    ignoreError: true,
    suppressOutput: true,
  });
  const deleteStatus = deletion.status ?? null;
  const queryContainers =
    deps.queryContainers ?? ((name: string) => queryOpenShellDockerSandboxContainers(name));
  let stableChecks = 0;
  let sandboxPresent: boolean | null = null;
  let containerIds: string[] | null = null;
  let lastReason =
    deleteStatus === 0 ? "cleanup absence has not been verified" : commandText(deletion) || null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const list = deps.runOpenshell(["sandbox", "list"], {
      ignoreError: true,
      suppressOutput: true,
    });
    const listOk = Number(list.status ?? 1) === 0;
    sandboxPresent = listOk ? hasSandboxListEntry(String(list.stdout ?? ""), sandboxName) : null;
    const containers = queryContainers(sandboxName);
    containerIds = containers.ok ? containers.ids : null;

    if (listOk && sandboxPresent === false && containers.ok && containers.ids.length === 0) {
      stableChecks += 1;
      if (stableChecks >= stableAbsenceChecks) {
        return {
          safe: true,
          reason: null,
          deleteStatus,
          sandboxPresent: false,
          containerIds: [],
        };
      }
    } else {
      stableChecks = 0;
      lastReason = !listOk
        ? commandText(list) || "openshell sandbox list failed"
        : sandboxPresent
          ? `sandbox '${sandboxName}' is still present`
          : !containers.ok
            ? containers.error
            : `labeled Docker containers remain: ${containers.ids.join(", ")}`;
    }
    if (attempt < maxAttempts - 1) deps.sleep?.(1);
  }

  return {
    safe: false,
    reason: lastReason || "cleanup absence could not be proven",
    deleteStatus,
    sandboxPresent,
    containerIds,
  };
}

export type SandboxGpuCreatePlanDeps<T> = {
  runAttempt(route: SelectedDockerGpuRoute): Promise<SandboxGpuCreateAttemptResult<T>>;
  captureNativeFailure?(failure: SandboxGpuCreateAttemptFailure): void;
  cleanupNativeFailure(): NativeGpuFallbackCleanupResult | Promise<NativeGpuFallbackCleanupResult>;
  prepareCompatibilityAttempt?(failure: SandboxGpuCreateAttemptFailure): void | Promise<void>;
  activateCompatibilityAttempt?(failure: SandboxGpuCreateAttemptFailure): void | Promise<void>;
  traceEvent?(name: string, attributes?: Record<string, unknown>): void;
};

/** Execute the internal GPU strategy with at most one compatibility retry. */
export async function executeSandboxGpuCreatePlan<T>(
  plan: DockerGpuRoutePlan,
  deps: SandboxGpuCreatePlanDeps<T>,
): Promise<SandboxGpuCreatePlanResult<T>> {
  const initialRoute = initialDockerGpuRoute(plan);
  const first = await deps.runAttempt(initialRoute);
  if (first.ok) {
    if (first.route === "native") {
      deps.traceEvent?.("gpu_native_success", { route: first.route });
    }
    return first;
  }
  if (
    first.route !== "native" ||
    !first.fallbackEligible ||
    !canFallbackToDockerGpuCompatibility(plan)
  ) {
    return first;
  }

  try {
    deps.captureNativeFailure?.(first);
  } catch {
    // Diagnostics are best effort; cleanup safety remains the retry gate.
  }
  try {
    await deps.prepareCompatibilityAttempt?.(first);
  } catch (error) {
    return {
      ...first,
      preparationRefused: error instanceof Error ? error.message : String(error),
    };
  }
  const cleanup = await deps.cleanupNativeFailure();
  if (!cleanup.safe) {
    return {
      ...first,
      cleanupRefused: cleanup.reason ?? "native GPU cleanup could not be proven safe",
    };
  }
  try {
    await deps.activateCompatibilityAttempt?.(first);
  } catch (error) {
    return {
      ...first,
      preparationRefused: error instanceof Error ? error.message : String(error),
    };
  }

  deps.traceEvent?.("gpu_compatibility_fallback", {
    from_route: "native",
    to_route: "compatibility",
    failure_stage: first.stage,
  });
  return deps.runAttempt("compatibility");
}
