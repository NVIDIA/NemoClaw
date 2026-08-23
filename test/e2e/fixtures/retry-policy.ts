// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type RetryFailureClass =
  | "authentication"
  | "authorization"
  | "cleanup"
  | "deterministic"
  | "malformed-input"
  | "policy-denial"
  | "transient-external"
  | "ambiguous-mutation";

export type RetryIdempotence = "read-only" | "idempotent" | "reconciled-mutation";

export interface RetryAttemptEvidence {
  attempt: number;
  outcome: "failed" | "passed";
  failureClass?: RetryFailureClass;
  reconciled?: boolean;
  retryScheduled: boolean;
}

export interface RetryEvidence {
  schemaVersion: 1;
  operation: string;
  owner: string;
  idempotence: RetryIdempotence;
  maxAttempts: number;
  outcome: "failed-no-retry" | "exhausted" | "passed-after-retry" | "passed-first-attempt";
  attempts: RetryAttemptEvidence[];
}

export class RetryPolicyError extends Error {
  constructor(
    message: string,
    readonly evidence: RetryEvidence,
  ) {
    super(message);
  }
}

type AttemptClassification =
  | { outcome: "passed" }
  | { outcome: "failed"; failureClass: RetryFailureClass };

export interface BoundedRetryOptions<T> {
  operation: string;
  owner: string;
  idempotence: RetryIdempotence;
  maxAttempts: number;
  run: (attempt: number) => Promise<T>;
  classify: (value: T | undefined, error: unknown) => AttemptClassification;
  reconcile?: (value: T | undefined, error: unknown, attempt: number) => Promise<boolean>;
  delayMs?: number | ((attempt: number) => number);
  sleep?: (milliseconds: number) => Promise<void>;
  onEvidence?: (evidence: RetryEvidence) => Promise<void> | void;
}

export type BoundedRetryResult<T> =
  | { outcome: "passed"; value: T; evidence: RetryEvidence }
  | { outcome: "failed"; value: T | undefined; evidence: RetryEvidence };

/** Reject unbounded or artifact-unsafe retry metadata before an operation runs. */
function validateOptions<T>(options: BoundedRetryOptions<T>): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(options.operation)) {
    throw new Error("retry operation must be a bounded identifier");
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(options.owner)) {
    throw new Error("retry owner must be a bounded identifier");
  }
  if (
    !Number.isSafeInteger(options.maxAttempts) ||
    options.maxAttempts < 1 ||
    options.maxAttempts > 10
  ) {
    throw new Error("retry maxAttempts must be between 1 and 10");
  }
}

/** Build an immutable aggregate record from the retained per-attempt facts. */
function finalEvidence(
  options: Pick<
    BoundedRetryOptions<unknown>,
    "operation" | "owner" | "idempotence" | "maxAttempts"
  >,
  attempts: RetryAttemptEvidence[],
  outcome: RetryEvidence["outcome"],
): RetryEvidence {
  return {
    schemaVersion: 1,
    operation: options.operation,
    owner: options.owner,
    idempotence: options.idempotence,
    maxAttempts: options.maxAttempts,
    outcome,
    attempts: attempts.map((attempt) => ({ ...attempt })),
  };
}

/** Publish final evidence through the caller-owned artifact boundary. */
async function emit(
  options: Pick<BoundedRetryOptions<unknown>, "onEvidence">,
  evidence: RetryEvidence,
): Promise<void> {
  await options.onEvidence?.(evidence);
}

/**
 * Execute an operation with a bounded, fail-closed retry policy.
 *
 * Only externally transient failures are retryable. Mutations additionally
 * require a successful reconciliation before another attempt is authorized.
 * Evidence deliberately contains no command output, exception text, or request
 * data, so credential-bearing values cannot enter retained retry artifacts.
 *
 * A resolved operation returns a discriminated pass or failure result. A
 * thrown operation raises `RetryPolicyError` with the same evidence.
 */
export async function runBoundedRetry<T>(
  options: BoundedRetryOptions<T>,
): Promise<BoundedRetryResult<T>> {
  validateOptions(options);
  const sleep =
    options.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const attempts: RetryAttemptEvidence[] = [];

  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    let value: T | undefined;
    let error: unknown;
    try {
      value = await options.run(attempt);
    } catch (caught) {
      error = caught;
    }

    const classification = options.classify(value, error);
    if (classification.outcome === "passed") {
      if (error !== undefined) throw new Error("retry classifier reported success after an error");
      if (value === undefined) throw new Error("retry classifier reported success without a value");
      attempts.push({ attempt, outcome: "passed", retryScheduled: false });
      const evidence = finalEvidence(
        options,
        attempts,
        attempt === 1 ? "passed-first-attempt" : "passed-after-retry",
      );
      await emit(options, evidence);
      return { outcome: "passed", value, evidence };
    }

    const isTransient = classification.failureClass === "transient-external";
    const hasBudget = attempt < options.maxAttempts;
    let reconciled = options.idempotence !== "reconciled-mutation";
    if (isTransient && hasBudget && options.idempotence === "reconciled-mutation") {
      reconciled = (await options.reconcile?.(value, error, attempt)) === true;
    }
    const retryScheduled = isTransient && hasBudget && reconciled;
    attempts.push({
      attempt,
      outcome: "failed",
      failureClass: classification.failureClass,
      ...(options.idempotence === "reconciled-mutation" && isTransient && hasBudget
        ? { reconciled }
        : {}),
      retryScheduled,
    });

    if (retryScheduled) {
      const delay =
        typeof options.delayMs === "function" ? options.delayMs(attempt) : (options.delayMs ?? 0);
      if (!Number.isSafeInteger(delay) || delay < 0 || delay > 300_000) {
        throw new Error("retry delay must be between 0 and 300000 milliseconds");
      }
      if (delay > 0) await sleep(delay);
      continue;
    }

    const exhaustedCleanup =
      classification.failureClass === "cleanup" &&
      !hasBudget &&
      attempts.some((previous) => previous.retryScheduled);
    const outcome =
      (isTransient && !hasBudget) || exhaustedCleanup ? "exhausted" : "failed-no-retry";
    const evidence = finalEvidence(options, attempts, outcome);
    await emit(options, evidence);
    if (error !== undefined) {
      throw new RetryPolicyError(`${options.operation} ${outcome}`, evidence);
    }
    return { outcome: "failed", value, evidence };
  }

  throw new Error("bounded retry loop completed without an attempt");
}
