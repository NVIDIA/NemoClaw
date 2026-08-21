// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Ollama auth proxy status-file IPC (#6014).
//
// The auth proxy runs as a detached Node child with `stdio: "ignore"`, so
// stderr is not observable from the parent. The proxy writes a structured
// exit reason to a JSON status file before any non-zero exit and removes it
// on a successful listen. The host reads the file when the readiness loop
// finds the proxy gone and renders a specific actionable remediation
// message.
//
// Extracted from proxy.ts per #6014 monolith-growth guardrail: the IPC
// protocol and the remediation rendering are self-contained and belong
// with the proxy script's own contract, not co-mingled with the token /
// PID / process lifecycle logic that proxy.ts otherwise owns.

const fs = require("fs");
const path = require("path");

export type ProxyExitStatus = {
  reason: string;
  details?: string;
  exitedAt?: number;
};

/**
 * Name of the env var the host uses to hand the proxy script a path to
 * write its structured exit status to. Kept in one place so a rename of
 * the wire protocol only touches this file.
 */
export const PROXY_STATUS_ENV = "NEMOCLAW_OLLAMA_PROXY_STATUS_FILE";

/**
 * Default status-file path under an adapter state dir. Callers hand in the
 * state dir so this module has no direct dependency on the token/PID/state
 * layout in proxy.ts.
 */
export function defaultProxyStatusPath(stateDir: string): string {
  return path.join(stateDir, "ollama-auth-proxy.status");
}

/**
 * Read the structured exit status the proxy script writes to `statusPath`
 * before a non-zero exit. Returns null when the file is absent or
 * unparseable so the caller can fall back to the generic
 * "exited during startup" remediation the host already prints for
 * pre-existing failure modes.
 */
export function readProxyExitStatus(statusPath: string): ProxyExitStatus | null {
  let raw: string;
  try {
    raw = fs.readFileSync(statusPath, "utf8");
  } catch (err) {
    // ENOENT is the expected "proxy started cleanly and did not write" case.
    // Any other read failure (EACCES on a container with tight file
    // permissions, EPERM under a strict sandbox) is treated the same:
    // there is no structured reason to surface, so fall back.
    void err;
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.reason === "string") {
      return {
        reason: parsed.reason,
        details: typeof parsed.details === "string" ? parsed.details : undefined,
        exitedAt: typeof parsed.exitedAt === "number" ? parsed.exitedAt : undefined,
      };
    }
  } catch {
    // Unparseable — fall through to null so the caller renders the
    // generic remediation instead.
  }
  return null;
}

/**
 * Best-effort removal of a stale status file. Called before spawning a new
 * proxy so a later read after this spawn sees the new proxy's exit reason
 * (or finds no file when the new proxy starts cleanly), never a leftover
 * reason from a previous run.
 */
export function clearStaleProxyStatus(statusPath: string): void {
  try {
    fs.unlinkSync(statusPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      // Same as writeExitStatus in the proxy script itself: this is hint
      // metadata, not load-bearing. Log through the parent's own console
      // only when the failure is not the expected absent-file case.
      console.warn(
        `  Warning: could not clear stale proxy status file at ${statusPath}: ` +
          `${(err as NodeJS.ErrnoException).message}`,
      );
    }
  }
}

/**
 * Describe a backend URL for the reader: its `host:port` authority, and a
 * ` on port <port>` clause when the URL carries a port. Both fall back to the
 * raw value instead of throwing, because this renders a failure path.
 */
function describeBackend(backendUrl: string): { authority: string; portClause: string } {
  try {
    const parsed = new URL(backendUrl);
    return { authority: parsed.host, portClause: parsed.port ? ` on port ${parsed.port}` : "" };
  } catch {
    return { authority: backendUrl, portClause: "" };
  }
}

/**
 * Render the backend-not-loopback refusal (#6014).
 *
 * The same proxy also fronts a user's OpenAI-compatible endpoint when they
 * onboard it without authentication (`noAuthProxy` in ./proxy.ts), so the
 * backend is not always the Ollama daemon. Naming Ollama and OLLAMA_HOST for
 * a vLLM or llama-server backend sends the reader to a service they are not
 * running, on a port they are not using (#9730). The backend is the managed
 * Ollama daemon exactly when the caller selected no compatible endpoint, so
 * only an absent `backendUrl` selects the Ollama text. A compatible endpoint
 * can itself sit on the Ollama port, and `OLLAMA_PORT` is overridable, so URL
 * equality cannot identify the daemon.
 */
function printBackendNotLoopback(
  details: string | undefined,
  ollamaPort: number,
  backendUrl: string | undefined,
): void {
  const listeners = details || "see proxy log";
  if (backendUrl === undefined) {
    console.error("  Error: Ollama auth proxy refused to start.");
    console.error(
      `  Ollama is reachable on a non-loopback interface on the host (${listeners}), ` +
        "which would bypass the proxy's token check entirely.",
    );
    console.error(
      `  Remediation: bind Ollama to loopback only. On Linux, set OLLAMA_HOST=127.0.0.1:${ollamaPort} ` +
        "in the Ollama systemd unit's [Service] section. On other platforms, set OLLAMA_HOST=127.0.0.1 " +
        "in the launcher's environment before starting Ollama.",
    );
    return;
  }
  // Name the loopback requirement, not a literal address: an endpoint entered
  // as [::1] must stay on the IPv6 loopback, and telling that reader to listen
  // on 127.0.0.1 would make the endpoint unreachable again.
  const { authority, portClause } = describeBackend(backendUrl);
  console.error("  Error: The protected loopback route refused to start.");
  console.error(
    `  The endpoint at ${authority} is reachable on a non-loopback interface on the host ` +
      `(${listeners}), which would bypass the route's token check entirely.`,
  );
  console.error(
    `  Remediation: start the endpoint server bound to a loopback address only${portClause}, ` +
      "then re-run onboarding.",
  );
}

/**
 * Render proxy startup-failure remediation. When the proxy script wrote a
 * structured reason (e.g. backend-not-loopback per #6014), surface a
 * specific actionable message. Otherwise return false so the caller falls
 * back to its existing owner-or-port remediation.
 *
 * `backendUrl` is the compatible endpoint the caller selected, or undefined
 * when the proxy fronts the managed Ollama daemon.
 */
export function printProxyStartupReason(
  status: ProxyExitStatus | null,
  ollamaPort: number,
  backendUrl?: string,
): boolean {
  if (status === null) return false;
  if (status.reason === "backend-not-loopback") {
    printBackendNotLoopback(status.details, ollamaPort, backendUrl);
    return true;
  }
  console.error(`  Error: Ollama auth proxy exited during startup: ${status.reason}`);
  if (status.details) console.error(`  Details: ${status.details}`);
  return true;
}
