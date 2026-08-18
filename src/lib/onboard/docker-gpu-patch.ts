// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { dockerCapture } from "../adapters/docker";
import { parseLiveSandboxEntries } from "../runtime-recovery";
import { createDockerGpuDiagnosticRedactor } from "./docker-gpu-diagnostic-redaction";
import { DOCKER_GPU_PATCH_TIMEOUT_MS } from "./docker-gpu-patch-constants";
import type {
  DockerContainerState,
  DockerGpuPatchBackend,
  DockerGpuPatchDeps,
  DockerGpuPatchFailureClassification,
  DockerGpuPatchFailureContext,
  DockerGpuPatchFailureKind,
  DockerGpuPatchMode,
  DockerGpuPatchResult,
  DockerGpuPatchSandboxSnapshot,
  DockerUlimit,
} from "./docker-gpu-patch-types";

export { detectSandboxFallbackDns } from "./docker-gpu-dns-fallback";
export { detectTegraDeviceGroupGids } from "./docker-gpu-jetson-groups";
export {
  buildDockerGpuCloneRunArgs,
  buildDockerGpuCloneRunOptions,
  DOCKER_GPU_PATCH_NETWORK_ENV,
  getDockerGpuPatchNetworkMode,
  parseDockerInspectJson,
} from "./docker-gpu-patch-clone";

import { collectDockerGpuPatchDiagnostics } from "./docker-gpu-patch-diagnostics";
import { formatDockerContainerState } from "./managed-bootstrap/docker-container-failure-evidence";
import {
  getDockerGpuPatchFailureContext,
  recreateOpenShellDockerSandboxContainer,
  recreateOpenShellDockerSandboxWithGpu,
} from "./docker-gpu-patch-recreate";
import {
  DOCKER_GPU_SUPERVISOR_RECONNECT_ERROR_DEBOUNCE_ENV,
  DOCKER_GPU_SUPERVISOR_RECONNECT_TIMEOUT_ENV,
  type DockerGpuSupervisorReconnectDeps,
  getDockerGpuSupervisorReconnectErrorDebouncePolls,
  getDockerGpuSupervisorReconnectTimeoutSecs,
  waitForOpenShellSupervisorReconnect,
} from "./docker-gpu-supervisor-reconnect";

export {
  collectDockerGpuPatchDiagnostics,
  dockerGpuPatchCleanupCommands,
  formatDockerInspectNetworkSummary,
} from "./docker-gpu-patch-diagnostics";
export {
  buildDockerGpuMode,
  buildDockerGpuModeCandidates,
  DEFAULT_DOCKER_CDI_SPEC_DIRS,
  dockerReportsNvidiaCdiDevices,
  selectDockerGpuPatchMode,
} from "./docker-gpu-patch-mode";
export {
  getDockerGpuPatchFailureContext,
  recreateOpenShellDockerSandboxContainer,
  recreateOpenShellDockerSandboxWithGpu,
} from "./docker-gpu-patch-recreate";
export type {
  DockerContainerInspect,
  DockerContainerState,
  DockerGpuCloneRunOptions,
  DockerGpuPatchBackend,
  DockerGpuPatchDeps,
  DockerGpuPatchDiagnostics,
  DockerGpuPatchFailureClassification,
  DockerGpuPatchFailureContext,
  DockerGpuPatchFailureKind,
  DockerGpuPatchMode,
  DockerGpuPatchModeAttempt,
  DockerGpuPatchModeKind,
  DockerGpuPatchResult,
  DockerGpuPatchSandboxSnapshot,
  DockerUlimit,
} from "./docker-gpu-patch-types";
export {
  findOpenShellDockerSandboxContainerIds,
  isImmutableDockerImageId,
  OPENSHELL_MANAGED_BY_LABEL,
  OPENSHELL_MANAGED_BY_VALUE,
  OPENSHELL_SANDBOX_NAME_LABEL,
  type OpenShellDockerSandboxContainerQuery,
  type OpenShellDockerSandboxRuntimeSnapshotQuery,
  queryOpenShellDockerSandboxContainers,
  queryOpenShellDockerSandboxRuntimeSnapshot,
} from "./openshell-docker-sandbox-containers";

