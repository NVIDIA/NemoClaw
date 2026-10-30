// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isLoopbackHostname } from "../core/url-utils.ts";

/** Classify a validated dashboard URL with the repository-wide loopback policy. */
export function isLoopbackDashboardUrl(value: string): boolean {
  return isLoopbackHostname(new URL(value).hostname);
}

/** Rebind a loopback dashboard URL without changing a proxy-owned external URL. */
export function rebindLoopbackDashboardUrlPort(value: string, port: number): string {
  if (!isLoopbackDashboardUrl(value)) return value;
  const parsed = new URL(value);
  parsed.port = String(port);
  return parsed.toString();
}

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

/**
 * A persistable external dashboard URL must be an absolute http(s) URL with a
 * host and no embedded credentials, matching what onboarding derives from
 * `CHAT_UI_URL`. This is the single source of truth shared by the writer
 * (`resolveExternalDashboardUrl`) and the registry read-side validator so a
 * value that persists can always be read back (#11439). Userinfo is rejected so
 * an operator-facing address is never a secret; control characters and
 * unbounded length are rejected as registry-hardening.
 */
export function isValidDashboardExternalUrl(value: string): boolean {
  if (value.length === 0 || value.length > 2048 || CONTROL_CHARACTER.test(value)) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return (
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    parsed.hostname.length > 0 &&
    parsed.username === "" &&
    parsed.password === ""
  );
}

/**
 * Resolve the external dashboard URL to persist from the operator's
 * `CHAT_UI_URL`, rebinding its port to the effective dashboard port. Returns
 * null when no external origin is configured, the origin is loopback, or the
 * value is not a valid persistable external origin. Shared by the fresh-create,
 * reuse/resume, and OpenClaw-forward persistence paths so all record the same
 * value (#11439).
 */
export function resolveExternalDashboardUrlForPort(
  chatUiUrlEnv: string | null | undefined,
  effectivePort: number,
): string | null {
  if (!chatUiUrlEnv) return null;
  const normalized = chatUiUrlEnv.includes("://") ? chatUiUrlEnv : `http://${chatUiUrlEnv}`;
  let rebound: string;
  try {
    const parsed = new URL(normalized);
    parsed.port = String(effectivePort);
    rebound = parsed.toString();
  } catch {
    return null;
  }
  return resolveExternalDashboardUrl(rebound);
}

/**
 * Return the browser-facing external dashboard URL to persist for a sandbox, or
 * null when the resolved dashboard URL is a plain loopback address or is not a
 * valid persistable external origin. A loopback URL adds nothing over the
 * persisted `dashboardPort`, so only a genuine external origin (e.g. the HTTPS
 * reverse proxy behind `CHAT_UI_URL`) is worth recording so `status`,
 * `dashboard-url`, and `list` can report it later (#11439). The value is
 * validated with the same predicate the registry read-side enforces, so a
 * persisted value can always be read back. Malformed or non-http(s) input
 * yields null.
 */
export function resolveExternalDashboardUrl(chatUiUrl: string | null | undefined): string | null {
  if (!chatUiUrl) return null;
  const normalized = chatUiUrl.replace(/\/$/, "");
  if (!isValidDashboardExternalUrl(normalized)) return null;
  try {
    if (isLoopbackDashboardUrl(normalized)) return null;
  } catch {
    return null;
  }
  return normalized;
}

/**
 * Resolve the dashboard URL that a rebuild replays for a sandbox (#13177).
 *
 * The registry's `dashboardExternalUrl` is the authoritative record:
 * `undefined` means onboarding never recorded one, so `fallbackUrl` (the
 * previous startup profile's URL) applies; `null` means onboarding cleared it.
 * The resolved external origin is rebound to the replacement's dashboard port.
 * Without an external origin, the loopback URL for that port is returned.
 */
export function resolveRecordedDashboardUrlForPort(input: {
  readonly recordedExternalUrl: string | null | undefined;
  readonly fallbackUrl?: string | null;
  readonly port: number;
}): string {
  const recorded =
    input.recordedExternalUrl === undefined ? input.fallbackUrl : input.recordedExternalUrl;
  return (
    resolveExternalDashboardUrlForPort(recorded, input.port) ??
    `http://127.0.0.1:${String(input.port)}`
  );
}

/** Environment variable for extra OpenClaw dashboard browser origins (#13177). */
export const DASHBOARD_ORIGINS_ENV = "NEMOCLAW_DASHBOARD_ORIGINS";

/** Maximum number of extra dashboard origins one sandbox may record. */
export const MAX_DASHBOARD_ORIGINS = 16;

/**
 * Return a recorded origin list when it is non-empty, small, and already
 * normalized; otherwise return null. Readers use this so a hand-edited value
 * cannot add a malformed or duplicate origin.
 */
export function readRecordedDashboardOrigins(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_DASHBOARD_ORIGINS) {
    return null;
  }
  if (!value.every((entry) => typeof entry === "string")) return null;
  let normalized: string[];
  try {
    normalized = parseDashboardOrigins(value);
  } catch {
    return null;
  }
  return normalized.length === value.length && normalized.every((origin, i) => origin === value[i])
    ? normalized
    : null;
}

/**
 * Parse extra dashboard browser origins from flag values or a comma-separated
 * environment value (#13177). Each entry must be a bare http(s) origin without
 * user information, path, query, or fragment, and a remote origin must use
 * https. The result is normalized, has no duplicates, and holds at most
 * `MAX_DASHBOARD_ORIGINS` origins.
 */
export function parseDashboardOrigins(values: readonly string[]): string[] {
  const origins: string[] = [];
  let position = 0;
  for (const value of values) {
    for (const entry of value.split(",")) {
      const candidate = entry.trim();
      if (!candidate) continue;
      position += 1;
      // Name a rejected entry by position only: its value can carry a token or
      // credential in a path, query, or host, so it must not reach the terminal.
      const origin = parseDashboardOrigin(candidate, position);
      if (!origins.includes(origin)) origins.push(origin);
    }
  }
  if (origins.length > MAX_DASHBOARD_ORIGINS) {
    throw new Error(
      `A sandbox accepts at most ${String(MAX_DASHBOARD_ORIGINS)} dashboard origins; got ${String(origins.length)}.`,
    );
  }
  return origins;
}

function parseDashboardOrigin(candidate: string, position: number): string {
  const entry = `Dashboard origin ${String(position)}`;
  if (CONTROL_CHARACTER.test(candidate) || candidate.length > 2048) {
    throw new Error(`${entry} contains control characters or is too long.`);
  }
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error(`${entry} must be an absolute URL such as https://host:8443.`);
  }
  if (url.username || url.password) {
    throw new Error(`${entry} must not include user information.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${entry} must use http or https.`);
  }
  // URL parsing drops a bare "?" or "#", so also reject them in the raw input.
  if (url.pathname !== "/" || url.search || url.hash || /[?#]/u.test(candidate)) {
    throw new Error(`${entry} must not include a path, query, or fragment.`);
  }
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
    throw new Error(`${entry} must use https unless its host is loopback.`);
  }
  return url.origin;
}
