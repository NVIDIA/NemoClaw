// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const READ_STAGES = ["config_read", "roster_read", "os_read", "route_read"] as const;
export const COLLECTION_READ_FAILURES = [
  "cancelled",
  "deadline",
  "capture",
  "invocation",
  "timeout",
  "unavailable",
  "nonzero_exit",
  "failed",
] as const;
type ReadStage = (typeof READ_STAGES)[number];
export type CollectionReadFailure = (typeof COLLECTION_READ_FAILURES)[number];
const OTHER_COUNTS = [
  "inventory.failed",
  "inventory.deadline",
  "inventory.cancelled",
  "inventory.invalid_registration",
  "inventory.invalid_binding",
  "inventory.ambiguous_target",
  "runtime_authority.failed",
  "runtime_setup.failed",
  "config_target.failed",
  "config_parse.invalid",
  "roster_parse.invalid",
  "agents_projection.unresolved",
  "os_parse.invalid",
  "route_observation.authentication",
  "route_observation.timeout",
  "route_observation.validation",
  "route_observation.schema",
  "route_observation.transport",
  "route_observation.command",
  "route_projection.unresolved",
  "roster.config_recovered",
  "runtime.unsupported_parser",
  "runtime.inactive_artifact",
  "runtime.not_started_deadline",
  "runtime.not_started_cancelled",
  "snapshot.failed",
  "snapshot.deadline",
] as const;
export type CollectionDiagnosticKey =
  | `${ReadStage}.${CollectionReadFailure}`
  | (typeof OTHER_COUNTS)[number];
const KEYS: readonly CollectionDiagnosticKey[] = [
  ...READ_STAGES.flatMap((stage) =>
    COLLECTION_READ_FAILURES.map((reason) => `${stage}.${reason}` as const),
  ),
  ...OTHER_COUNTS,
];
const ALLOWED_KEYS = new Set<string>(KEYS);
const FRAME_KIND = "nemoclaw_collection_diagnostics_v1";
export const MAX_COLLECTION_DIAGNOSTIC_BYTES = 8192;
type Counts = Partial<Record<CollectionDiagnosticKey, number>>;

/** Local stage counts overlap; shared route reads count once per attempt, not per configuration. */
export class CollectionDiagnostics {
  private readonly counts: Counts = {};

  record(key: CollectionDiagnosticKey): void {
    if (ALLOWED_KEYS.has(key))
      this.counts[key] = Math.min(Number.MAX_SAFE_INTEGER, (this.counts[key] ?? 0) + 1);
  }

  serialize(): string {
    return JSON.stringify({ kind: FRAME_KIND, counts: this.counts });
  }
}

/** Accept only fixed categories and integer counts; never echo arbitrary child output. */
export function parseCollectionDiagnostics(raw: unknown): Counts | null {
  if (!(typeof raw === "string" || Buffer.isBuffer(raw))) return null;
  if (Buffer.byteLength(raw) > MAX_COLLECTION_DIAGNOSTIC_BYTES) return null;
  try {
    const frame = JSON.parse(String(raw));
    if (
      !frame ||
      Object.keys(frame).length !== 2 ||
      frame.kind !== FRAME_KIND ||
      !frame.counts ||
      typeof frame.counts !== "object" ||
      Array.isArray(frame.counts)
    )
      return null;
    const counts: Counts = {};
    for (const [key, count] of Object.entries(frame.counts)) {
      if (
        !ALLOWED_KEYS.has(key) ||
        typeof count !== "number" ||
        !Number.isSafeInteger(count) ||
        count <= 0
      )
        return null;
      counts[key as CollectionDiagnosticKey] = count;
    }
    return counts;
  } catch {
    return null;
  }
}
