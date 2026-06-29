// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn as spawnChild } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { compactText } from "../core/url-utils";
import { redact } from "../security/redact";
import { getOccupiedPorts } from "./dashboard-port";
import { cleanupTempDir, secureTempFile } from "./temp-files";

// `openshell forward start --background` daemonises the actual forward
// process, but the parent CLI's stdio is inherited by the daemon child on
// some platforms (notably the Docker compatibility gateway used when the
// host glibc is older than the openshell-gateway requirement). spawnSync
// then waits on those fds until the daemon exits — minutes later — and
// reports ETIMEDOUT even though the forward is established.
//
// The detached path below spawns the CLI with `detached: true`, hands it
// independent diagnostic file descriptors, and confirms success by polling
// `openshell forward list` for an entry matching `(port, sandboxName)`.
// The CLI's exit code is no longer the success signal — the appearance of
// the live forward in the list is.

export type ForwardListFetcher = () => string;

export type DetachedForwardSpawnRunner = (stdio: { stdout: number; stderr: number }) => {
  pid?: number;
  error?: Error;
};

export interface DetachedForwardStartOutcome {
  ok: boolean;
  diagnostic: string;
  pid?: number;
  reason: "ok" | "spawn-error" | "timeout" | "spawn-conflict";
}

export interface DetachedForwardStartOptions {
  overallTimeoutMs?: number;
  pollIntervalMs?: number;
  sleepMs?: (ms: number) => void;
  // Called once per `progressIntervalMs` while the helper is still waiting
  // for the forward to appear in `openshell forward list`. The default is a
  // no-op so the helper stays terminal-quiet in non-interactive contexts.
  onProgress?: (info: { elapsedMs: number; listSnapshot: string }) => void;
  progressIntervalMs?: number;
  // Number of EADDRINUSE-style retries after the initial attempt. Honoured
  // only by `runDetachedForwardStartWithPortReleaseRetries`. Defaults to 3.
  maxRetries?: number;
}

function readDiagnosticFile(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

export function looksLikeForwardPortConflict(diagnostic: string): boolean {
  return /eaddrinuse|address already in use|port .* in use|bind: .*in use/i.test(diagnostic);
}

function blockingSleepMs(ms: number): void {
  if (ms <= 0) return;
  // Synchronous sleep — onboard's forward-start sits in a sync code path,
  // so we cannot await. spawnSync of `node -e setTimeout` is the same
  // primitive `sleepMs` in core/wait uses, but we keep the call site
  // injectable so tests can stub it without spawning subprocesses. We
  // intentionally do NOT `.unref()` the timer in the child: an unref'd
  // timer lets the child's event loop drain immediately, so spawnSync
  // returns instantly and the caller spins through the poll loop without
  // actually waiting.
  const { spawnSync } = require("node:child_process");
  spawnSync(process.execPath, ["-e", `setTimeout(() => {}, ${ms});`], {
    stdio: "ignore",
    timeout: ms + 5_000,
  });
}

/**
 * Build a `DetachedForwardSpawnRunner` that spawns the given argv as a
 * detached child, writing stdio to the file descriptors supplied by
 * `runDetachedForwardStartWithDiagnostics`. Kept in this module so the
 * onboard call site stays a thin wire-up and the spawn-on-Node detail
 * (`detached: true` + `unref()`) lives next to the consumer that relies
 * on it.
 */
export function buildDetachedForwardStartSpawn(
  argv: readonly string[],
): DetachedForwardSpawnRunner {
  return ({ stdout, stderr }) => {
    // Preflight: the helper polls synchronously, so a Node `error` event
    // dispatched after `spawn` returns cannot reach the poll loop while it
    // is sleeping on a `spawnSync` child. Catch the obvious ENOENT/EACCES
    // cases up front via `fs.accessSync` so the helper returns the real
    // failure immediately instead of timing out 180s later.
    try {
      fs.accessSync(argv[0], fs.constants.X_OK);
    } catch (e) {
      return { error: e instanceof Error ? e : new Error(String(e)) };
    }
    try {
      const child = spawnChild(argv[0], argv.slice(1), {
        stdio: ["ignore", stdout, stderr],
        detached: true,
      });
      // Swallow any belated `error` event so a race between accessSync and
      // execve does not crash the process via an unhandled emitter.
      child.on("error", () => {});
      // A null/undefined pid means execve failed even though the preflight
      // succeeded (race against permission changes, ulimit, etc.). The async
      // `error` event would otherwise be swallowed by the listener above and
      // the caller would wait the full deadline for a child that never ran.
      if (child.pid == null) {
        return { error: new Error(`spawn ${argv[0]} returned no pid`) };
      }
      child.unref();
      return { pid: child.pid };
    } catch (e) {
      return { error: e instanceof Error ? e : new Error(String(e)) };
    }
  };
}

function isForwardConfirmed(
  forwardListOutput: string,
  expect: { port: number; sandboxName: string },
): boolean {
  return getOccupiedPorts(forwardListOutput).get(String(expect.port)) === expect.sandboxName;
}

/**
 * Best-effort SIGTERM of the detached `openshell forward start --background`
 * process when the helper gives up. Without this, a slow gateway handshake
 * can still register a forward minutes after onboard already rolled the
 * sandbox back, causing the next onboard attempt on the same port to race
 * an orphan CLI for the dashboard. `kill` swallows ESRCH so a child that
 * already exited is a no-op.
 */
function terminateDetachedForwardChild(pid: number | undefined): void {
  if (!pid || pid <= 0) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* already exited or out of our reach */
  }
}

