// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { stripVTControlCharacters } from "node:util";

import { redact, redactFullWithUrls } from "../security/redact";
import type { CreateOpenShellSandboxRequest } from "../adapters/openshell/sandbox-lifecycle";
import { cliName } from "./branding";
import type { CreatedSandboxReadinessResult } from "./sandbox-readiness-tracing";

/** Format recovery without authorizing mutable-name deletion or an unsafe onboarding retry. */
export function formatRetainedSandboxRecoveryMessage(input: {
  sandboxName: string;
  gatewayName: string;
  createAttemptLabel: string;
  sandboxIdentityFingerprint: string | null;
}): string {
  const createAttemptEvidence = `Create-attempt label: ${input.createAttemptLabel}. `;
  if (!input.sandboxIdentityFingerprint) {
    return (
      createAttemptEvidence +
      `NemoClaw could not confirm one exact durable sandbox identity for this create attempt's label on '${input.sandboxName}' through gateway '${input.gatewayName}', ` +
      "so it cannot confirm that this attempt created the sandbox. " +
      `Do not delete the sandbox by mutable name. Run '${cliName()} ${input.sandboxName} destroy'; it can clear retained recovery only after OpenShell confirms absence.`
    );
  }
  return (
    createAttemptEvidence +
    `Durable sandbox identity fingerprint: ${input.sandboxIdentityFingerprint}. ` +
    `NemoClaw stopped before owning-gateway publication and identity verification completed for sandbox '${input.sandboxName}' through gateway '${input.gatewayName}'. ` +
    `Do not delete the sandbox by mutable name. Run '${cliName()} ${input.sandboxName} destroy'. ` +
    "If OpenShell reports the sandbox present or cannot determine presence, the command removes nothing and preserves the recovery record. " +
    "Inspection is diagnostic only and does not authorize mutable-name deletion. " +
    `Recovery remains blocked while the sandbox is present or presence is unknown. Rerun '${cliName()} ${input.sandboxName} destroy --yes' after the owning gateway reports absence.`
  );
}

const CREATE_OUTPUT_TAIL_LINES = 12;

/**
 * Redacted tail of the OpenShell create stream, for failures that happen after
 * the stream ended without a confirmed sandbox identity (#14323). Returns null
 * when there is nothing to show, so callers print nothing instead of a blank.
 */
export function formatCreateOutputTail(output: string | null | undefined): string | null {
  if (!output) return null;
  // Normalize display controls before redaction so they cannot split credential names.
  const visibleOutput = stripVTControlCharacters(output).replace(
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029\p{Cf}]/gu,
    "",
  );
  const lines = redactFullWithUrls(visibleOutput)
    .replace(/\r\n?/gu, "\n")
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return null;
  return lines.slice(-CREATE_OUTPUT_TAIL_LINES).join("\n");
}

export function unconfirmedCreateMessage(sandboxName: string, diagnostic: string | null): string {
  return (
    `OpenShell did not return one exact durable identity for sandbox '${sandboxName}' from this create attempt, ` +
    `so NemoClaw cannot confirm the sandbox was created${diagnostic ? ` (${diagnostic})` : ""}.`
  );
}

export type SandboxCreateFailureReportOptions = {
  sandboxName: string;
  /** Non-zero exit status from the create stream. */
  createStatus: number;
  /** Raw create-stream output, used for failure classification and recovery hints. */
  createOutput: string;
  /** Pre-recreate/pre-upgrade state backup path to surface in diagnostics, if any. */
  restoreBackupPath: string | null;
  /** Deferred Portable create args, when the caller still owns a raw create representation. */
  createArgs?: readonly string[];
  /** Safe ordinary create context. Runtime environment and startup values are excluded. */
  createContext?: SandboxCreateRecoveryContext;
  /** Sandbox container output captured before rollback; `null` when none was found. */
  sandboxContainerOutput?: string | null;
};

export type SandboxCreateRecoveryContext = {
  readonly sourceReference: string;
  readonly policyAttached: boolean;
  readonly providers: readonly string[];
  readonly gpuRequested: boolean;
  readonly gpuDevice: string | null;
  readonly cpu: string | null;
  readonly memory: string | null;
};

export function createSandboxRecoveryContext(
  request: CreateOpenShellSandboxRequest,
): SandboxCreateRecoveryContext {
  return Object.freeze({
    sourceReference: request.source.reference,
    policyAttached: Boolean(request.policyPath),
    providers: Object.freeze([...(request.providers ?? [])]),
    gpuRequested: request.gpu !== undefined,
    gpuDevice: request.gpu?.device ?? null,
    cpu: request.resources?.cpu ?? null,
    memory: request.resources?.memory ?? null,
  });
}

export type SandboxCreateFailureReportDeps = {
  classifyCreateFailure(output: string): { kind: string };
  printCreateFailureDiagnostics(
    sandboxName: string,
    options: { backupPath: string | null; sandboxContainerOutput?: string | null },
  ): void;
  printRecoveryHints(
    output: string,
    options: {
      createArgs?: readonly string[];
      createContext?: SandboxCreateRecoveryContext;
    },
  ): void;
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
    ...(options.sandboxContainerOutput !== undefined
      ? { sandboxContainerOutput: options.sandboxContainerOutput }
      : {}),
  });
  deps.error("  Try:  openshell sandbox list        # check gateway state");
  if (options.createArgs || options.createContext) {
    deps.printRecoveryHints(redactedCreateOutput, {
      ...(options.createArgs ? { createArgs: options.createArgs } : {}),
      ...(options.createContext ? { createContext: options.createContext } : {}),
    });
  }
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
  cliName(): string;
  error(message: string): void;
  exitProcess(code: number): never;
};

export type SandboxReadinessTerminalResolution =
  | "deferred_to_docker_gpu_patch"
  | "terminal_failure_retained"
  | "timed_out_retained";

/** Map the readiness reason into the retained receipt terminal state. */
function readinessTerminalResolution(
  readiness: CreatedSandboxReadinessResult,
): SandboxReadinessTerminalResolution {
  return readiness.reason === "terminal_failure_phase"
    ? "terminal_failure_retained"
    : "timed_out_retained";
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
 * create diagnostics, then preserve the failed sandbox for retained recovery
 * unless the Docker-GPU patch owns its identity-bound cleanup, and exit.
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
    for (const line of formatCreatedSandboxReadinessReceipt({
      sandboxName: options.sandboxName,
      readiness: options.readiness,
      createStatus: options.createStatus,
      timeoutSecs: options.timeoutSecs,
      terminalResolution: readinessTerminalResolution(options.readiness),
    })) {
      deps.error(line);
    }
    deps.error(
      `  Recovery remains blocked while sandbox '${options.sandboxName}' exists. Do not delete it by mutable name; run '${deps.cliName()} ${options.sandboxName} destroy' to check for authoritative absence.`,
    );
  }
  if (options.useDockerGpuPatch) {
    deps.error(`  Retry: ${deps.cliName()} onboard`);
  }
  const exitCode = options.createStatus === 0 ? 1 : options.createStatus;
  return deps.exitProcess(exitCode);
}
