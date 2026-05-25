// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { OPENSHELL_PROBE_TIMEOUT_MS } from "../adapters/openshell/timeouts";

import { getOccupiedPorts } from "./dashboard-port";

export type ForwardStopRunner = (
  args: string[],
  opts: { ignoreError?: boolean; suppressOutput?: boolean },
) => unknown;

export type ForwardListRunner = (
  args: string[],
  opts: { ignoreError?: boolean; timeout?: number },
) => string;

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
): "stopped" | "owned-other" | "no-entry" | "list-failed" {
  // Let runCaptureOpenshell throw on failure/timeout so the catch branch
  // returns "list-failed". With ignoreError: true the runner would swallow
  // the error and return "", which getOccupiedPorts parses as an empty map
  // and the "no-entry" branch below would still run the stop — exactly the
  // collateral-damage case this helper exists to avoid.
  let listOutput = "";
  try {
    listOutput = runCaptureOpenshell(["forward", "list"], {
      timeout: OPENSHELL_PROBE_TIMEOUT_MS,
    });
  } catch {
    return "list-failed";
  }
  const owner = getOccupiedPorts(listOutput).get(String(port)) ?? null;
  if (owner && owner !== sandboxName) {
    return "owned-other";
  }
  runOpenshell(["forward", "stop", String(port), sandboxName], {
    ignoreError: true,
    suppressOutput: true,
  });
  return owner === sandboxName ? "stopped" : "no-entry";
}
