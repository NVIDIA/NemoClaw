// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

export interface DockerDaemonObservation {
  readonly reachable: boolean;
  readonly serverVersion?: string;
}

/**
 * Parse `docker info` output into the stable daemon facts shared by host
 * readiness and installed-sandbox diagnostics.
 *
 * Docker can exit successfully while emitting a zero-value JSON object when
 * its daemon is unavailable. Positive server-version evidence is therefore
 * required for JSON output. Plain text remains supported for older callers and
 * test doubles, except for the well-known daemon connection failures.
 */
export function parseDockerDaemonObservation(rawOutput = ""): DockerDaemonObservation {
  const text = String(rawOutput).trim();
  if (!text) return { reachable: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const lowered = text.toLowerCase();
    const reachable = !(
      lowered.includes("cannot connect to the docker daemon") ||
      lowered.includes("error during connect") ||
      lowered.includes("is the docker daemon running")
    );
    return {
      reachable,
      ...(reachable && !/\s/u.test(text) ? { serverVersion: text } : {}),
    };
  }

  if (!parsed || typeof parsed !== "object") return { reachable: false };
  const observation = parsed as Record<string, unknown>;
  if (Array.isArray(observation.ServerErrors) && observation.ServerErrors.length > 0) {
    return { reachable: false };
  }

  if (
    typeof observation.ServerVersion === "string" &&
    observation.ServerVersion.trim().length > 0
  ) {
    return { reachable: true, serverVersion: observation.ServerVersion.trim() };
  }

  const version = observation.version;
  if (version && typeof version === "object") {
    const nativeVersion = (version as Record<string, unknown>).Version;
    if (typeof nativeVersion === "string" && nativeVersion.trim().length > 0) {
      return { reachable: true, serverVersion: nativeVersion.trim() };
    }
  }

  return { reachable: false };
}

export function isDockerDaemonReachable(rawOutput = ""): boolean {
  return parseDockerDaemonObservation(rawOutput).reachable;
}

// A DOCKER_HOST value onboarding can use. Unset means Docker's default socket,
// which is supported; a set value must be an absolute `unix://` socket that can
// be written to the gateway environment file. TCP and SSH endpoints and
// relative paths are unsupported, so onboarding cannot use them even when they
// are reachable.
//
// The raw value is checked for null bytes and line breaks before trimming, so a
// trailing `\n` cannot be trimmed away and then accepted; the socket path is
// checked for the single quote it would be wrapped in when written to the
// gateway environment file.
export function isSupportedGatewayDockerHost(value: string | undefined): boolean {
  const raw = String(value ?? "");
  if (/[\0\r\n]/.test(raw)) return false;
  const candidate = raw.trim();
  if (!candidate) return true;
  const prefix = "unix://";
  if (!candidate.startsWith(prefix)) return false;
  const socketPath = candidate.slice(prefix.length);
  return path.isAbsolute(socketPath) && !socketPath.includes("'");
}
