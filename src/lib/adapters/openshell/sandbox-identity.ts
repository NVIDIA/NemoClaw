// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

const ANSI_RE = /\x1b\[[0-9;]*m/gu;
const SANDBOX_ID_RE = /^[A-Za-z0-9._-]+$/u;
const SANDBOX_ID_MAX_LENGTH = 512;

export function isOpenShellSandboxId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= SANDBOX_ID_MAX_LENGTH &&
    SANDBOX_ID_RE.test(value)
  );
}

export function fingerprintOpenShellSandboxId(sandboxId: string): string | null {
  return isOpenShellSandboxId(sandboxId)
    ? createHash("sha256").update(sandboxId).digest("hex")
    : null;
}

export const NEMOCLAW_CREATE_ATTEMPT_LABEL = "ai.nvidia.nemoclaw.create-attempt" as const;
export const NEMOCLAW_CREATE_ATTEMPT_NONCE_HEX_LENGTH = 62 as const;
const CREATED_IDENTITY_SETTLEMENT_TIMEOUT_MS = 30_000;
const CREATED_IDENTITY_SETTLEMENT_INTERVAL_MS = 250;

export interface OpenShellSandboxListJsonRow {
  readonly id: string;
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly resource_version: number;
  readonly created_at: string;
  readonly phase: string;
  readonly current_policy_version: number;
}

function isStrictSandboxListJsonRow(value: unknown): value is OpenShellSandboxListJsonRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const labels = row.labels;
  return (
    isOpenShellSandboxId(row.id) &&
    typeof row.name === "string" &&
    row.name.length > 0 &&
    row.name.trim() === row.name &&
    !!labels &&
    typeof labels === "object" &&
    !Array.isArray(labels) &&
    Object.values(labels as Record<string, unknown>).every((label) => typeof label === "string") &&
    typeof row.resource_version === "number" &&
    Number.isFinite(row.resource_version) &&
    typeof row.created_at === "string" &&
    typeof row.phase === "string" &&
    row.phase.length > 0 &&
    typeof row.current_policy_version === "number" &&
    Number.isFinite(row.current_policy_version)
  );
}

export function parseStrictOpenShellSandboxListJson(
  output: string,
): readonly OpenShellSandboxListJsonRow[] | null {
  const rows = parseOpenShellSandboxListJson(output);
  return rows && rows.every(isStrictSandboxListJsonRow) ? rows : null;
}

function parseOpenShellSandboxListJson(output: string): readonly unknown[] | null {
  let rows: unknown;
  try {
    rows = JSON.parse(output);
  } catch {
    return null;
  }
  return Array.isArray(rows) ? rows : null;
}

export function parseOpenShellSandboxId(output: string): string | null {
  const matches = [
    ...String(output)
      .replace(ANSI_RE, "")
      .matchAll(/^\s*(?:Id|ID):\s*(\S+)\s*$/gm),
  ].map((match) => match[1] ?? "");
  return matches.length === 1 && isOpenShellSandboxId(matches[0]) ? (matches[0] as string) : null;
}

/** Hash the one durable OpenShell ID without importing sandbox mutation owners. */
export function fingerprintOpenShellSandboxLiveIdentity(output: string): string | null {
  return fingerprintOpenShellSandboxId(parseOpenShellSandboxId(output) ?? "");
}

export function resolveOpenShellSandboxId(
  sandboxName: string,
  runCaptureOpenshell: (args: string[], options?: Record<string, unknown>) => string,
  gatewayName?: string,
): string {
  const output = runCaptureOpenshell(
    ["sandbox", "get", ...(gatewayName ? ["-g", gatewayName] : []), sandboxName],
    {
      ignoreError: false,
    },
  );
  const sandboxId = parseOpenShellSandboxId(output);
  if (!sandboxId) {
    throw new Error(
      `OpenShell sandbox '${sandboxName}' did not return one exact durable sandbox ID.`,
    );
  }
  return sandboxId;
}

/**
 * Bind the first accepted sandbox ID to one create attempt. The random label is
 * supplied on `sandbox create`; a same-name replacement without that label is
 * rejected before the caller can run post-create effects.
 */
type CreatedOpenShellSandboxIdentityInput = {
  readonly sandboxName: string;
  readonly gatewayName: string;
  readonly createAttemptNonce: string;
  readonly runCaptureOpenshell: (args: string[], options?: Record<string, unknown>) => string;
};

type CreatedOpenShellSandboxIdentityObservation =
  | { readonly state: "matched"; readonly sandboxId: string }
  | { readonly state: "pending"; readonly sandboxId: string | null }
  | {
      readonly state: "invalid";
      readonly diagnostic:
        | "selector-execution-timeout"
        | "selector-execution-not-found"
        | "selector-execution-permission"
        | "selector-execution-nonzero"
        | "selector-execution-buffer-limit"
        | "selector-execution-resource-unavailable"
        | "selector-execution-other-code"
        | "selector-execution-uncoded-error"
        | "selector-execution-non-error"
        | "selector-output-malformed"
        | "selector-output-ambiguous"
        | "selector-row-malformed"
        | "selector-identity-mismatch"
        | "selector-metadata-malformed";
    };

