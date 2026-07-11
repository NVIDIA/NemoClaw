// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { redact } from "../security/redact";
import type { CreatedSandboxReadinessResult } from "./sandbox-readiness-tracing";

export type SandboxCreateFailureReportOptions = {
  sandboxName: string;
  /** Non-zero exit status from the create stream. */
  createStatus: number;
  /** Raw create-stream output, used for failure classification and recovery hints. */
  createOutput: string;
  /** Pre-recreate/pre-upgrade state backup path to surface in diagnostics, if any. */
  restoreBackupPath: string | null;
  /** Resolved `openshell sandbox create` args, so recovery hints stay aligned with --from. */
  createArgs: readonly string[];
};

export type SandboxCreateFailureReportDeps = {
  classifyCreateFailure(output: string): { kind: string };
  printCreateFailureDiagnostics(sandboxName: string, options: { backupPath: string | null }): void;
  printRecoveryHints(output: string, options: { createArgs: readonly string[] }): void;
  warn(message: string): void;
  error(message: string): void;
  exitProcess(code: number): never;
};

/**
 * Report a non-zero sandbox create-stream exit. A mere "create incomplete"
 * (the sandbox exists in the gateway but the stream exited non-zero, e.g. SSH
 * 255) warns and returns so the caller can fall through to the ready-wait loop;
 * any other failure prints diagnostics + recovery hints and exits.
 */
export function reportSandboxCreateFailure(
  options: SandboxCreateFailureReportOptions,
  deps: SandboxCreateFailureReportDeps,
): void {
  const redactedCreateOutput = redact(options.createOutput);
  const failure = deps.classifyCreateFailure(redactedCreateOutput);
  if (failure.kind === "sandbox_create_incomplete") {
    // The sandbox was created in the gateway but the create stream exited
    // with a non-zero code (e.g. SSH 255).  Fall through to the ready-wait
    // loop — the sandbox may still reach Ready on its own.
    deps.warn("");
    deps.warn(
      `  Create stream exited with code ${options.createStatus} after sandbox was created.`,
    );
    deps.warn("  Checking whether the sandbox reaches Ready state...");
    return;
  }
  deps.error("");
  deps.error(`  Sandbox creation failed (exit ${options.createStatus}).`);
  if (options.createOutput) {
    deps.error("");
    deps.error(redactedCreateOutput);
  }
  deps.printCreateFailureDiagnostics(options.sandboxName, {
    backupPath: options.restoreBackupPath,
  });
  deps.error("  Try:  openshell sandbox list        # check gateway state");
  deps.printRecoveryHints(redactedCreateOutput, { createArgs: options.createArgs });
  return deps.exitProcess(options.createStatus === 0 ? 1 : options.createStatus);
}

export type SandboxReadinessFailureReportOptions = {
  sandboxName: string;
  readiness: CreatedSandboxReadinessResult;
  /** Exit status reported by the sandbox create stream before readiness polling. */
  createStatus: number;
  timeoutSecs: number;
  restoreBackupPath: string | null;
  /** When the Docker-GPU create patch is active, cleanup is deferred to the patch. */
  useDockerGpuPatch: boolean;
};

export type SandboxReadinessFailureReportDeps = {
  printReadinessFailure(
    readiness: CreatedSandboxReadinessResult,
    sandboxName: string,
    timeoutSecs: number,
  ): void;
  printCreateFailureDiagnostics(sandboxName: string, options: { backupPath: string | null }): void;
  printDockerGpuReadinessFailure(): void;
  deleteSandbox(sandboxName: string): { status: number | null };
  cliName(): string;
  error(message: string): void;
  exitProcess(code: number): never;
};

export type SandboxReadinessTerminalResolution =
  | "deferred_to_docker_gpu_patch"
  | "terminal_failure_deleted"
  | "terminal_failure_retained"
  | "timed_out_deleted"
  | "timed_out_retained";

/** Map the readiness reason and cleanup outcome into the receipt terminal state. */
function readinessTerminalResolution(
  readiness: CreatedSandboxReadinessResult,
  deleted: boolean,
): SandboxReadinessTerminalResolution {
  if (readiness.reason === "terminal_failure_phase") {
    return deleted ? "terminal_failure_deleted" : "terminal_failure_retained";
  }
  return deleted ? "timed_out_deleted" : "timed_out_retained";
}

