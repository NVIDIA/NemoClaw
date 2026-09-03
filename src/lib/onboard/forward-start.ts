// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn as spawnChild, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { compactText } from "../core/url-utils";
import { redact } from "../security/redact";
import { parseForwardList } from "../state/sandbox-session";
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

/**
 * Returns the serialized forward list on success. An empty string means the
 * list query succeeded with no entries; `null` means ownership is unknown
 * because the query did not return a result.
 */
export type ForwardListFetcher = () => string | null;

export type DetachedForwardSpawnRunner = (stdio: { stdout: number; stderr: number }) => {
  pid?: number;
  error?: Error;
};

export interface DetachedForwardStartOutcome {
  ok: boolean;
  diagnostic: string;
  pid?: number;
  reason:
    | "ok"
    | "ok-port-live"
    | "spawn-error"
    | "timeout"
    | "spawn-conflict"
    | "dead-forward"
    | "listener-ownership-conflict"
    | "listener-start-failure";
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
  // Number of retryable startup attempts after the initial attempt. Honoured
  // only by `runDetachedForwardStartWithRetries`. An explicit value applies
  // to every retryable outcome. Ordinary failures default to 3 retries; exact
  // sandbox readiness handoffs use their own longer default below.
  maxRetries?: number;
  // Loopback port-liveness probe. Defaults to `probeLocalPortListening` (a
  // synchronous Node TCP connect to 127.0.0.1:port). The retry wrapper uses it
  // to reject a listener that predates an attempt. The poll loop uses it only
  // for listener-start and untracked-forward diagnostics. Injectable so unit
  // tests need not open real sockets or spawn probe subprocesses.
  isPortListening?: (port: number) => boolean;
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

/**
 * True when openshell's `forward start --background` reported that it
 * established the tunnel but could not discover/track the backgrounded
 * process — so the forward is running yet never appears in `openshell forward
 * list`. Observed on macOS hosts backed by Colima, where the remote bind
 * completes *after* openshell's one-shot discovery probe, and on hosts whose
 * ssh config applies `ControlMaster auto` to the sandbox host: the spawned
 * ssh client delegates the -L forward to the ControlMaster mux daemon and
 * exits, which openshell 0.0.72+ reports as "ssh exited before local forward
 * listener opened" even though the mux daemon holds the listener and serves
 * traffic. Confirmation still requires the live-port probe. A definitive
 * listener failure with a closed port returns for bounded retry; other closed-
 * port failures keep polling until the deadline. See GitHub #6099 and #7266.
 */
export function looksLikeUntrackedForward(diagnostic: string): boolean {
  return /could not discover backgrounded ssh process|forward may be running but is not tracked|ssh exited before local forward listener opened|local forward listener was not reachable/i.test(
    diagnostic,
  );
}

const OPENSHELL_SANDBOX_NOT_READY_DIAGNOSTIC =
  /^Error: code: 'The system is not in a state required for the operation's execution', message: "sandbox is not ready"$/i;

function looksLikeSandboxNotReadyForwardStart(diagnostic: string): boolean {
  const normalized = compactText(diagnostic.replace(/[×│]/gu, " "));
  return OPENSHELL_SANDBOX_NOT_READY_DIAGNOSTIC.test(normalized);
}

/**
 * True only after openshell reports that the SSH process has definitively
 * stopped waiting for its local listener. Unlike the broader untracked-
 * forward diagnostic above, this means another list poll cannot make the
 * terminated attempt appear. Successful ownership enumeration plus a live-port
 * probe preserves the ControlMaster compatibility path after the child exits
 * (#6099).
 *
 * Compatibility boundary: these exact diagnostics are emitted by the pinned
 * OpenShell 0.0.106 forward-start path tracked in #7266. Reassess this matcher
 * when NemoClaw's supported OpenShell range moves beyond 0.0.106, and remove it
 * once OpenShell either keeps the attempt alive until the listener is ready or
 * exposes a structured retryable outcome. Keep the fragments narrow so an
 * unrelated SSH or gateway failure cannot enter the listener-retry path.
 * OpenShell 0.0.106 can also reject a forward during the sandbox readiness
 * handoff. That command has already exited, so list polling cannot recover it;
 * the retry wrapper below gives the OpenShell gateway a bounded settle interval.
 */
export function looksLikeForwardListenerStartFailure(diagnostic: string): boolean {
  if (looksLikeSandboxNotReadyForwardStart(diagnostic)) return true;
  return /ssh exited before local forward listener opened|local forward listener did not open\b/i.test(
    diagnostic,
  );
}

/**
 * Synchronous, dependency-free loopback port-liveness probe. forward-start
 * runs in a synchronous code path (see `blockingSleepMs`), so we spawn a
 * short-lived Node child that attempts a 127.0.0.1 TCP connect and reports the
 * result via its exit code. Portable across macOS / Linux / WSL2 / Windows with
 * no `lsof` / `ss` / `netstat` dependency. A refused connection returns
 * immediately; the timeout only bounds a genuinely hung connect.
 */
function probeLocalPortListening(port: number): boolean {
  const probeTimeoutMs = 1_500;
  const script =
    'const net=require("net");' +
    'const s=net.connect(Number(process.argv[1]),"127.0.0.1");' +
    "let settled=false;" +
    "const finish=(code)=>{if(settled)return;settled=true;try{s.destroy();}catch{}process.exit(code);};" +
    `s.setTimeout(${probeTimeoutMs});` +
    's.once("connect",()=>finish(0));' +
    's.once("timeout",()=>finish(1));' +
    's.once("error",()=>finish(1));';
  const res = spawnSync(process.execPath, ["-e", script, String(Number(port))], {
    stdio: "ignore",
    timeout: probeTimeoutMs + 2_000,
  });
  return res.status === 0;
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

// OpenShell's external background-forward registry can briefly report a newly
// registered row as `dead` while its SSH process settles. NemoClaw cannot fix
// that producer in this repository, so require the exact sandbox+port row to
// stay dead across several normal polls before using the existing
// sandbox-scoped stop/retry boundary. Remove this reconciliation once every
// supported OpenShell version either stops retaining persistent dead rows or
// exposes an atomic recovery operation.
const DEAD_FORWARD_GRACE_MS = 2_000;
const SANDBOX_READY_RETRY_SETTLE_MS = 5_000;
// A newly created sandbox can remain between OpenShell's create-ready and
// forward-ready states longer than the ordinary listener retry budget. Keep
// this exact-diagnostic path bounded to one additional minute without
// widening retries for authentication, ownership, or listener failures.
const SANDBOX_READY_MAX_RETRIES = 12;

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

function classifyListenerStartDiagnostic(input: {
  diagnostic: string;
  pid: number | undefined;
  port: number;
  ownerLookupSucceeded: boolean;
  listedForAnotherSandbox: boolean;
  isPortListening: (port: number) => boolean;
}): DetachedForwardStartOutcome | null {
  if (looksLikeSandboxNotReadyForwardStart(input.diagnostic) && !input.ownerLookupSucceeded) {
    return null;
  }
  if (!looksLikeForwardListenerStartFailure(input.diagnostic)) return null;

  if (input.listedForAnotherSandbox) {
    terminateDetachedForwardChild(input.pid);
    return {
      ok: false,
      diagnostic: input.diagnostic,
      pid: input.pid,
      reason: "listener-ownership-conflict",
    };
  }

  const portListening = input.ownerLookupSucceeded && input.isPortListening(input.port);
  if (portListening && looksLikeUntrackedForward(input.diagnostic)) {
    return {
      ok: true,
      diagnostic: input.diagnostic,
      pid: input.pid,
      reason: "ok-port-live",
    };
  }

  terminateDetachedForwardChild(input.pid);
  return {
    ok: false,
    diagnostic: input.diagnostic,
    pid: input.pid,
    reason: portListening ? "listener-ownership-conflict" : "listener-start-failure",
  };
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
 * `ok: true` when the expected list entry appears, or under the established
 * #6099 compatibility path after successful list enumeration and a live-port
 * probe. Returns `ok: false` with a captured diagnostic when:
 *   - the spawn itself failed (ENOENT, permission denied, …);
 *   - the parent process wrote an EADDRINUSE-style error to stderr before
 *     the deadline (port conflict — retry path);
 *   - a definitive listener failure makes the attempt eligible for retry;
 *   - a foreign or otherwise unproven live listener creates an ownership
 *     conflict;
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
  const isPortListening = options.isPortListening ?? probeLocalPortListening;
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
  let lastOwnerLookupSucceeded = false;
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
    const portProbeIntervalMs = Math.max(pollIntervalMs, 5_000);
    let nextPortProbeAt = start;
    let lastListSnapshot = "";
    let deadForwardObservedAt: number | null = null;
    while (Date.now() < deadline) {
      let list = "";
      try {
        const fetchedList = fetchForwardList();
        if (fetchedList === null) {
          lastFetchError = "OpenShell returned no forward list result";
          lastOwnerLookupSucceeded = false;
        } else {
          list = fetchedList;
          // Clear the cached transient error so a recovered gateway does not
          // leave a stale "openshell forward list failed: …" suffix on the
          // eventual timeout diagnostic.
          lastFetchError = null;
          lastOwnerLookupSucceeded = true;
        }
      } catch (err) {
        lastFetchError = err instanceof Error ? err.message : String(err);
        lastOwnerLookupSucceeded = false;
      }
      lastListSnapshot = list;
      const listedOwner = getOccupiedPorts(list).get(String(expect.port));
      if (listedOwner === expect.sandboxName) {
        return { ok: true, diagnostic: readDiag(), pid, reason: "ok" };
      }
      const listedForAnotherSandbox = Boolean(listedOwner);
      const expectedForwardIsDead = parseForwardList(list).some(
        (entry) =>
          entry.sandboxName === expect.sandboxName &&
          entry.port === String(expect.port) &&
          entry.status === "dead",
      );
      const diagSoFar = readDiag();
      if (looksLikeForwardPortConflict(diagSoFar)) {
        terminateDetachedForwardChild(pid);
        return { ok: false, diagnostic: diagSoFar, pid, reason: "spawn-conflict" };
      }
      if (expectedForwardIsDead) {
        deadForwardObservedAt ??= Date.now();
        if (Date.now() - deadForwardObservedAt >= DEAD_FORWARD_GRACE_MS) {
          terminateDetachedForwardChild(pid);
          const deadSummary =
            `forward on port ${expect.port} remained dead for ` +
            `${DEAD_FORWARD_GRACE_MS}ms after startup`;
          return {
            ok: false,
            diagnostic: diagSoFar ? `${deadSummary} ${diagSoFar}` : deadSummary,
            pid,
            reason: "dead-forward",
          };
        }
      } else {
        deadForwardObservedAt = null;
        // A completed listener-start failure cannot recover through more list
        // polling. Preserve the established ControlMaster exception from #6099
        // only when forward-list ownership enumeration succeeded and openshell
        // also emitted that narrower untracked-forward diagnostic. A live TCP
        // port alone is not evidence that this attempt owns the listener.
        const listenerOutcome = classifyListenerStartDiagnostic({
          diagnostic: diagSoFar,
          pid,
          port: expect.port,
          ownerLookupSucceeded: lastOwnerLookupSucceeded,
          listedForAnotherSandbox,
          isPortListening,
        });
        if (listenerOutcome) return listenerOutcome;
        // Preserve the established "untracked forward" compatibility path
        // (GitHub #6099). It requires openshell's narrow diagnostic, a successful
        // list query with no foreign sandbox row, and a live local port. This is
        // intentionally not widened to other diagnostics because the probe does
        // not establish process identity.
        if (
          lastFetchError === null &&
          !listedForAnotherSandbox &&
          looksLikeUntrackedForward(diagSoFar) &&
          Date.now() >= nextPortProbeAt
        ) {
          nextPortProbeAt = Date.now() + portProbeIntervalMs;
          if (isPortListening(expect.port)) {
            return { ok: true, diagnostic: readDiag(), pid, reason: "ok-port-live" };
          }
        }
      }
      if (onProgress && Date.now() >= nextProgressAt) {
        onProgress({ elapsedMs: Date.now() - start, listSnapshot: list });
        nextProgressAt = Date.now() + progressIntervalMs;
      }
      sleepImpl(pollIntervalMs);
    }
    const finalDiag = readDiag();
    const finalReadinessOutcome =
      lastOwnerLookupSucceeded && looksLikeSandboxNotReadyForwardStart(finalDiag)
        ? classifyListenerStartDiagnostic({
            diagnostic: finalDiag,
            pid,
            port: expect.port,
            ownerLookupSucceeded: true,
            listedForAnotherSandbox: Boolean(
              getOccupiedPorts(lastListSnapshot).get(String(expect.port)),
            ),
            isPortListening,
          })
        : null;
    if (finalReadinessOutcome) return finalReadinessOutcome;
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
 * Retry the detached forward-start after an EADDRINUSE-style port conflict or
 * a definitive listener-start failure. A persistently dead exact sandbox+port
 * row receives one independent recovery after the sandbox-scoped cleanup
 * callback. Listener-start failures retry without sandbox/port cleanup because
 * OpenShell does not expose immutable attempt identity.
 */
export function runDetachedForwardStartWithRetries(
  runDetachedSpawn: DetachedForwardSpawnRunner,
  fetchForwardList: ForwardListFetcher,
  expect: { port: number; sandboxName: string },
  beforeRetryCleanup: () => void,
  options: DetachedForwardStartOptions = {},
): DetachedForwardStartOutcome {
  const maxRetries = options.maxRetries ?? 3;
  const maxSandboxReadyRetries = options.maxRetries ?? SANDBOX_READY_MAX_RETRIES;
  const sleepImpl = options.sleepMs ?? blockingSleepMs;
  let deadForwardRecoveryAvailable = true;
  let sandboxReadyRetries = 0;
  const isPortListening = options.isPortListening ?? probeLocalPortListening;
  const runAttempt = (): DetachedForwardStartOutcome =>
    isPortListening(expect.port)
      ? {
          ok: false,
          diagnostic: `port ${expect.port} is already in use before forward start`,
          reason: "listener-ownership-conflict",
        }
      : runDetachedForwardStartWithDiagnostics(runDetachedSpawn, fetchForwardList, expect, options);
  let attempt = runAttempt();
  let standardRetries = 0;
  while (!attempt.ok) {
    if (attempt.reason === "dead-forward") {
      if (!deadForwardRecoveryAvailable) break;
      deadForwardRecoveryAvailable = false;
      beforeRetryCleanup();
    } else {
      const isSandboxReadinessHandoff =
        attempt.reason === "listener-start-failure" &&
        looksLikeSandboxNotReadyForwardStart(attempt.diagnostic);
      if (isSandboxReadinessHandoff) {
        if (sandboxReadyRetries >= maxSandboxReadyRetries) break;
        // Keep the existing sandbox and port ownership intact while the
        // OpenShell gateway finishes the readiness handoff.
        sleepImpl(SANDBOX_READY_RETRY_SETTLE_MS);
        sandboxReadyRetries++;
      } else {
        const isRetryableStandardFailure =
          (attempt.reason !== "listener-ownership-conflict" &&
            looksLikeForwardPortConflict(attempt.diagnostic)) ||
          attempt.reason === "listener-start-failure";
        if (!isRetryableStandardFailure || standardRetries >= maxRetries) break;
        if (looksLikeForwardPortConflict(attempt.diagnostic)) {
          beforeRetryCleanup();
        }
        standardRetries++;
      }
    }
    attempt = runAttempt();
  }
  return attempt;
}
