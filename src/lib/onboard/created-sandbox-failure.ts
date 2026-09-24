// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { redact } from "../security/redact";
import type { CreateOpenShellSandboxRequest } from "../adapters/openshell/sandbox-lifecycle";
import { cliName } from "./branding";

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
      `Sandbox '${input.sandboxName}' reached Ready before OpenShell returned one exact durable create identity. Gateway '${input.gatewayName}'. ` +
      "OpenShell did not return one exact durable sandbox identity for this create attempt. " +
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
  printCreateFailureDiagnostics(sandboxName: string, options: { backupPath: string | null }): void;
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