export type { DockerGpuSupervisorReconnectDeps };
export {
  DOCKER_GPU_SUPERVISOR_RECONNECT_ERROR_DEBOUNCE_ENV,
  DOCKER_GPU_SUPERVISOR_RECONNECT_TIMEOUT_ENV,
  getDockerGpuSupervisorReconnectErrorDebouncePolls,
  getDockerGpuSupervisorReconnectTimeoutSecs,
  waitForOpenShellSupervisorReconnect,
};

function printDockerGpuPatchCleanup(
  context: DockerGpuPatchFailureContext | null,
  diagnostics: ReturnType<typeof collectDockerGpuPatchDiagnostics>,
): void {
  if (context?.rolledBack === true) {
    console.error("  The pre-patch sandbox container was restored and started.");
    if (diagnostics?.cleanupDisposition === "manual") {
      console.error("  The failed replacement container may still be present.");
      console.error("  Manual cleanup:");
      for (const command of diagnostics.cleanupCommands) console.error(`    ${command}`);
    } else if (
      !diagnostics ||
      diagnostics.cleanupDisposition === "unknown" ||
      diagnostics.cleanupDisposition === "pending_rollback"
    ) {
      console.error(
        "  Replacement container cleanup could not be confirmed. Inspect the diagnostics before removing any container.",
      );
    }
    return;
  }
  console.error(
    "  The failed sandbox and container state is uncertain. Inspect the diagnostics before removing any container.",
  );
}

export function applyDockerGpuPatchOrExit(
  options: {
    sandboxName: string;
    gpuDevice?: string | null;
    timeoutSecs: number;
    // Forwarded to `recreateOpenShellDockerSandboxWithGpu` so the Jetson
    // backend selects the NVIDIA runtime mode AND grants the Tegra device-node
    // group(s) to the sandbox user (#4231). Without threading this through, the
    // `ensureApplied` fallback path would recreate the container without
    // /dev/nvmap group access.
    backend?: DockerGpuPatchBackend;
    openshellSandboxCommand?: readonly string[] | null;
    dockerDesktopWsl?: boolean;
  },
  deps: Pick<DockerGpuPatchDeps, "runOpenshell" | "runCaptureOpenshell" | "sleep">,
): DockerGpuPatchResult {
  console.log("  Recreating OpenShell Docker sandbox container with NVIDIA GPU access...");
  try {
    const result = recreateOpenShellDockerSandboxWithGpu(options, deps);
    console.log(`  ✓ Docker GPU mode selected: ${result.mode.label}`);
    return result;
  } catch (error) {
    printDockerGpuPatchFailureAndExit(options.sandboxName, error, {
      runCaptureOpenshell: deps.runCaptureOpenshell,
    });
  }
}

function printDockerGpuPatchClassificationLines(
  classification: DockerGpuPatchFailureClassification | null,
): void {
  if (!classification) return;
  if (classification.headline) console.error(`  ${classification.headline}`);
  for (const line of classification.summaryLines) console.error(`    ${line}`);
  for (const hint of classification.hints ?? []) console.error(`  ${hint}`);
}

function patchedContainerIdFromContext(
  context?: DockerGpuPatchFailureContext | null,
): string | null {
  // Snapshot only the newly created GPU-enabled container. Falling back to
  // `oldContainerId` here would inspect the original (or its renamed backup)
  // and mis-attribute its State as the patched container's — see #4316
  // review feedback.
  if (!context) return null;
  return context.newContainerId || null;
}

