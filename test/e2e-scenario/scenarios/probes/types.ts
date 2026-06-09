// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { TransientClassifier } from "../types.ts";

/**
 * Context handed to a probe runner. Mirrors the subset of scenario
 * state that shell steps already get via `${E2E_CONTEXT_DIR}/context.env`,
 * but typed so probe implementations don't have to parse the file
 * themselves.
 *
 * The orchestrator builds this before invoking the probe; probe code
 * must NOT mutate `contextEnv` (treat as read-only).
 */
export interface ProbeContext {
  /** Repo-relative or absolute path to .e2e/.. context root. */
  contextDir: string;
  /** Absolute path to the evidence file the probe SHOULD write. */
  evidencePath: string;
  /** Parsed key/value pairs from ${contextDir}/context.env. */
  contextEnv: Readonly<Record<string, string>>;
  /** Convenience accessor for the most-used keys. Null when missing. */
  sandboxName: string | null;
  gatewayUrl: string | null;
  /** Repo root, so probes that shell out have a canonical cwd. */
  repoRoot: string;
}

/**
 * Structured probe result. Mirrors AssertionStep StepAttemptOutcome
 * in `phase.ts` so the orchestrator can adopt it without translation.
 *
 * Probes MUST emit a structured outcome — never throw out of the
 * registered function. Throwing is a contract violation that the
 * orchestrator surfaces as a failed assertion with the error message,
 * but a well-behaved probe converts thrown errors into a `failed`
 * outcome with a redacted message.
 */
export interface ProbeOutcome {
  status: "passed" | "failed" | "skipped";
  message?: string;
  classifier?: TransientClassifier;
  /**
   * Optional override for the evidence path. If omitted the orchestrator
   * uses `step.evidencePath` (which the probe was already told via
   * ProbeContext.evidencePath).
   */
  evidence?: string;
}

/**
 * The function shape every registered probe implements.
 *
 * Convention:
 *   - Probes are async even when they could be sync, so the registry
 *     can swap an implementation for a slow IO-bound version without
 *     ripple effects through the orchestrator.
 *   - Probes write structured evidence (JSON) to ProbeContext.evidencePath
 *     so failures are diagnosable from the artifact bundle.
 */
export type ProbeFn = (ctx: ProbeContext) => Promise<ProbeOutcome>;
