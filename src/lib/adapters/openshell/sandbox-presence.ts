// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isOpenShellSandboxId } from "./sandbox-identity";

export type OpenShellSandboxPresence = "present" | "absent" | "unknown";

export type OpenShellSandboxIdentityObservation =
  | { readonly kind: "present"; readonly id: string; readonly phase: string }
  | { readonly kind: "absent" }
  | { readonly kind: "unknown" };

function isStrictSandboxListJsonRow(
  value: unknown,
): value is { id: string; name: string; phase: string } {
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

  let rows: unknown;
  try {
    rows = JSON.parse(result.stdout ?? "");
  } catch {
    return { kind: "unknown" };
  }

  if (!Array.isArray(rows) || !rows.every(isStrictSandboxListJsonRow)) {
    return { kind: "unknown" };
  }

  const matches = rows.filter((row) => row.name === sandboxName);
  if (matches.length === 0) return { kind: "absent" };
  if (matches.length !== 1) return { kind: "unknown" };
  const match = matches[0]!;
  return { kind: "present", id: match.id, phase: match.phase };
}
