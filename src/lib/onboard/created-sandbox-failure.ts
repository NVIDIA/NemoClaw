// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { redact, redactFullWithUrls } from "../security/redact";

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
  printCreateFailureDiagnostics(sandboxName: string, options: { backupPath: string | null }): void;
  printRecoveryHints(output: string, options: { createArgs: readonly string[] }): void;
  error(message: string): void;
  exitProcess(code: number): never;
};

export function redactCreatedSandboxFailureDiagnostic(value: string, limit: number): string {
  return redactFullWithUrls(value).replace(/\s+/gu, " ").trim().slice(0, limit);
}

/** Report a hard sandbox create-stream failure with diagnostics and recovery hints. */
export function reportSandboxCreateFailure(
  options: SandboxCreateFailureReportOptions,
  deps: SandboxCreateFailureReportDeps,
): void {
  const redactedCreateOutput = redact(options.createOutput);
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
