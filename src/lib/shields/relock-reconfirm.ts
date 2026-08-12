// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Shields transition confirmation helpers (#4663, #8304).
//
// `lockAgentConfig` chmod 444 / chown root:root the config files and verifies
// the on-disk state once — a single instantaneous snapshot. On DGX Station /
// DGX Spark an in-sandbox privileged reconciler (OpenClaw gateway / doctor-style
// perm normalization) re-permissions `.config-hash` in place *after* the
// verified lock returns, reverting it to 660 sandbox:sandbox. The content is
// untouched (the SHA-256 seal still matches), so only mode/owner drift and the
// next `shields status` reports UP (DRIFTED).
//
// `relockAndReconfirm` runs a bounded "lock -> settle -> re-confirm -> re-lock
// if drifted" cycle and only declares the lock UP when a re-confirmation passes
// after the reconciler has had a chance to settle.
//
// IMPORTANT — this NARROWS the race window, it does NOT close it. After the
// final re-confirm returns, the same reconciler can revert perms one settle
// window later (the TOCTOU is shifted, not eliminated). The only fully durable
// defense is the `chattr +i` immutable bit set inside `lockAgentConfig`, which
// is best-effort and may be unavailable (e.g. no CAP_LINUX_IMMUTABLE). This
// helper is a fail-closed mitigation: when the lock will not re-confirm within
// the retry budget, callers leave shields DOWN rather than report a stale UP.
// It is synchronous (uses the blocking `sleepMs`) so callers such as the
// auto-restore timer stay synchronous.

import { sleepMs } from "../core/wait";

