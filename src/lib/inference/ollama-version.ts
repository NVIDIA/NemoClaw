// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Ollama version detection helpers. Kept separate from the larger
 * `inference/local.ts` so the version-floor logic can evolve without
 * dragging the rest of the local-inference helpers along.
 */

import { buildValidatedCurlCommandArgs } from "../adapters/http/curl-args";
import { OLLAMA_PORT } from "../core/ports";
import { runCapture } from "../runner";

export type OllamaVersionRunCapture = (
  cmd: readonly string[],
  opts?: { ignoreError?: boolean; timeout?: number },
) => string;

const SYSTEMD_UNIT_PROBE_TIMEOUT_MS = 5_000;

/** Return true only when this Linux host has an installed systemd Ollama unit. */
export function hasOllamaSystemdUnit(
  capture: OllamaVersionRunCapture,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== "linux") return false;
  return Boolean(
    capture(
      [
        "sh",
        "-c",
        "command -v systemctl >/dev/null && [ -d /run/systemd/system ] && systemctl list-unit-files ollama.service --no-legend 2>/dev/null | head -n1",
      ],
      { ignoreError: true, timeout: SYSTEMD_UNIT_PROBE_TIMEOUT_MS },
    ).trim(),
  );
}

/**
 * Minimum Ollama version NemoClaw expects when reusing an existing host
 * Ollama. Older Ollama runners can fail to return structured tool calls for
 * the default Nemotron starter model. Bump this when starter-model recipes
 * adopt a newer Ollama feature.
 */
export const MIN_OLLAMA_VERSION = "0.32.9";

const OLLAMA_CLIENT_VERSION_LINE = /client version is\s+(\d+\.\d+\.\d+)/i;

export function getInstalledOllamaVersion(runCaptureImpl?: OllamaVersionRunCapture): string | null {
  const capture = runCaptureImpl ?? runCapture;
  const out = capture(["ollama", "--version"], { ignoreError: true });
  if (!out) return null;
  const clientVersion = out.match(OLLAMA_CLIENT_VERSION_LINE);
  if (clientVersion) return clientVersion[1];
  const match = out.match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? match[0] : null;
}

/**
 * Probe the running Ollama daemon's version via `/api/version`. This is
 * the version NemoClaw will actually drive for inference — the CLI binary
 * on `PATH` may be newer than the daemon that still owns `:11434` (for
 * example after a user-local install while the original systemd unit is
 * still running). Returns `null` when the daemon is unreachable or the
 * response payload is not parseable.
 */
export function getRunningOllamaDaemonVersion(
  runCaptureImpl?: OllamaVersionRunCapture,
  endpoint: string = `http://127.0.0.1:${OLLAMA_PORT}/api/version`,
): string | null {
  const capture = runCaptureImpl ?? runCapture;
  const out = capture(
    [
      "curl",
      ...buildValidatedCurlCommandArgs([
        "-sf",
        "--connect-timeout",
        "2",
        "--max-time",
        "5",
        endpoint,
      ]),
    ],
    { ignoreError: true },
  );
  if (!out) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const raw = (parsed as { version?: unknown }).version;
  if (typeof raw !== "string") return null;
  const match = raw.match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? match[0] : null;
}

export function isOllamaVersionAtLeast(version: string | null, minimum: string): boolean {
  if (!version) return false;
  const parts = version.split(".").map((v) => Number.parseInt(v, 10));
  const min = minimum.split(".").map((v) => Number.parseInt(v, 10));
  const len = Math.max(parts.length, min.length);
  for (let i = 0; i < len; i += 1) {
    const a = parts[i] ?? 0;
    const b = min[i] ?? 0;
    if (Number.isNaN(a) || Number.isNaN(b)) return false;
    if (a > b) return true;
    if (a < b) return false;
  }
  return true;
}