function snapshotInspectDeps(
  deps: Pick<DockerGpuPatchDeps, "runCaptureOpenshell" | "dockerCapture">,
): Pick<DockerGpuPatchDeps, "runCaptureOpenshell" | "dockerCapture"> {
  // `depsWithDefaults` spreads the caller's `deps`, so passing an explicit
  // `dockerCapture: undefined` would shadow the module's default Docker
  // adapter and disable downstream `docker ps`/`inspect`/`logs` capture.
  // Build the inner deps object with only the keys the caller actually
  // supplied so defaults stay in place.
  const inner: Pick<DockerGpuPatchDeps, "runCaptureOpenshell" | "dockerCapture"> = {};
  if (deps.runCaptureOpenshell) inner.runCaptureOpenshell = deps.runCaptureOpenshell;
  if (deps.dockerCapture) inner.dockerCapture = deps.dockerCapture;
  return inner;
}

function classificationMatchesSelectedMode(
  classification: DockerGpuPatchFailureClassification,
  selectedMode: DockerGpuPatchMode | null,
): boolean {
  if (!selectedMode) return false;
  return classification.selectedModeKind === selectedMode.kind;
}

export function printDockerGpuPatchFailureAndExit(
  sandboxName: string,
  error: unknown,
  deps: Pick<DockerGpuPatchDeps, "runCaptureOpenshell" | "dockerCapture"> & {
    context?: DockerGpuPatchFailureContext | null;
    selectedMode?: DockerGpuPatchMode | null;
    additionalSummaryLines?: readonly string[];
    /**
     * Classification captured while the replacement container still existed.
     * The failure path cannot rely on that replacement remaining inspectable
     * after rollback, so a fresh snapshot can lose its exit state (#7996).
     */
    preRollbackClassification?: DockerGpuPatchFailureClassification | null;
  } & Pick<DockerGpuPatchDeps, "dockerLogs" | "homedir" | "now">,
): never {
  const context = deps.context || getDockerGpuPatchFailureContext(error) || null;
  const selectedMode = deps.selectedMode || context?.selectedMode || null;
  const inspectDeps = snapshotInspectDeps(deps);
  const snapshot = captureDockerGpuPatchSandboxSnapshot(
    sandboxName,
    { patchedContainerId: patchedContainerIdFromContext(context) },
    inspectDeps,
  );
  // Prefer the earlier verdict only when the fresh snapshot cannot inspect the
  // replacement container after rollback and the verdict describes this
  // failure's exact create option (#7996).
  const observedClassification = classifyDockerGpuPatchFailure(snapshot, selectedMode);
  const classification =
    deps.preRollbackClassification?.kind === "patched_container_failed" &&
    snapshot.patchedContainerState === null &&
    classificationMatchesSelectedMode(deps.preRollbackClassification, selectedMode)
      ? deps.preRollbackClassification
      : observedClassification;
  const diagnostics = collectDockerGpuPatchDiagnostics(
    sandboxName,
    {
      error,
      context,
      selectedMode,
      snapshot,
      classification,
      additionalSummaryLines: deps.additionalSummaryLines,
    },
    deps,
  );
  const errorMessage =
    error instanceof Error && error.message
      ? createDockerGpuDiagnosticRedactor().redactText(error.message)
      : "";
  console.error("");
  console.error("  Docker GPU patch failed.");
  if (errorMessage) {
    console.error(`  ${errorMessage}`);
  }
  printDockerGpuPatchClassificationLines(classification);
  if (diagnostics) {
    console.error(`  Diagnostics saved: ${diagnostics.dir}`);
  }
  console.error("  Escape hatches:");
  console.error("    NEMOCLAW_DOCKER_GPU_PATCH=1  use only the Docker GPU compatibility path.");
  console.error(
    "    NEMOCLAW_DOCKER_GPU_PATCH=0  use native OpenShell GPU injection (ignored on Docker Desktop WSL; Jetson also defaults to the compatibility path).",
  );
  console.error(
    "    NEMOCLAW_SANDBOX_GPU=0      skip GPU passthrough entirely (or rerun with --no-gpu).",
  );
  printDockerGpuPatchCleanup(context, diagnostics);
  process.exit(1);
}

