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
    deps.printDockerGpuReadinessFailure();
  } else {
    // Clean up non-GPU failures after preserving local diagnostics so the
    // next onboard retry with the same name does not fail on "sandbox already exists".
    const delResult = deps.deleteSandbox(options.sandboxName);
    if (delResult.status === 0) {
      deps.error("  The failed sandbox has been removed; retry will recreate it.");
    } else {
      deps.error("  Could not remove the failed sandbox. Manual cleanup:");
      deps.error(`    openshell sandbox delete "${options.sandboxName}"`);
    }
  }
  deps.error(`  Retry: ${deps.cliName()} onboard`);
  const exitCode = options.createStatus === 0 ? 1 : options.createStatus;
  return deps.exitProcess(exitCode);
}
