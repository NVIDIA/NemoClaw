// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type DestroySandboxPresence = "present" | "absent" | "unknown";

function isStrictSandboxListJsonRow(value: unknown): value is { name: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const labels = row.labels;
  return (
    typeof row.id === "string" &&
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

export function classifyDestroySandboxPresence(
  sandboxName: string,
  result: { status: number | null; stdout?: string; stderr?: string },
): DestroySandboxPresence {
  if (result.status !== 0) return "unknown";
  const stderr = result.stderr?.trim() ?? "";
  if (stderr) return "unknown";
  let rows: unknown;
  try {
    rows = JSON.parse(result.stdout ?? "");
  } catch {
    return "unknown";
  }
  if (!Array.isArray(rows) || !rows.every(isStrictSandboxListJsonRow)) {
    return "unknown";
  }
  return rows.some((row) => row.name === sandboxName) ? "present" : "absent";
}