export function printDockerGpuReadinessFailure(
  sandboxName: string,
  selectedMode: DockerGpuPatchMode | null,
  deps: Pick<DockerGpuPatchDeps, "runCaptureOpenshell" | "dockerCapture"> & {
    context?: DockerGpuPatchFailureContext | null;
    additionalSummaryLines?: readonly string[];
  },
): void {
  const context = deps.context ?? null;
  const inspectDeps = snapshotInspectDeps(deps);
  const snapshot = captureDockerGpuPatchSandboxSnapshot(
    sandboxName,
    { patchedContainerId: patchedContainerIdFromContext(context) },
    inspectDeps,
  );
  const classification = classifyDockerGpuPatchFailure(snapshot, selectedMode);
  const diagnostics = collectDockerGpuPatchDiagnostics(
    sandboxName,
    {
      selectedMode,
      context,
      snapshot,
      classification,
      additionalSummaryLines: deps.additionalSummaryLines,
    },
    inspectDeps,
  );
  printDockerGpuPatchClassificationLines(classification);
  if (diagnostics) {
    console.error(`  Docker GPU diagnostics saved: ${diagnostics.dir}`);
  }
  printDockerGpuPatchCleanup(context, diagnostics);
}

export function printDockerGpuProofFailure(
  sandboxName: string,
  error: unknown,
  selectedMode: DockerGpuPatchMode | null,
  deps: Pick<DockerGpuPatchDeps, "runCaptureOpenshell" | "dockerCapture"> & {
    context?: DockerGpuPatchFailureContext | null;
    additionalSummaryLines?: readonly string[];
  },
): void {
  const context = deps.context ?? null;
  const inspectDeps = snapshotInspectDeps(deps);
  const snapshot = captureDockerGpuPatchSandboxSnapshot(
    sandboxName,
    { patchedContainerId: patchedContainerIdFromContext(context) },
    inspectDeps,
  );
  const classification = classifyDockerGpuPatchFailure(snapshot, selectedMode, {
    proofError: error,
  });
  const diagnostics = collectDockerGpuPatchDiagnostics(
    sandboxName,
    {
      error,
      selectedMode,
      context,
      snapshot,
      classification,
      additionalSummaryLines: deps.additionalSummaryLines,
    },
    inspectDeps,
  );
  printDockerGpuPatchClassificationLines(classification);
  if (diagnostics) {
    console.error(`  Diagnostics saved: ${diagnostics.dir}`);
  }
  printDockerGpuPatchCleanup(context, diagnostics);
}

const SANDBOX_FAILURE_PHASE_TOKENS = new Set(["Error", "Failed", "CrashLoopBackOff"]);

const SANDBOX_LIVE_PHASE_TOKENS = new Set(["Ready", "Running"]);

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(value: string): string {
  return value.replace(ANSI_RE, "");
}

function findSandboxListLine(output: string, sandboxName: string): string | null {
  if (typeof output !== "string") return null;
  for (const line of stripAnsi(output).split("\n")) {
    if (line.trim().split(/\s+/)[0] === sandboxName) return line.trim();
  }
  return null;
}

function parseSandboxPhaseFromGetOutput(output: string): string | null {
  if (typeof output !== "string") return null;
  const match = stripAnsi(output).match(/^\s*Phase:\s+(\S+)/m);
  return match ? match[1] : null;
}

function parseSandboxPhaseFromListOutput(output: string, sandboxName: string): string | null {
  return parseLiveSandboxEntries(output).find((entry) => entry.name === sandboxName)?.phase ?? null;
}

function isFailurePhase(phase: string | null | undefined): boolean {
  return typeof phase === "string" && SANDBOX_FAILURE_PHASE_TOKENS.has(phase);
}

