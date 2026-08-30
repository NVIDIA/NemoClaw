// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { parseStrictOpenShellSandboxListJson } from "./sandbox-identity";

export type OpenShellSandboxPresence = "present" | "absent" | "unknown";

export type OpenShellSandboxIdentityObservation =
  | { readonly kind: "present"; readonly id: string; readonly phase: string }
  | { readonly kind: "absent" }
  | { readonly kind: "unknown" };

/**
 * Classifies an exact sandbox from the structured OpenShell list response.
 * Malformed rows and command diagnostics fail closed as unknown presence.
 */
export function classifyOpenShellSandboxPresence(
  sandboxName: string,
  result: { status: number | null; stdout?: string; stderr?: string },
): OpenShellSandboxPresence {
  return observeOpenShellSandboxIdentity(sandboxName, result).kind;
}

/** Read one exact sandbox ID and phase from structured OpenShell list output. */
export function observeOpenShellSandboxIdentity(
  sandboxName: string,
  result: { status: number | null; stdout?: string; stderr?: string },
): OpenShellSandboxIdentityObservation {
  if (result.status !== 0 || (result.stderr?.trim().length ?? 0) > 0) {
    return { kind: "unknown" };
  }

  const rows = parseStrictOpenShellSandboxListJson(result.stdout ?? "");
  if (!rows) return { kind: "unknown" };

  const matches = rows.filter((row) => row.name === sandboxName);
  if (matches.length === 0) return { kind: "absent" };
  if (matches.length !== 1) return { kind: "unknown" };
  const match = matches[0]!;
  return { kind: "present", id: match.id, phase: match.phase };
}