function assertCreateAttemptNonce(createAttemptNonce: string): void {
  if (!/^[0-9a-f]{62}$/u.test(createAttemptNonce)) {
    throw new Error("OpenShell sandbox create-attempt identity is invalid.");
  }
}

function createdIdentityError(sandboxName: string, diagnostic = "settlement-incomplete"): Error {
  return new Error(
    `OpenShell did not return the exact created identity for sandbox '${sandboxName}'. Diagnostic class: ${diagnostic}.`,
  );
}

function hasIncompleteCreatedIdentityMetadata(row: Record<string, unknown>): boolean {
  const incomplete = (value: unknown): boolean => value === undefined || value === null;
  const resourceVersionValid =
    incomplete(row.resource_version) ||
    (typeof row.resource_version === "number" && Number.isFinite(row.resource_version));
  const createdAtValid = incomplete(row.created_at) || typeof row.created_at === "string";
  const phaseValid =
    incomplete(row.phase) || (typeof row.phase === "string" && row.phase.length > 0);
  const policyVersionValid =
    incomplete(row.current_policy_version) ||
    (typeof row.current_policy_version === "number" && Number.isFinite(row.current_policy_version));
  return (
    resourceVersionValid &&
    createdAtValid &&
    phaseValid &&
    policyVersionValid &&
    [row.resource_version, row.created_at, row.phase, row.current_policy_version].some(incomplete)
  );
}

function classifySelectorExecutionError(
  error: unknown,
):
  | "selector-execution-timeout"
  | "selector-execution-not-found"
  | "selector-execution-permission"
  | "selector-execution-nonzero"
  | "selector-execution-buffer-limit"
  | "selector-execution-resource-unavailable"
  | "selector-execution-other-code"
  | "selector-execution-uncoded-error"
  | "selector-execution-non-error" {
  if (!error || typeof error !== "object") return "selector-execution-non-error";
  const candidate = error as { readonly code?: unknown; readonly message?: unknown };
  if (candidate.code === "ETIMEDOUT") return "selector-execution-timeout";
  if (candidate.code === "ENOENT") return "selector-execution-not-found";
  if (candidate.code === "EACCES" || candidate.code === "EPERM") {
    return "selector-execution-permission";
  }
  if (candidate.code === "ENOBUFS") return "selector-execution-buffer-limit";
  if (candidate.code === "EAGAIN") return "selector-execution-resource-unavailable";
  if (
    typeof candidate.message === "string" &&
    /^Command failed with status \d+$/u.test(candidate.message)
  ) {
    return "selector-execution-nonzero";
  }
  if ("code" in candidate) return "selector-execution-other-code";
  return typeof candidate.message === "string"
    ? "selector-execution-uncoded-error"
    : "selector-execution-non-error";
}

export function observeCreatedOpenShellSandboxId(
  input: CreatedOpenShellSandboxIdentityInput,
  timeout: number,
): CreatedOpenShellSandboxIdentityObservation {
  assertCreateAttemptNonce(input.createAttemptNonce);
  let output: string;
  try {
    output = input.runCaptureOpenshell(
      [
        "sandbox",
        "list",
        "-g",
        input.gatewayName,
        "--selector",
        `${NEMOCLAW_CREATE_ATTEMPT_LABEL}=${input.createAttemptNonce}`,
        "--output",
        "json",
        "--limit",
        "2",
      ],
      {
        ignoreError: false,
        timeout,
        maxBuffer: 1024 * 1024,
        killSignal: "SIGKILL",
        killProcessTreeOnTimeout: true,
      },
    );
  } catch (error) {
    return { state: "invalid", diagnostic: classifySelectorExecutionError(error) };
  }
  const rows = parseOpenShellSandboxListJson(output);
  if (!rows) return { state: "invalid", diagnostic: "selector-output-malformed" };
  if (rows.length === 0) return { state: "pending", sandboxId: null };
  if (rows.length !== 1) {
    return { state: "invalid", diagnostic: "selector-output-ambiguous" };
  }
  const row = rows[0];
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return { state: "invalid", diagnostic: "selector-row-malformed" };
  }
  const candidate = row as Record<string, unknown>;
  const labels = candidate.labels;
  if (
    !isOpenShellSandboxId(candidate.id) ||
    candidate.name !== input.sandboxName ||
    !labels ||
    typeof labels !== "object" ||
    Array.isArray(labels) ||
    !Object.values(labels as Record<string, unknown>).every((label) => typeof label === "string") ||
    (labels as Record<string, string>)[NEMOCLAW_CREATE_ATTEMPT_LABEL] !== input.createAttemptNonce
  ) {
    return { state: "invalid", diagnostic: "selector-identity-mismatch" };
  }
  if (!isStrictSandboxListJsonRow(candidate)) {
    return hasIncompleteCreatedIdentityMetadata(candidate)
      ? { state: "pending", sandboxId: candidate.id }
      : { state: "invalid", diagnostic: "selector-metadata-malformed" };
  }
  return { state: "matched", sandboxId: candidate.id };
}