function parseDockerContainerState(json: string): DockerContainerState | null {
  if (!json.trim()) return null;
  try {
    const parsed = JSON.parse(json);
    // `docker inspect --format '{{json .State}}'` returns the State object
    // directly; `docker inspect <id>` returns an array of full container
    // descriptors with `.State` nested. Accept both shapes.
    if (parsed && typeof parsed === "object") {
      if ("Status" in parsed || "ExitCode" in parsed || "Running" in parsed) {
        return parsed as DockerContainerState;
      }
      const first = Array.isArray(parsed) ? parsed[0] : parsed;
      if (first && typeof first === "object" && "State" in first) {
        const state = (first as { State?: unknown }).State;
        if (state && typeof state === "object") return state as DockerContainerState;
      }
    }
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Capture the current sandbox phase from OpenShell and the patched
 * container's runtime State from Docker. Either field may be null when the
 * external CLI is unavailable or the named target no longer exists; callers
 * (notably `classifyDockerGpuPatchFailure`) treat null defensively.
 *
 * When `deps.dockerCapture` is not supplied, this helper falls back to the
 * module's default Docker adapter so the patched-container State is still
 * captured in production paths that only thread `runCaptureOpenshell`
 * through (e.g. `applyDockerGpuPatchOrExit`).
 */
export function captureDockerGpuPatchSandboxSnapshot(
  sandboxName: string,
  options: {
    patchedContainerId?: string | null;
  } = {},
  deps: Pick<DockerGpuPatchDeps, "runCaptureOpenshell" | "dockerCapture"> = {},
): DockerGpuPatchSandboxSnapshot {
  let sandboxPhase: string | null = null;
  let sandboxListLine: string | null = null;
  if (deps.runCaptureOpenshell) {
    try {
      const getOutput = deps.runCaptureOpenshell(["sandbox", "get", sandboxName], {
        ignoreError: true,
        timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
      });
      sandboxPhase = parseSandboxPhaseFromGetOutput(getOutput);
    } catch {
      /* best effort */
    }
    try {
      const listOutput = deps.runCaptureOpenshell(["sandbox", "list"], {
        ignoreError: true,
        timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
      });
      sandboxListLine = findSandboxListLine(listOutput, sandboxName);
      // Prefer the `sandbox list` phase whenever the named row is present.
      // The list row is the operator-facing gateway state and avoids letting
      // a stale `sandbox get` response drive the Docker-GPU failure
      // classification (#4316 CodeRabbit feedback).
      if (sandboxListLine) {
        const listPhase = parseSandboxPhaseFromListOutput(listOutput, sandboxName);
        if (listPhase) sandboxPhase = listPhase;
      }
    } catch {
      /* best effort */
    }
  }

  let patchedContainerState: DockerContainerState | null = null;
  const target = String(options.patchedContainerId || "").trim();
  if (target) {
    const capture = deps.dockerCapture ?? dockerCapture;
    try {
      const stateJson = capture(["inspect", "--format", "{{json .State}}", target], {
        ignoreError: true,
        timeout: DOCKER_GPU_PATCH_TIMEOUT_MS,
      });
      patchedContainerState = parseDockerContainerState(stateJson);
    } catch {
      /* best effort */
    }
  }

  return { sandboxPhase, sandboxListLine, patchedContainerState };
}

// Exit code 127 alone is ambiguous because `env` propagates a child process's
// status. Missing-startup guidance therefore requires a separate exact signal
// from the replacement container's captured logs (#7996).
const SANDBOX_STARTUP_COMMAND_NOT_FOUND_EXIT_CODE = 127;
const SANDBOX_STARTUP_COMMAND_NOT_FOUND_HINTS: readonly string[] = [
  "Container logs show that the sandbox image does not provide the NemoClaw-managed `nemoclaw-start` command.",
  "Rebuild the sandbox image from the complete Dockerfile and source context for the selected agent and NemoClaw release.",
];

function patchedContainerLooksFailed(state: DockerContainerState | null): boolean {
  if (!state) return false;
  if (state.Dead === true) return true;
  if (state.OOMKilled === true) return true;
  if (typeof state.ExitCode === "number" && state.ExitCode !== 0) return true;
  if (state.Error && state.Error.length > 0) return true;
  // `exited`/`dead`/`removing` indicate a container that did not stay up.
  // `running` and `restarting` are live states we do not classify as failed.
  if (typeof state.Status === "string") {
    const status = state.Status.toLowerCase();
    if (status === "exited" || status === "dead" || status === "removing") return true;
  }
  return false;
}

/**
 * Turn the snapshot + selected GPU mode into a user-facing classification
 * that distinguishes "the patched container itself died" from "the sandbox
 * never reached a live phase" from "the OpenShell supervisor cannot reach
 * the container" from "the GPU proof itself reported a runtime failure".
 *
 * This is the contract NemoClaw uses to tell users *which* part of the
 * GPU patch path broke — not just "something failed" (#4316).
 */
export function classifyDockerGpuPatchFailure(
  snapshot: DockerGpuPatchSandboxSnapshot,
  selectedMode: DockerGpuPatchMode | null,
  options: { proofError?: unknown; managedStartupCommandMissing?: boolean } = {},
): DockerGpuPatchFailureClassification {
  const lines: string[] = [];
  if (snapshot.sandboxPhase) lines.push(`sandbox_phase=${snapshot.sandboxPhase}`);
  if (snapshot.sandboxListLine) lines.push(`sandbox_list_row=${snapshot.sandboxListLine}`);
  lines.push(...formatDockerContainerState(snapshot.patchedContainerState, "patched_container_"));
  if (selectedMode) lines.push(`patched_create_option=${selectedMode.label}`);

  const containerFailed = patchedContainerLooksFailed(snapshot.patchedContainerState);
  const sandboxInErrorPhase = isFailurePhase(snapshot.sandboxPhase);
  const sandboxNotLive =
    !!snapshot.sandboxPhase && !SANDBOX_LIVE_PHASE_TOKENS.has(snapshot.sandboxPhase);

  const hints: string[] = [];
  let kind: DockerGpuPatchFailureKind = "unknown";
  let headline: string;
  if (containerFailed) {
    kind = "patched_container_failed";
    const exit = snapshot.patchedContainerState?.ExitCode;
    const opt = selectedMode ? ` (${selectedMode.label})` : "";
    headline =
      typeof exit === "number" && exit !== 0
        ? `Patched GPU container exited with code ${exit}${opt}.`
        : `Patched GPU container is not running${opt}.`;
    if (
      exit === SANDBOX_STARTUP_COMMAND_NOT_FOUND_EXIT_CODE &&
      options.managedStartupCommandMissing === true
    ) {
      hints.push(...SANDBOX_STARTUP_COMMAND_NOT_FOUND_HINTS);
    }
  } else if (sandboxInErrorPhase) {
    kind = "sandbox_error_phase";
    headline = `OpenShell sandbox entered ${snapshot.sandboxPhase} phase before the GPU proof could run.`;
  } else if (sandboxNotLive && (snapshot.patchedContainerState || options.proofError)) {
    // Cover the non-live-but-non-terminal case (e.g. Provisioning / NotReady)
    // BEFORE the proof-error branch — a proof failing while the sandbox
    // never reached Ready/Running is really a lifecycle failure, not a
    // proof failure. Classifying it as proof_failure would tell users
    // `nvidia-smi` failed inside an executable sandbox, which is the
    // wrong story (#4316 review feedback).
    //
    // Gate this on evidence that the patched container actually existed
    // (either we inspected its State, or we got far enough to attempt the
    // proof). Otherwise an early patch failure (e.g. mode probes rejected,
    // detached `docker run` failing) would mislabel a still-Provisioning
    // original sandbox as a supervisor reconnect issue.
    kind = "supervisor_unreachable";
    headline = `OpenShell supervisor did not reach Ready (last phase: ${snapshot.sandboxPhase}).`;
  } else if (options.proofError) {
    kind = "proof_failure";
    headline = "GPU proof failed inside an executable sandbox.";
  } else {
    headline = "Docker GPU patch did not complete successfully.";
  }

  if (options.proofError) {
    const proofText =
      options.proofError instanceof Error ? options.proofError.message : String(options.proofError);
    if (proofText) lines.push(`proof_error=${proofText}`);
  }
  const classification = {
    kind,
    headline,
    selectedModeKind: selectedMode?.kind ?? null,
    summaryLines: lines,
  };
  return hints.length > 0 ? { ...classification, hints } : classification;
}
