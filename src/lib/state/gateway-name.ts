// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as registry from "./registry";

import {
  NAME_ALLOWED_FORMAT,
  NAME_MAX_LENGTH,
  NAME_VALID_PATTERN,
} from "../name-validation";

/**
 * NemoClaw's OpenShell gateway name resolver.
 *
 * NemoClaw currently runs a singleton gateway: every onboard uses the literal
 * `"nemoclaw"` name regardless of which port the gateway binds to. That
 * invariant makes concurrent NemoClaw instances on a single host impossible
 * — changing the gateway port relocates the singleton instead of spawning a
 * second instance.
 *
 * This module owns the canonical name, exposes a `port`-aware resolver so
 * follow-up work can derive per-port names (e.g. `"nemoclaw-8081"`) without
 * touching every call site again, validates persisted gateway names at the
 * registry boundary, and exposes a sandbox-scoped accessor with legacy and
 * defense-in-depth fallbacks. Until the per-port flip lands,
 * `getGatewayName` returns the singleton name for every port.
 */

export const DEFAULT_GATEWAY_NAME = "nemoclaw";

export function getGatewayName(_port: number): string {
  return DEFAULT_GATEWAY_NAME;
}

/**
 * Validate a persisted `gatewayName` against the same RFC 1123-derived rules
 * as sandbox/instance names. Throws when the value is empty, too long, or
 * uses disallowed characters. Used both at the registry write boundary and
 * by {@link getSandboxGatewayName} as a defense-in-depth read-side check.
 */
export function validateGatewayName(value: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`gatewayName is required. Allowed format: ${NAME_ALLOWED_FORMAT}.`);
  }
  if (value.length > NAME_MAX_LENGTH) {
    throw new Error(
      `gatewayName too long (max ${NAME_MAX_LENGTH} chars). Allowed format: ${NAME_ALLOWED_FORMAT}.`,
    );
  }
  if (!NAME_VALID_PATTERN.test(value)) {
    throw new Error(`Invalid gatewayName: '${value}'. Allowed format: ${NAME_ALLOWED_FORMAT}.`);
  }
}

/**
 * Resolve the OpenShell gateway name a sandbox is bound to. Returns `null`
 * for unknown sandboxes (so callers cannot transitively act on the singleton
 * with a stale or mistyped name) and for entries whose persisted value fails
 * validation (defense-in-depth against corrupt on-disk state). For sandboxes
 * that exist but predate the `gatewayName` field, falls back to
 * {@link DEFAULT_GATEWAY_NAME} as a legacy backfill. All diagnostics are
 * written to `stderr` via `console.warn` so JSON / non-interactive callers
 * keep stdout clean.
 *
 * Removal boundary: the legacy-backfill branch (and the matching reuse-time
 * backfill in `updateReusedSandboxMetadata`) exists so registries written
 * before per-sandbox gateway tracking remain usable. Both fallbacks can be
 * dropped once `getGatewayName(port)` returns a per-port name AND every
 * on-disk registry has been migrated through at least one `nemoclaw onboard`
 * — fresh registrations now write `gatewayName` and the reuse path migrates
 * legacy entries on first touch. A future PR that introduces a registry
 * schema version field is the recommended trigger for that cleanup.
 */
export function getSandboxGatewayName(name: string): string | null {
  const entry = registry.getSandbox(name);
  if (!entry) {
    console.warn(`  Gateway-name lookup for unknown sandbox '${name}' returned null.`);
    return null;
  }
  if (entry.gatewayName === undefined) {
    console.warn(
      `  Sandbox '${name}' has no recorded gatewayName; using '${DEFAULT_GATEWAY_NAME}' from the singleton default.`,
    );
    return DEFAULT_GATEWAY_NAME;
  }
  try {
    validateGatewayName(entry.gatewayName);
    return entry.gatewayName;
  } catch {
    console.warn(
      `  Sandbox '${name}' has an invalid recorded gatewayName; returning null.`,
    );
    return null;
  }
}
