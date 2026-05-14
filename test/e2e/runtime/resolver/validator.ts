// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Expected-state validator.
 *
 * Walks the expected state tree and compares each leaf to a probe result.
 * Also validates per-suite `requires_state` entries at runtime, producing a
 * single report whose `ok` field drives whether the runner proceeds to
 * execute suites.
 */

import type { ExpectedStateConfig, ResolvedSuite } from "./schema.ts";

export type ProbeValue = string | number | boolean | null;
export type ProbeResults = Record<string, ProbeValue>;

export interface ValidatorInput {
  stateId: string;
  state: ExpectedStateConfig;
  probes: ProbeResults;
  suites: ResolvedSuite[];
}

export interface ValidatorCheck {
  key: string;
  expected: ProbeValue;
  actual: ProbeValue | undefined;
  ok: boolean;
  origin: "state" | "suite";
  suite?: string;
  message?: string;
}

export interface ValidatorReport {
  state_id: string;
  ok: boolean;
  checks: ValidatorCheck[];
}

function flatten(
  obj: unknown,
  prefix: string,
  out: Record<string, ProbeValue>,
): void {
  if (obj === null || typeof obj !== "object") {
    out[prefix] = obj as ProbeValue;
    return;
  }
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const next = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      flatten(v, next, out);
    } else {
      out[next] = v as ProbeValue;
    }
  }
}

function compare(
  key: string,
  expected: ProbeValue,
  actual: ProbeValue | undefined,
): boolean {
  if (actual === undefined) return false;
  return expected === actual;
}

export function validateExpectedState(input: ValidatorInput): ValidatorReport {
  const checks: ValidatorCheck[] = [];
  const flat: Record<string, ProbeValue> = {};
  flatten(input.state, "", flat);

  for (const [key, expected] of Object.entries(flat)) {
    const actual = input.probes[key];
    const ok = compare(key, expected, actual);
    checks.push({
      key,
      expected,
      actual,
      ok,
      origin: "state",
      message: ok
        ? undefined
        : `expected '${key}=${String(expected)}' but got '${String(actual ?? "<missing>")}'`,
    });
  }

  for (const suite of input.suites) {
    const req = suite.requires_state ?? {};
    for (const [key, expected] of Object.entries(req)) {
      const actual = input.probes[key];
      const ok = compare(key, expected as ProbeValue, actual);
      checks.push({
        key,
        expected: expected as ProbeValue,
        actual,
        ok,
        origin: "suite",
        suite: suite.id,
        message: ok
          ? undefined
          : `suite '${suite.id}' requires '${key}=${String(expected)}' but got '${String(actual ?? "<missing>")}'`,
      });
    }
  }

  const ok = checks.every((c) => c.ok);
  return { state_id: input.stateId, ok, checks };
}

export function formatReport(report: ValidatorReport): string {
  const lines: string[] = [];
  lines.push(`expected-state: ${report.state_id} ${report.ok ? "OK" : "FAILED"}`);
  for (const c of report.checks) {
    const status = c.ok ? "PASS" : "FAIL";
    const origin = c.origin === "suite" ? `[suite:${c.suite}]` : "[state]";
    lines.push(
      `  ${status} ${origin} ${c.key} expected=${String(c.expected)} actual=${String(c.actual ?? "<missing>")}`,
    );
  }
  return lines.join("\n");
}