export { waitForHermesInferenceRouteConvergence } from "./inference-convergence";

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_SETTLE_MS = 750;
const MIN_SETTLE_MS = 0;
const MAX_SETTLE_MS = 10_000;
const POLICY_ANSI_RE = /\x1b\[[0-9;]*m/g;

export interface PolicyCommandResult {
  status: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
}

export interface DeferredPermissivePolicyConfirmationOptions {
  proveNoRunningDirectSandbox: () => boolean;
  readPolicyReceipt: () => PolicyCommandResult;
  parsePolicy: (raw: string) => string;
}

function policyCommandOutput(result: PolicyCommandResult): string {
  return [result.stdout, result.stderr]
    .map((value) => String(value ?? ""))
    .filter(Boolean)
    .join("\n")
    .replace(POLICY_ANSI_RE, "");
}

/**
 * Confirm the one safe deferred-load case for a user-authorized Shields-down
 * transition. OpenShell may commit the relaxed policy but return nonzero when
 * a failed-startup sandbox has no running container to acknowledge loading it.
 * The caller must independently prove that exact stopped-container state; a
 * discovery error, live container, malformed receipt, or mismatch fails closed.
 */
export function confirmDeferredPermissivePolicyForStoppedSandbox(
  policySetResult: PolicyCommandResult,
  options: DeferredPermissivePolicyConfirmationOptions,
): boolean {
  const output = policyCommandOutput(policySetResult);
  const submissions = [
    ...output.matchAll(/^.*Policy version ([1-9]\d*) submitted \(hash: ([0-9a-f]{8,64})\)\s*$/gim),
  ];
  if (submissions.length !== 1) return false;
  const version = submissions[0]?.[1];
  const hash = submissions[0]?.[2]?.toLowerCase();
  if (!version || !hash) return false;
  const timeouts = output.match(
    new RegExp(`^.*Timeout waiting for policy version ${version} to load\\s*$`, "gim"),
  );
  if (timeouts?.length !== 1 || !options.proveNoRunningDirectSandbox()) return false;

  const receipt = options.readPolicyReceipt();
  if (receipt.status !== 0) return false;
  const receiptOutput = policyCommandOutput(receipt);
  const separator = /(?:^|\r?\n)---[ \t]*(?:\r?\n|$)/.exec(receiptOutput);
  if (!separator || !options.parsePolicy(receiptOutput)) return false;
  const header = receiptOutput.slice(0, separator.index);
  const versions = [...header.matchAll(/^\s*Version:\s*([1-9]\d*)\s*$/gim)];
  const hashes = [...header.matchAll(/^\s*Hash:\s*([0-9a-f]{8,64})\s*$/gim)];
  const statuses = [...header.matchAll(/^\s*Status:\s*(pending|active)\s*$/gim)];
  return (
    versions.length === 1 &&
    hashes.length === 1 &&
    statuses.length === 1 &&
    versions[0]?.[1] === version &&
    hashes[0]?.[1]?.toLowerCase() === hash
  );
}

/** Result of a single `lockAgentConfig` call: apply + verify. */
export interface LockResult {
  chattrApplied: boolean;
  fileHashes: { [path: string]: string };
}

/** A lock operation: applies the lock and verifies it, throwing on drift. */
export type LockFn = () => LockResult;

export interface RelockReconfirmOptions {
  /** Maximum number of lock -> settle -> re-confirm cycles. Default 3. */
  maxAttempts?: number;
  /** Override the settle window (ms) between apply and re-confirm. */
  settleMs?: number;
  /** Injectable synchronous sleep, for unit tests. Defaults to `sleepMs`. */
  sleep?: (ms: number) => void;
}

export interface RelockReconfirmResult {
  /** True only when a re-confirmation after the settle window succeeded. */
  ok: boolean;
  /** Number of full cycles attempted (1-based). */
  attempts: number;
  /** The re-confirmed lock result when `ok`, else null. */
  lastResult: LockResult | null;
  /** Failure message when `!ok`. */
  error?: string;
}

/**
 * Resolve the settle window (ms) between applying a lock and re-confirming it.
 *
 * Reads `NEMOCLAW_SHIELDS_SETTLE_MS`, defaulting to 750ms and clamping to
 * [0, 10000]. Returns 0 only under Vitest so suites don't incur real blocking
 * waits.
 */
export function resolveSettleMs(): number {
  // VITEST is the precise test signal (Vitest always sets it). Do NOT key off
  // NODE_ENV=test — the real settle window must apply in production regardless
  // of NODE_ENV, or the re-confirm wait would silently collapse to 0.
  if (process.env.VITEST === "true") {
    return 0;
  }
  const raw = process.env.NEMOCLAW_SHIELDS_SETTLE_MS;
  if (raw === undefined || raw === "") {
    return DEFAULT_SETTLE_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_SETTLE_MS;
  }
  return Math.min(MAX_SETTLE_MS, Math.max(MIN_SETTLE_MS, Math.trunc(parsed)));
}

/**
 * Apply a config lock and re-confirm it holds after a settle window, retrying
 * the whole cycle if an in-sandbox reconciler reverted perms during the wait.
 *
 * Each attempt:
 *   1. `lock()` — apply + verify. If this throws, fail immediately (the lock
 *      could not even be applied/verified once).
 *   2. `sleep(settleMs)` — give the gateway/reconciler time to settle.
 *   3. `lock()` — re-confirm. Success => re-confirmed, return ok. Throw => the
 *      reconciler reverted during the settle window; retry the whole cycle.
 *
 * Returns ok:false (fail closed) when attempts are exhausted or the first
 * apply of an attempt throws. NOTE: ok:true means the lock re-confirmed after
 * the settle window — it does not guarantee the perms cannot be reverted again
 * afterward (see the module header on the residual TOCTOU window).
 */
export function relockAndReconfirm(
  lock: LockFn,
  opts: RelockReconfirmOptions = {},
): RelockReconfirmResult {
  const maxAttempts =
    opts.maxAttempts !== undefined && opts.maxAttempts > 0
      ? opts.maxAttempts
      : DEFAULT_MAX_ATTEMPTS;
  const settleMs = opts.settleMs !== undefined ? opts.settleMs : resolveSettleMs();
  const sleep = opts.sleep ?? sleepMs;

  let lastError = "Config re-lock did not re-confirm after settle window";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Apply + verify. A failure here means the lock could not be established
    // even momentarily — there is nothing to settle, so fail immediately.
    try {
      lock();
    } catch (error: unknown) {
      return {
        ok: false,
        attempts: attempt,
        lastResult: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    // Let the in-sandbox reconciler settle, then re-confirm the lock held.
    sleep(settleMs);

    try {
      const confirmed = lock();
      return { ok: true, attempts: attempt, lastResult: confirmed };
    } catch (error: unknown) {
      // The reconciler reverted perms during the settle window. Retry the
      // whole cycle (re-apply, settle, re-confirm) up to maxAttempts.
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  return { ok: false, attempts: maxAttempts, lastResult: null, error: lastError };
}