/**
 * Default progress logger for the detached forward-start helper. Emits a
 * single line to stdout every `progressIntervalMs` while the helper is
 * still polling. Kept here so the onboard call site does not need to
 * recreate the same closure inline.
 */
export function buildForwardStartProgressLogger(
  port: number,
): (info: { elapsedMs: number }) => void {
  return ({ elapsedMs }) => {
    console.log(
      `  Still waiting for forward on port ${port} to register (${Math.round(elapsedMs / 1000)}s elapsed)...`,
    );
  };
}

/**
 * Spawn `openshell forward start --background` as a detached child and wait
 * for the resulting forward to appear in `openshell forward list`. Returns
 * `ok: true` as soon as the live entry is observed, regardless of whether
 * the original spawn process has exited yet. Returns `ok: false` with a
 * captured diagnostic when:
 *   - the spawn itself failed (ENOENT, permission denied, …);
 *   - the parent process wrote an EADDRINUSE-style error to stderr before
 *     the deadline (port conflict — retry path);
 *   - the deadline expired without the forward appearing.
 *
 * The diagnostic file pair is removed before return, so the temp dir does
 * not leak across retries.
 */
export function runDetachedForwardStartWithDiagnostics(
  runDetachedSpawn: DetachedForwardSpawnRunner,
  fetchForwardList: ForwardListFetcher,
  expect: { port: number; sandboxName: string },
  options: DetachedForwardStartOptions = {},
): DetachedForwardStartOutcome {
  // 180s deadline accommodates Docker compatibility gateways (host glibc
  // older than openshell-gateway's requirement runs the gateway in an extra
  // Docker container, adding per-call gRPC latency that can push the
  // forward-registration handshake past a tighter timeout).
  const overallTimeoutMs = options.overallTimeoutMs ?? 180_000;
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const sleepImpl = options.sleepMs ?? blockingSleepMs;
  const onProgress = options.onProgress;
  const progressIntervalMs = options.progressIntervalMs ?? 30_000;
  let nextProgressAt = Date.now() + progressIntervalMs;

  const forwardDiagPath = secureTempFile("nemoclaw-forward-start", ".out");
  const forwardDiagDir = path.dirname(forwardDiagPath);
  const forwardErrPath = path.join(forwardDiagDir, "nemoclaw-forward-start.err");
  // `fs.openSync` with `"w"` truncates / creates the diagnostic files; the
  // child inherits the fds via posix_spawn semantics. We close the host's
  // copies immediately so only the child's reference keeps them alive,
  // which lets the kernel reclaim them when the (detached) child exits.
  const outFd = fs.openSync(forwardDiagPath, "w", 0o600);
  const errFd = fs.openSync(forwardErrPath, "w", 0o600);

  let pid: number | undefined;
  let spawnError: Error | undefined;
  try {
    const spawnResult = runDetachedSpawn({ stdout: outFd, stderr: errFd });
    pid = spawnResult.pid;
    spawnError = spawnResult.error;
  } finally {
    try {
      fs.closeSync(outFd);
    } catch {
      /* best effort */
    }
    try {
      fs.closeSync(errFd);
    } catch {
      /* best effort */
    }
  }

  let lastFetchError: string | null = null;
  const readDiag = (): string => {
    const stderr = readDiagnosticFile(forwardErrPath);
    const stdout = readDiagnosticFile(forwardDiagPath);
    const message = spawnError instanceof Error ? spawnError.message : "";
    const fetchSuffix = lastFetchError ? ` openshell forward list failed: ${lastFetchError}` : "";
    return compactText(redact(`${stderr} ${stdout} ${message}${fetchSuffix}`));
  };

  try {
    if (spawnError) {
      return { ok: false, diagnostic: readDiag(), pid, reason: "spawn-error" };
    }

    const start = Date.now();
    const deadline = start + overallTimeoutMs;
    let lastListSnapshot = "";
    while (Date.now() < deadline) {
      let list = "";
      try {
        list = fetchForwardList() || "";
        // Clear the cached transient error so a recovered gateway does not
        // leave a stale "openshell forward list failed: …" suffix on the
        // eventual timeout diagnostic.
        lastFetchError = null;
      } catch (err) {
        lastFetchError = err instanceof Error ? err.message : String(err);
      }
      lastListSnapshot = list;
      if (isForwardConfirmed(list, expect)) {
        return { ok: true, diagnostic: readDiag(), pid, reason: "ok" };
      }
      const diagSoFar = readDiag();
      if (looksLikeForwardPortConflict(diagSoFar)) {
        terminateDetachedForwardChild(pid);
        return { ok: false, diagnostic: diagSoFar, pid, reason: "spawn-conflict" };
      }
      if (onProgress && Date.now() >= nextProgressAt) {
        onProgress({ elapsedMs: Date.now() - start, listSnapshot: list });
        nextProgressAt = Date.now() + progressIntervalMs;
      }
      sleepImpl(pollIntervalMs);
    }
    const finalDiag = readDiag();
    const listTail = lastListSnapshot
      ? ` last forward list: ${compactText(redact(lastListSnapshot)).slice(0, 240)}`
      : " last forward list: <empty>";
    const timeoutSummary = `forward did not appear in list within ${overallTimeoutMs}ms;${listTail}`;
    // The detached `openshell forward start --background` process may still
    // be running (e.g. blocked on a slow gateway handshake). If the caller
    // is about to roll back the sandbox, leaving an orphan CLI that may yet
    // succeed would race with the next onboard attempt for the same port.
    terminateDetachedForwardChild(pid);
    return {
      ok: false,
      diagnostic: finalDiag ? `${timeoutSummary} ${finalDiag}` : timeoutSummary,
      pid,
      reason: "timeout",
    };
  } finally {
    cleanupTempDir(forwardDiagPath, "nemoclaw-forward-start");
  }
}

/**
 * Retry the detached forward-start when the diagnostic looks like an
 * EADDRINUSE-style port conflict. `beforeRetry` runs between attempts so
 * the caller can drop any stale forward bound to the same port before
 * trying again.
 */
export function runDetachedForwardStartWithPortReleaseRetries(
  runDetachedSpawn: DetachedForwardSpawnRunner,
  fetchForwardList: ForwardListFetcher,
  expect: { port: number; sandboxName: string },
  beforeRetry: () => void,
  options: DetachedForwardStartOptions = {},
): DetachedForwardStartOutcome {
  const maxRetries = options.maxRetries ?? 3;
  let attempt = runDetachedForwardStartWithDiagnostics(
    runDetachedSpawn,
    fetchForwardList,
    expect,
    options,
  );
  for (
    let retries = 0;
    !attempt.ok && looksLikeForwardPortConflict(attempt.diagnostic) && retries < maxRetries;
    retries++
  ) {
    beforeRetry();
    attempt = runDetachedForwardStartWithDiagnostics(
      runDetachedSpawn,
      fetchForwardList,
      expect,
      options,
    );
  }
  return attempt;
}
