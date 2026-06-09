// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ProbeFn } from "./types.ts";

/**
 * Map of probe-ref name → probe runner. Shell-side AssertionStep
 * declarations carry an `implementation: { kind: "probe", ref: <name> }`.
 * The orchestrator calls `lookupProbe(ref)` at execution time; if it
 * returns undefined the step is reported skipped (or failed for
 * `required` probes).
 *
 * The registry is module-scoped state. Built-in probes are registered
 * by importing `./builtin.ts` (which calls registerProbe at module
 * load). Tests that need a clean slate can call `resetProbeRegistry()`.
 */
const probes = new Map<string, ProbeFn>();

/**
 * Register a probe implementation under `name`. Re-registering an
 * existing name throws — silently shadowing a probe is a contract
 * violation that hides behavior from the runner.
 */
export function registerProbe(name: string, fn: ProbeFn): void {
  if (!name) {
    throw new Error("registerProbe: name is required");
  }
  if (probes.has(name)) {
    throw new Error(`registerProbe: '${name}' already registered`);
  }
  probes.set(name, fn);
}

/**
 * Look up a registered probe. Returns undefined when the ref is not
 * registered; the caller (phase.ts) decides whether the missing probe
 * surfaces as skipped or failed based on AssertionStep.required.
 */
export function lookupProbe(name: string): ProbeFn | undefined {
  return probes.get(name);
}

/**
 * Names of every currently-registered probe. Useful in plan rendering
 * and tests that assert a build wired its expected probes.
 */
export function listRegisteredProbes(): readonly string[] {
  return Array.from(probes.keys()).sort();
}

/** Test-only: clear the registry so each test starts from empty. */
export function resetProbeRegistry(): void {
  probes.clear();
}
