// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { MessagingConflictProbe, MessagingConflictProbeGatewayDeps } from "./types";

/**
 * Build a tri-state `MessagingConflictProbe` from plain openshell runner deps.
 *
 * The liveness result is cached so the `sandbox list` call is issued at most
 * once per probe instance. A transient gateway failure (`checkGatewayLiveness`
 * returns false) causes all subsequent `providerExists` calls to return "error"
 * rather than "absent", preventing a flaky gateway from being mis-recorded as
 * "no providers" and permanently suppressing future backfill retries.
 */
export function createMessagingConflictProbe(
  deps: MessagingConflictProbeGatewayDeps,
): MessagingConflictProbe {
  let alive: boolean | null = null;
  return {
    providerExists: (name) => {
      if (alive === null) alive = deps.checkGatewayLiveness();
      if (!alive) return "error";
      return deps.providerExists(name) ? "present" : "absent";
    },
  };
}
