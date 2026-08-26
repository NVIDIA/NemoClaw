// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

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
  let rows: unknown;
  try {
    rows = JSON.parse(output);
  } catch {
    return null;
  }
  return Array.isArray(rows) && rows.every(isStrictSandboxListJsonRow) ? rows : null;
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
): string {
  const output = runCaptureOpenshell(["sandbox", "get", sandboxName], {
    ignoreError: false,
  });
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
export function resolveCreatedOpenShellSandboxId(input: {
  readonly sandboxName: string;
  readonly gatewayName: string;
  readonly createAttemptNonce: string;
  readonly runCaptureOpenshell: (args: string[], options?: Record<string, unknown>) => string;
}): string {
  if (!/^[0-9a-f]{62}$/u.test(input.createAttemptNonce)) {
    throw new Error("OpenShell sandbox create-attempt identity is invalid.");
  }
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
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        killSignal: "SIGKILL",
        killProcessTreeOnTimeout: true,
      },
    );
  } catch {
    throw new Error(
      `OpenShell did not return the exact created identity for sandbox '${input.sandboxName}'.`,
    );
  }
  const rows = parseStrictOpenShellSandboxListJson(output);
  const row = rows?.length === 1 ? rows[0] : null;
  if (
    !row ||
    row.name !== input.sandboxName ||
    row.labels[NEMOCLAW_CREATE_ATTEMPT_LABEL] !== input.createAttemptNonce
  ) {
    throw new Error(
      `OpenShell did not return the exact created identity for sandbox '${input.sandboxName}'.`,
    );
  }
  return row.id;
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
