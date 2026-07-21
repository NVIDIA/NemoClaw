// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Advisory, AdvisoryCheck, AdvisoryPhase } from "./types";

/** Selection, resume, cache, and presentation controls for one run. */
export interface RunAdvisoriesOptions {
  phase?: AdvisoryPhase | readonly AdvisoryPhase[];
  resuming?: boolean;
  suppressed?: Iterable<string>;
  cachedResults?: ReadonlyMap<string, Advisory | null>;
}

/** Structured output used to persist safe results across resume boundaries. */
export interface AdvisoryRunResult {
  advisories: readonly Advisory[];
  results: ReadonlyMap<string, Advisory | null>;
  executedCheckIds: readonly string[];
  reusedCheckIds: readonly string[];
}

function canSuppress(advisory: Advisory): boolean {
  return advisory.severity !== "fatal" && advisory.severity !== "blocking";
}

function phaseSet(phase: RunAdvisoriesOptions["phase"]): ReadonlySet<AdvisoryPhase> | null {
  if (!phase) return null;
  return new Set(Array.isArray(phase) ? phase : [phase]);
}

function assertAdvisoryMatchesCheck<Context>(
  check: AdvisoryCheck<Context>,
  advisory: Advisory,
): void {
  const mismatches: string[] = [];
  if (advisory.id !== check.id) mismatches.push(`id '${advisory.id}'`);
  if (advisory.phase !== check.phase) mismatches.push(`phase '${advisory.phase}'`);
  if (advisory.severity !== check.severity) mismatches.push(`severity '${advisory.severity}'`);
  if (advisory.resumeSafe !== check.resumeSafe) {
    mismatches.push(`resumeSafe '${String(advisory.resumeSafe)}'`);
  }
  if (mismatches.length > 0) {
    throw new Error(
      `Advisory check '${check.id}' returned mismatched metadata: ${mismatches.join(", ")}.`,
    );
  }
}

/**
 * Runs checks in registry order. During resume, cached results are reused only
 * for checks that explicitly declare their prior verdict safe to reuse.
 */
export function runAdvisories<Context>(
  checks: readonly AdvisoryCheck<Context>[],
  context: Context,
  options: RunAdvisoriesOptions = {},
): AdvisoryRunResult {
  const phases = phaseSet(options.phase);
  const suppressed = new Set(options.suppressed ?? []);
  const results = new Map<string, Advisory | null>();
  const advisories: Advisory[] = [];
  const executedCheckIds: string[] = [];
  const reusedCheckIds: string[] = [];
  const seenIds = new Set<string>();

  for (const check of checks) {
    if (seenIds.has(check.id)) {
      throw new Error(`Duplicate advisory check id '${check.id}'.`);
    }
    seenIds.add(check.id);

    if (phases && !phases.has(check.phase)) continue;
    if (check.skipIf?.(context)) {
      results.set(check.id, null);
      continue;
    }

    const canReuse =
      options.resuming === true &&
      check.resumeSafe &&
      options.cachedResults?.has(check.id) === true;
    const advisory = canReuse
      ? (options.cachedResults?.get(check.id) ?? null)
      : check.check(context);

    if (canReuse) reusedCheckIds.push(check.id);
    else executedCheckIds.push(check.id);

    if (advisory) assertAdvisoryMatchesCheck(check, advisory);
    results.set(check.id, advisory);
    if (advisory && (!suppressed.has(advisory.id) || !canSuppress(advisory))) {
      advisories.push(advisory);
    }
  }

  return {
    advisories: Object.freeze(advisories),
    results,
    executedCheckIds: Object.freeze(executedCheckIds),
    reusedCheckIds: Object.freeze(reusedCheckIds),
  };
}
