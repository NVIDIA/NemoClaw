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
