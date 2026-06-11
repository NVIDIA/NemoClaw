// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * NemoClaw instance identity primitive.
 *
 * Historically NemoClaw treated the host-side installation as a process-global
 * singleton: one gateway named `nemoclaw`, one state root at `~/.nemoclaw`, one
 * registry/credentials/snapshot tree. Two NemoClaw-managed sandboxes on the
 * same host therefore had to share that tree even when the user wanted full
 * segregation (billing isolation, A/B model testing, multi-tenant POCs).
 *
 * `NEMOCLAW_INSTANCE` makes the instance identity configurable. The fallback
 * chain has two layers:
 *
 *   1. When `NEMOCLAW_INSTANCE` is unset or empty, the default instance is
 *      selected, every existing on-disk path resolves to `~/.nemoclaw`, and
 *      the gateway name stays at the bare `nemoclaw` — single-instance
 *      deployments observe no change after upgrading.
 *   2. With the default instance still selected, a non-default
 *      `NEMOCLAW_GATEWAY_PORT` produces a `nemoclaw-<port>` gateway that
 *      segregates from the bare default at the gateway-binding layer alone.
 *      This port-derived form is the implicit fallback identity when the
 *      bare `nemoclaw` gateway is already occupied.
 *
 * Setting `NEMOCLAW_INSTANCE` to a non-default value overrides both layers
 * with a named instance: the state root, credentials directory,
 * rebuild-backups directory, local-adapter state directory, and gateway name
 * all gain an `<instance>` suffix so the migrated surfaces stay segregated.
 *
 * Scope of segregation in this groundwork: NemoClaw home directory, gateway
 * binding (name, state dir, compat container), credentials store, rebuild
 * backups, and local inference adapter state. Out of scope here and tracked
 * as follow-up: the sandbox registry, onboard session state, messaging
 * configuration, snapshot trees, and any module that still reads
 * `~/.nemoclaw` directly. Callers that have not yet migrated to
 * `resolveNemoclawHomeDir()` still share state across instances.
 *
 * This module is the single source of truth for resolving the active instance
 * name; downstream callers thread the resolved value through their own paths
 * rather than parsing the env var directly.
 */

/** Reserved name representing today's singleton behaviour. */
export const DEFAULT_NEMOCLAW_INSTANCE = "default";

/**
 * Lower-case alphanumeric slug with internal `-`. Must start and end with an
 * alphanumeric so it composes safely into filesystem names, gateway-name
 * strings, and container names.
 */
const INSTANCE_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/**
 * Pure-digit hyphen-separated segments are rejected so the instance name can
 * never collide with the `-<port>` suffix appended by the gateway-name
 * resolver. Without this rule, `NEMOCLAW_INSTANCE=agent-a NEMOCLAW_GATEWAY_PORT=8081`
 * and `NEMOCLAW_INSTANCE=agent-a-8081` (default port) would both compose
 * `nemoclaw-agent-a-8081` and overwrite each other's gateway state.
 */
function hasNumericSegment(name: string): boolean {
  return name.split("-").some((segment) => /^\d+$/.test(segment));
}

/**
 * Validate an instance-name candidate. Returns the trimmed lower-case name if
 * valid, or throws with a stable error message that callers can surface to the
 * user verbatim. Empty input resolves to {@link DEFAULT_NEMOCLAW_INSTANCE} so
 * `NEMOCLAW_INSTANCE=""` and an unset variable behave the same.
 */
export function parseInstanceName(envVar: string, fallback: string): string {
  const raw = process.env[envVar];
  if (raw === undefined || raw === "") return fallback;
  const trimmed = String(raw).trim().toLowerCase();
  if (trimmed === "") return fallback;
  if (!INSTANCE_NAME_RE.test(trimmed)) {
    throw new Error(
      `Invalid instance name: ${envVar}="${raw}" — must be 1–32 lower-case ` +
        `alphanumerics with internal '-' (e.g. "agent-a", "tenant1")`,
    );
  }
  if (hasNumericSegment(trimmed)) {
    throw new Error(
      `Invalid instance name: ${envVar}="${raw}" — hyphen-separated segments ` +
        `may not be purely numeric (would collide with the gateway port suffix)`,
    );
  }
  return trimmed;
}

/** Whether the supplied instance name refers to today's singleton tree. */
export function isDefaultInstance(name: string): boolean {
  return name === DEFAULT_NEMOCLAW_INSTANCE;
}

/**
 * Active NemoClaw instance name resolved at module load. Read from
 * `NEMOCLAW_INSTANCE`; falls back to {@link DEFAULT_NEMOCLAW_INSTANCE}.
 *
 * Callers needing test-time overrides should call {@link parseInstanceName}
 * directly against an explicit env-var name rather than re-reading this
 * constant, since this value is captured once per process.
 */
export const NEMOCLAW_INSTANCE = parseInstanceName("NEMOCLAW_INSTANCE", DEFAULT_NEMOCLAW_INSTANCE);