export function resolveCreatedOpenShellSandboxId(
  input: CreatedOpenShellSandboxIdentityInput,
): string {
  assertCreateAttemptNonce(input.createAttemptNonce);
  const observation = observeCreatedOpenShellSandboxId(
    input,
    CREATED_IDENTITY_SETTLEMENT_TIMEOUT_MS,
  );
  if (observation.state !== "matched") {
    throw createdIdentityError(
      input.sandboxName,
      observation.state === "invalid" ? observation.diagnostic : "settlement-pending",
    );
  }
  return observation.sandboxId;
}

/**
 * Settle the nonce-owned identity after OpenShell reports the create Ready.
 * An empty selector result or the one exact nonce-owned row with incomplete
 * publication metadata is retryable. Malformed, ambiguous, or mismatched
 * identity results remain terminal before any post-create effect. A prior ID
 * observed while the create client was still running remains part of the same
 * settlement, so disappearance or replacement cannot reset the identity gate.
 */
export function settleCreatedOpenShellSandboxId(input: {
  readonly sandboxName: string;
  readonly gatewayName: string;
  readonly createAttemptNonce: string;
  readonly runCaptureOpenshell: (args: string[], options?: Record<string, unknown>) => string;
  readonly priorSandboxId?: string | null;
  readonly now?: () => number;
  readonly sleep: (milliseconds: number) => void;
}): string {
  assertCreateAttemptNonce(input.createAttemptNonce);
  if (input.priorSandboxId !== undefined && input.priorSandboxId !== null) {
    if (!isOpenShellSandboxId(input.priorSandboxId)) {
      throw createdIdentityError(input.sandboxName);
    }
  }
  const now = input.now ?? (() => performance.now());
  const startedAt = now();
  const deadlineMs = startedAt + CREATED_IDENTITY_SETTLEMENT_TIMEOUT_MS;

  if (!Number.isFinite(startedAt) || !Number.isFinite(deadlineMs) || deadlineMs <= startedAt) {
    throw createdIdentityError(input.sandboxName);
  }

  let previousNowMs = startedAt;
  let pendingSandboxId: string | null = input.priorSandboxId ?? null;
  let diagnostic = "settlement-incomplete";
  const readNow = (): number => {
    const currentNowMs = now();
    if (!Number.isFinite(currentNowMs) || currentNowMs < previousNowMs) {
      throw createdIdentityError(input.sandboxName);
    }
    previousNowMs = currentNowMs;
    return currentNowMs;
  };

  for (;;) {
    const remainingMs = Math.floor(deadlineMs - readNow());
    if (remainingMs <= 0) break;

    const observation = observeCreatedOpenShellSandboxId(input, remainingMs);
    if (observation.state === "matched") {
      if (pendingSandboxId && observation.sandboxId !== pendingSandboxId) break;
      return observation.sandboxId;
    }
    if (observation.state === "invalid") {
      diagnostic = observation.diagnostic;
      break;
    }
    if (observation.sandboxId === null) {
      if (pendingSandboxId) break;
    } else if (pendingSandboxId && observation.sandboxId !== pendingSandboxId) {
      break;
    } else {
      pendingSandboxId = observation.sandboxId;
    }

    const remainingAfterReadMs = Math.floor(deadlineMs - readNow());
    if (remainingAfterReadMs <= 0) break;
    input.sleep(Math.min(CREATED_IDENTITY_SETTLEMENT_INTERVAL_MS, remainingAfterReadMs));
  }

  throw createdIdentityError(input.sandboxName, diagnostic);
}

/**
 * Read sandbox IDs from the OpenShell CLI, memoized per process.
 *
 * Session detection needs the durable ID because newer OpenShell connects every
 * sandbox through one fixed SSH alias and names the target only on its proxy
 * command (#9316). Keeping the host-boundary call here leaves the state layer
 * to parsing and classification. A sandbox whose ID cannot be read yields null,
 * which leaves detection on SSH-host matching rather than failing the
 * surrounding command.
 */
export function createOpenshellSandboxIdReader(
  openshellBinary: string,
  runCommand: (binary: string, args: string[]) => { status: number | null; stdout: string },
): (sandboxName: string) => string | null {
  const cache = new Map<string, string | null>();
  return (sandboxName: string): string | null => {
    const cached = cache.get(sandboxName);
    if (cached !== undefined) return cached;
    let resolved: string | null = null;
    try {
      const result = runCommand(openshellBinary, ["sandbox", "get", sandboxName]);
      resolved = result.status === 0 ? parseOpenShellSandboxId(result.stdout || "") : null;
    } catch {
      resolved = null;
    }
    cache.set(sandboxName, resolved);
    return resolved;
  };
}