/** Name the readiness gate that blocked the created sandbox from becoming Ready. */
function readinessGate(readiness: CreatedSandboxReadinessResult): string {
  if (readiness.reason === "terminal_failure_phase") {
    const phase =
      typeof readiness.failurePhase === "string" && readiness.failurePhase.length > 0
        ? readiness.failurePhase
        : "terminal_failure";
    return `sandbox_list:${phase}`;
  }
  return "sandbox_list:not_ready_timeout";
}

/**
 * Format the created-but-not-ready receipt so day-0 onboard failures retain a
 * stable terminal state: the created sandbox identity, last readiness gate,
 * cleanup result, and retry boundary are all visible in one block (#3344).
 */
function formatCreatedSandboxReadinessReceipt(options: {
  sandboxName: string;
  readiness: CreatedSandboxReadinessResult;
  createStatus: number;
  timeoutSecs: number;
  terminalResolution: SandboxReadinessTerminalResolution;
}): readonly string[] {
  return [
    "  Sandbox lifecycle receipt:",
    `    state: created_but_not_ready`,
    `    sandbox: ${options.sandboxName}`,
    `    readiness_gate: ${readinessGate(options.readiness)}`,
    `    readiness_reason: ${options.readiness.reason}`,
    `    create_stream_status: ${options.createStatus}`,
    `    timeout_seconds: ${options.timeoutSecs}`,
    `    terminal_resolution: ${options.terminalResolution}`,
  ];
}

/**
 * Report a sandbox that never reached Ready: print the readiness failure and
 * create diagnostics, then either defer cleanup to the Docker-GPU patch or
 * delete the failed sandbox so a same-name retry does not collide, and exit.
 */
export function reportSandboxReadinessFailure(
  options: SandboxReadinessFailureReportOptions,
  deps: SandboxReadinessFailureReportDeps,
): never {
  deps.error("");
  deps.printReadinessFailure(options.readiness, options.sandboxName, options.timeoutSecs);
  deps.printCreateFailureDiagnostics(options.sandboxName, {
    backupPath: options.restoreBackupPath,
  });
  if (options.useDockerGpuPatch) {
    for (const line of formatCreatedSandboxReadinessReceipt({
      sandboxName: options.sandboxName,
      readiness: options.readiness,
      createStatus: options.createStatus,
      timeoutSecs: options.timeoutSecs,
      terminalResolution: "deferred_to_docker_gpu_patch",
    })) {
      deps.error(line);
    }
    deps.printDockerGpuReadinessFailure();
  } else {
    // Clean up non-GPU failures after preserving local diagnostics so the
    // next onboard retry with the same name does not fail on "sandbox already exists".
    const delResult = deps.deleteSandbox(options.sandboxName);
    if (delResult.status === 0) {
      for (const line of formatCreatedSandboxReadinessReceipt({
        sandboxName: options.sandboxName,
        readiness: options.readiness,
        createStatus: options.createStatus,
        timeoutSecs: options.timeoutSecs,
        terminalResolution: readinessTerminalResolution(options.readiness, true),
      })) {
        deps.error(line);
      }
      deps.error(
        `  Deleted sandbox '${options.sandboxName}' after the readiness gate failed; retry will recreate it.`,
      );
    } else {
      for (const line of formatCreatedSandboxReadinessReceipt({
        sandboxName: options.sandboxName,
        readiness: options.readiness,
        createStatus: options.createStatus,
        timeoutSecs: options.timeoutSecs,
        terminalResolution: readinessTerminalResolution(options.readiness, false),
      })) {
        deps.error(line);
      }
      deps.error("  Could not remove the failed sandbox. Manual cleanup:");
      deps.error(`    openshell sandbox delete "${options.sandboxName}"`);
    }
  }
  deps.error(`  Retry: ${deps.cliName()} onboard`);
  const exitCode = options.createStatus === 0 ? 1 : options.createStatus;
  return deps.exitProcess(exitCode);
}
