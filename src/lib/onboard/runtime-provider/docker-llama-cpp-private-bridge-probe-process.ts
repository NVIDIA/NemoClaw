// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import http from "node:http";

const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const RETRY_DELAY_MS = 1_000;
export const PRIVATE_BRIDGE_PROBE_CONNECT_EXIT = 7;
export const PRIVATE_BRIDGE_PROBE_HTTP_EXIT = 22;
export const PRIVATE_BRIDGE_PROBE_TIMEOUT_EXIT = 28;

export interface LlamaCppPrivateBridgeProbeArguments {
  readonly url: string;
  readonly timeoutSeconds: number;
}

export type LlamaCppPrivateBridgeProbeAttempt =
  | { readonly kind: "response"; readonly status: number }
  | { readonly kind: "connect" }
  | { readonly kind: "timeout" };

export interface LlamaCppPrivateBridgeProbeDependencies {
  readonly attempt?: (
    url: string,
    timeoutMilliseconds: number,
  ) => Promise<LlamaCppPrivateBridgeProbeAttempt>;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export function parseLlamaCppPrivateBridgeProbeArguments(
  argv: readonly string[],
): LlamaCppPrivateBridgeProbeArguments {
  const [urlValue, timeoutValue, ...rest] = argv;
  if (urlValue === undefined || timeoutValue === undefined || rest.length !== 0) {
    throw new Error("private bridge probe expects exactly a URL and a timeout in seconds");
  }
  if (!/^[0-9]{1,7}$/u.test(timeoutValue)) {
    throw new Error("private bridge probe timeout is invalid");
  }
  const timeoutSeconds = Number(timeoutValue);
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3_600) {
    throw new Error("private bridge probe timeout is invalid");
  }
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    throw new Error("private bridge probe URL is invalid");
  }
  if (
    url.protocol !== "http:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hostname !== "127.0.0.1" ||
    url.pathname !== "/health" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(
      "private bridge probe URL must be an exact http://127.0.0.1:<port>/health address",
    );
  }
  const port = Number(url.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("private bridge probe port is invalid");
  }
  return Object.freeze({ url: urlValue, timeoutSeconds });
}

function attemptLlamaCppPrivateBridgeHealth(
  url: string,
  timeoutMilliseconds: number,
): Promise<LlamaCppPrivateBridgeProbeAttempt> {
  return new Promise((resolve) => {
    const expired = new Error("private bridge probe attempt timed out");
    const request = http.get(url, (response) => {
      const status = response.statusCode ?? 0;
      response.destroy();
      resolve({ kind: "response", status });
    });
    request.setTimeout(timeoutMilliseconds, () => request.destroy(expired));
    request.once("error", (error: NodeJS.ErrnoException) => {
      if (error === expired || error.code === "ETIMEDOUT") resolve({ kind: "timeout" });
      else resolve({ kind: "connect" });
    });
  });
}

// Probe the unauthenticated private bridge /health route from this host
// process. Container `--network host` probes cannot reach a WSL distro's
// loopback listener under Docker Desktop, so the loopback proof runs where
// the bridge actually binds. Exit codes mirror the curl vocabulary the
// enclosing lifecycle diagnostics report: 7 connect failure, 22 HTTP failure,
// 28 timeout.
export async function runLlamaCppPrivateBridgeProbe(
  input: LlamaCppPrivateBridgeProbeArguments,
  dependencies: LlamaCppPrivateBridgeProbeDependencies = {},
): Promise<number> {
  const now = dependencies.now ?? Date.now;
  const sleep =
    dependencies.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const attempt = dependencies.attempt ?? attemptLlamaCppPrivateBridgeHealth;
  const deadline = now() + input.timeoutSeconds * 1_000;
  let last: LlamaCppPrivateBridgeProbeAttempt = { kind: "connect" };
  for (;;) {
    const remainingBefore = deadline - now();
    if (remainingBefore <= 0) break;
    last = await attempt(input.url, remainingBefore);
    if (last.kind === "response") {
      if (last.status >= 200 && last.status < 300) return 0;
      if (!RETRYABLE_HTTP_STATUSES.has(last.status)) return PRIVATE_BRIDGE_PROBE_HTTP_EXIT;
    }
    const remainingAfter = deadline - now();
    if (remainingAfter <= 0) break;
    await sleep(Math.min(RETRY_DELAY_MS, remainingAfter));
  }
  if (last.kind === "timeout") return PRIVATE_BRIDGE_PROBE_TIMEOUT_EXIT;
  if (last.kind === "response") return PRIVATE_BRIDGE_PROBE_HTTP_EXIT;
  return PRIVATE_BRIDGE_PROBE_CONNECT_EXIT;
}

if (require.main === module) {
  Promise.resolve()
    .then(async () => {
      process.exitCode = await runLlamaCppPrivateBridgeProbe(
        parseLlamaCppPrivateBridgeProbeArguments(process.argv.slice(2)),
      );
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
