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
