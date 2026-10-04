// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure classifiers for SSH probe outcomes into transport-level failures
 * (unreachable) vs application-level failures (reachable but exit-non-zero).
 *
 * A "transport-level" failure means the SSH tunnel itself could not carry
 * data — the process never reached a shell that could return a real exit
 * code. Typical shapes reported by `spawnSync("ssh", …)`:
 *
 *   - `error` set on the result (spawn-time failure: ENOENT, EACCES, …)
 *   - `status === 255` (ssh's own transport-error convention)
 *   - `status === null` with a signal (killed by SIGHUP/SIGPIPE from a
 *     dying gateway) or with no signal (timed out / SIGTERM)
 *
 * Callers use this to promote a sandbox-level `unreachable` flag so the
 * NEMOCLAW_SKIP_UNREACHABLE_SANDBOX_BACKUP=1 opt-in can activate. See #6188.
 */
export function isSshTransportFailure(result: {
  status: number | null;
  error?: Error;
  signal?: NodeJS.Signals | null;
}): boolean {
  if (result.error) return true;
  // Signal termination (e.g. SIGHUP/SIGPIPE from a dying gateway) reports
  // status=null; match connect.ts and treat these as transport-level
  // failures explicitly so the diagnostic path is unambiguous. Any other
  // null-status result (timeout, killed) is also transport-level.
  if (result.signal === "SIGHUP" || result.signal === "SIGPIPE") return true;
  if (result.status === null) return true;
  return result.status === 255;
}
