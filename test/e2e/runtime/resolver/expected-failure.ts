// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Expected-failure matcher.
 *
 * Negative scenarios declare an `expected_failure` contract on their
 * expected state. The runner captures the failed setup's log plus a small
 * side-effect inventory (sandbox-created, gateway-started, credentials-written)
 * and asks this module whether the observation matches the contract.
 *
 * The contract has four parts:
 *   - phase: which setup stage produced the failure (informational; the
 *     runner is responsible for invoking the matcher only when that phase
 *     actually ran).
 *   - error_class: stable identifier for the failure mode.
 *   - message_pattern: regex applied to the captured log when present.
 *   - forbidden_side_effects: effects that MUST NOT be observed.
 *
 * Match result is structured (`ExpectedFailureReport`) so the runner can
 * write `expected-vs-actual.json` and surface a useful diff in CI.
 */

import { compileMessagePattern } from "./load.ts";
import type {
  ExpectedFailure,
  ExpectedFailurePhase,
  ExpectedFailureErrorClass,
  ExpectedFailureSideEffect,
} from "./schema.ts";

export interface ObservedFailure {
  /** Phase the runner attempted; matched against `expected_failure.phase`. */
  phase: ExpectedFailurePhase;
  /**
   * Structured reason if the runner could derive one (preferred). When
   * absent, matching falls back to log-content heuristics in the runner.
   */
  error_class?: ExpectedFailureErrorClass;
  /** Captured setup log; matched against `expected_failure.message_pattern`. */
  log: string;
  /**
   * Side effects the runner positively observed after the failure. Each
   * effect in `expected_failure.forbidden_side_effects` is checked against
   * this set; presence is a failure.
   */
  observed_side_effects: ExpectedFailureSideEffect[];
}

export interface ExpectedFailureCheck {
  name: "phase" | "error_class" | "message_pattern" | "forbidden_side_effects";
  ok: boolean;
  expected: string;
  actual: string;
  message?: string;
}

export interface ExpectedFailureReport {
  ok: boolean;
  expected: ExpectedFailure;
  observed: ObservedFailure;
  checks: ExpectedFailureCheck[];
}

export function matchExpectedFailure(
  expected: ExpectedFailure,
  observed: ObservedFailure,
): ExpectedFailureReport {
  const checks: ExpectedFailureCheck[] = [];

  const phaseOk = expected.phase === observed.phase;
  checks.push({
    name: "phase",
    ok: phaseOk,
    expected: expected.phase,
    actual: observed.phase,
    message: phaseOk
      ? undefined
      : `phase mismatch: expected '${expected.phase}' but observed '${observed.phase}'`,
  });

  if (observed.error_class !== undefined) {
    const classOk = expected.error_class === observed.error_class;
    checks.push({
      name: "error_class",
      ok: classOk,
      expected: expected.error_class,
      actual: observed.error_class,
      message: classOk
        ? undefined
        : `error_class mismatch: expected '${expected.error_class}' but observed '${observed.error_class}'`,
    });
  } else {
    // No structured class from the runner; defer to message_pattern as
    // the discriminator. Record a SKIPPED entry so the report makes it
    // obvious that the class was not asserted structurally.
    checks.push({
      name: "error_class",
      ok: true,
      expected: expected.error_class,
      actual: "<unobserved>",
      message: "skipped: runner did not derive a structured error_class",
    });
  }

  if (expected.message_pattern) {
    let regex: RegExp;
    try {
      regex = compileMessagePattern(expected.message_pattern);
    } catch (err) {
      checks.push({
        name: "message_pattern",
        ok: false,
        expected: expected.message_pattern,
        actual: "<invalid regex>",
        message: `message_pattern is not a valid regex: ${(err as Error).message}`,
      });
      return finalize(expected, observed, checks);
    }
    const ok = regex.test(observed.log);
    checks.push({
      name: "message_pattern",
      ok,
      expected: expected.message_pattern,
      actual: ok ? "<match>" : "<no match>",
      message: ok
        ? undefined
        : `message_pattern '${expected.message_pattern}' did not match captured log`,
    });
  }

  if (expected.forbidden_side_effects?.length) {
    const observedSet = new Set(observed.observed_side_effects);
    const found = expected.forbidden_side_effects.filter((e) => observedSet.has(e));
    const ok = found.length === 0;
    checks.push({
      name: "forbidden_side_effects",
      ok,
      expected: expected.forbidden_side_effects.join(","),
      actual: observed.observed_side_effects.join(",") || "<none>",
      message: ok
        ? undefined
        : `forbidden side effects observed after failure: ${found.join(", ")}`,
    });
  }

  return finalize(expected, observed, checks);
}

function finalize(
  expected: ExpectedFailure,
  observed: ObservedFailure,
  checks: ExpectedFailureCheck[],
): ExpectedFailureReport {
  return { ok: checks.every((c) => c.ok), expected, observed, checks };
}

export function formatExpectedFailureReport(report: ExpectedFailureReport): string {
  const lines: string[] = [];
  lines.push(`expected-failure: ${report.ok ? "OK" : "FAILED"}`);
  for (const c of report.checks) {
    const status = c.ok ? "PASS" : "FAIL";
    lines.push(`  ${status} ${c.name} expected=${c.expected} actual=${c.actual}`);
    if (c.message) lines.push(`       ${c.message}`);
  }
  return lines.join("\n");
}
