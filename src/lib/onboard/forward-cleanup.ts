// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { OPENSHELL_PROBE_TIMEOUT_MS } from "../adapters/openshell/timeouts";
import { waitUntil } from "../core/wait";

import { getOccupiedPorts } from "./dashboard-port";

const FORWARD_RELEASE_TIMEOUT_MS = 5_000;
const FORWARD_RELEASE_POLL_MS = 250;
const FORWARD_RECOVERY_INITIAL_POLL_MS = 100;
const FORWARD_RECOVERY_MAX_POLL_MS = 500;
const FORWARD_RECOVERY_BACKOFF_FACTOR = 1.5;

export type ForwardStopRunner = (
  args: string[],
  opts: { ignoreError?: boolean; suppressOutput?: boolean },
) => unknown;

/**
 * Returns the serialized forward list on success. An empty string means the
 * list query succeeded with no entries; `null` means ownership is unknown
 * because the query did not return a result.
 */
export type ForwardListRunner = (
  args: string[],
  opts: { ignoreError?: boolean; timeout?: number },
) => string | null;

/**
 * Wait for a stopped forward's host listener to retire before its fixed port
 * is reused. OpenShell can remove forward metadata before the underlying SSH
 * process releases the listener, so both onboarding and runtime teardown use
 * this single bounded release policy.
 */
export function waitForStoppedForwardPortRelease(
  port: number,
  isPortBound: (port: number) => boolean,
  options: { sleep?: (milliseconds: number) => void } = {},
): boolean {
  return waitUntil(() => !isPortBound(port), {
    initialIntervalMs: FORWARD_RELEASE_POLL_MS,
    maxIntervalMs: FORWARD_RELEASE_POLL_MS,
    backoffFactor: 1,
    maxAttempts: Math.ceil(FORWARD_RELEASE_TIMEOUT_MS / FORWARD_RELEASE_POLL_MS) + 1,
    sleep: options.sleep,
  });
}

/** Poll a forward ownership/readiness condition within its configured recovery budget. */
export function waitForForwardRecoveryState(condition: () => boolean, budgetMs: number): boolean {
  return waitUntil(condition, {
    deadlineMs: Date.now() + budgetMs,
    initialIntervalMs: FORWARD_RECOVERY_INITIAL_POLL_MS,
    maxIntervalMs: FORWARD_RECOVERY_MAX_POLL_MS,
    backoffFactor: FORWARD_RECOVERY_BACKOFF_FACTOR,
  });
}

/**
 * `openshell forward stop <port>` — port-scoped, kills whatever forward is
 * currently bound to that port. Use only when the caller has no sandbox
 * context (or is intentionally targeting any owner — e.g. wholesale
 * dashboard-port reclaim during recovery). Sandbox-aware call sites should
 * prefer `bestEffortForwardStopForSandbox`, which uses the sandbox-scoped
 * `forward stop <port> <sandbox>` form so the kill cannot collateral
 * another sandbox's forward in a TOCTOU window.
 */
export function bestEffortForwardStop(
  runOpenshell: ForwardStopRunner,
  port: string | number,
): void {
  runOpenshell(["forward", "stop", String(port)], {
    ignoreError: true,
    suppressOutput: true,
  });
}

/**
 * Stop the forward on `port` only when `openshell forward list` reports it
 * is owned by `sandboxName` (or unowned). When the list query fails the
 * stop is skipped — without ownership data we cannot tell whether port
 * belongs to a concurrent onboard / connect on a different sandbox, so the
 * safe choice is to leave the port alone and let the helper's retry path
 * (or the next forward list poll once the gateway is responsive) sort
 * itself out.
 *
 * The stop itself uses the sandbox-scoped `forward stop <port> <sandbox>`
 * form so a TOCTOU window between list and stop cannot accidentally kill
 * another sandbox's forward that bound to the same port in the meantime.
 *
 * Returns:
 *   - "stopped"       — entry matched sandboxName and the stop ran.
 *   - "owned-other"   — entry exists for a different sandbox; stop skipped.
 *   - "no-entry"      — no live entry for that port; stop ran defensively
 *                       (sandbox-scoped, so a concurrent racer's forward
 *                       that may have bound the port between list and stop
 *                       is left alone).
 *   - "list-failed"   — could not enumerate forwards; stop SKIPPED. The
 *                       owner is unknown and the port-only `forward stop`
 *                       could kill an unrelated sandbox's forward.
 */
export function bestEffortForwardStopForSandbox(
  runOpenshell: ForwardStopRunner,
  runCaptureOpenshell: ForwardListRunner,
  port: string | number,
  sandboxName: string,
  beforeStop?: () => void,
): "stopped" | "owned-other" | "no-entry" | "list-failed" {
  // A runner reports failure either by throwing or by returning null; both
  // mean "list-failed" here. Do not pass either result to getOccupiedPorts,
  // which parses an empty string into an empty map, so the "no-entry" branch
  // below would still run the stop against this sandbox's own live forward
  // without any ownership evidence. A runner that ignores the command failure
  // itself must convert it to null, never to an empty string, which is
  // indistinguishable from a genuinely empty forward list.
  let listOutput: string | null = null;
  try {
    listOutput = runCaptureOpenshell(["forward", "list"], {
      timeout: OPENSHELL_PROBE_TIMEOUT_MS,
    });
  } catch {
    return "list-failed";
  }
  if (listOutput === null) {
    return "list-failed";
  }
  const owner = getOccupiedPorts(listOutput).get(String(port)) ?? null;
  if (owner && owner !== sandboxName) {
    return "owned-other";
  }
  beforeStop?.();
  runOpenshell(["forward", "stop", String(port), sandboxName], {
    ignoreError: true,
    suppressOutput: true,
  });
  return owner === sandboxName ? "stopped" : "no-entry";
}
