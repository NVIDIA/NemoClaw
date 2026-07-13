// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { hasSandboxListEntry } from "../state/gateway";
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
import {
  CLEANUP_POLL_INTERVAL_MS,
  MAX_CLEANUP_ATTEMPTS,
  STABLE_ABSENCE_CHECKS,
} from "./sandbox-gpu-fallback-constants";

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
 * SOURCE_OF_TRUTH_REVIEW (native failure classification; #6110)
 * invalidState: non-GPU failure or sandbox-controlled output authorizes a broader retry.
 * sourceBoundary: accept only strict pre-progress `--gpu` rejection or exact-container Docker
 *   runtime evidence; proof output also requires host configuration proving attachment absent.
 * whyNotSourceFix: supported OpenShell/Docker versions cannot be upgraded atomically.
 * regressionTest: create failure classification, fallback orchestration, cleanup, and live Hermes.
 * removalCondition: native injection replaces compatibility on every supported host.
 * Ordinary Linux also requires explicit `NEMOCLAW_DOCKER_GPU_PATCH=fallback`; WSL/Jetson are
 * separately gated, and unrelated create/readiness failures retain their existing paths.
 */
export function isNativeGpuCreatePreBuildRejection(output: string): boolean {
  const text = String(output ?? "");
  if (text.length > 4096) return false;
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0 || lines.length > 4) return false;
  const [errorLine, ...envelope] = lines;
  const exactError =
    /^error:\s+(?:unexpected|unrecognized|unknown|unsupported)\s+(?:argument|option|flag)(?:\s+|:\s*)['"`]?--gpu['"`]?(?:\s+(?:found|provided|specified))?\.?$/i.test(
      errorLine,
    ) ||
    /^error:\s+(?:argument|option|flag)\s+['"`]?--gpu['"`]?\s+(?:is not supported|was rejected)\.?$/i.test(
      errorLine,
    );
  return (
    exactError &&
    envelope.every(
      (line) =>
        /^tip:\s+to pass ['"`]--gpu['"`] as a value, use ['"`]-- --gpu['"`]\.?$/i.test(line) ||
        /^Usage:\s+openshell sandbox create(?:\s|$)/.test(line) ||
        /^For more information, try ['"`]--help['"`]\.?$/i.test(line),
    )
  );
}

export function isNativeGpuCreateRoutingFailure(
  output: string,
  options: { sawProgress: boolean },
): boolean {
  // Create output can contain arbitrary image build logs. Only a strict CLI
  // parser rejection before any build/create progress is trusted here.
  return options.sawProgress !== true && isNativeGpuCreatePreBuildRejection(output);
}

export function isTrustedNativeGpuRuntimeError(error: string): boolean {
  const text = String(error ?? "").trim();
  if (!text) return false;
  // Match complete Docker/NVIDIA runtime clauses, not a conjunction of tokens:
  // `.State.Error` can quote image-controlled WORKDIR/CMD paths.
  const selector = String.raw`nvidia\.com\/gpu=[A-Za-z0-9._-]+`;
  const selectors = String.raw`${selector}(?:,\s*${selector})*`;
  const directCdi = new RegExp(
    String.raw`^(?:Error response from daemon:\s*)?(?:CDI device injection failed:\s*)?unresolvable CDI devices ${selectors}\.?$`,
    "i",
  );
  const customDeviceCdi = new RegExp(
    String.raw`^error gathering device information while adding custom device ["']?${selector}["']?:\s*unresolvable CDI devices ${selectors}\.?$`,
    "i",
  );
  const ociCdi = new RegExp(
    String.raw`^failed to create task for container:\s*failed to create shim task:\s*OCI runtime create failed:\s*(?:could not apply required modification to OCI specification:\s*)?error injecting CDI devices:\s*unresolvable CDI devices ${selectors}(?::\s*unknown)?$`,
    "i",
  );
  return (
    directCdi.test(text) ||
    customDeviceCdi.test(text) ||
    ociCdi.test(text) ||
    /^(?:error response from daemon:\s*)?could not select device driver[^\n]*with capabilities:\s*\[\[?['"]?gpu['"]?\]?\]\.?$/i.test(
      text,
    )
  );
}

export function isNativeGpuReadinessRoutingFailure(evidence: {
  failurePhase: string | null;
  runtimeError: string;
}): boolean {
  return (
    evidence.failurePhase !== null &&
    ["Error", "Failed", "CrashLoopBackOff"].includes(evidence.failurePhase) &&
    isTrustedNativeGpuRuntimeError(evidence.runtimeError)
  );
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
  const maxAttempts = Math.max(1, options.maxAttempts ?? MAX_CLEANUP_ATTEMPTS);
  const stableAbsenceChecks = Math.max(1, options.stableAbsenceChecks ?? STABLE_ABSENCE_CHECKS);
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
    if (attempt < maxAttempts - 1) deps.sleep?.(CLEANUP_POLL_INTERVAL_MS / 1_000);
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
  /** Validate and render the retry without mutating host or process state. */
  prepareCompatibilityAttempt(failure: SandboxGpuCreateAttemptFailure): void | Promise<void>;
  /** Apply compatibility side effects only after native cleanup is proven safe. */
  activateCompatibilityAttempt(failure: SandboxGpuCreateAttemptFailure): void | Promise<void>;
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
    await deps.prepareCompatibilityAttempt(first);
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
    await deps.activateCompatibilityAttempt(first);
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
