// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Source-of-truth boundary for the agent dispatch contract (#8796).
//
// Both `nemoclaw <name> agent` transports capture the child's streams, forward
// host termination signals, and return the child's exit status. OpenClaw can
// still report status 0 when a dispatch produces no result, so the wrapper
// must classify that ambiguous result before it reports success.
//
// 6. Empty-dispatch guard (delivery contract).
//
//    - Invalid state: `openshell sandbox exec` returns status 0 with zero
//      bytes on both captured streams. A delivered OpenClaw turn cannot look
//      like this — the in-sandbox NemoClaw plugin writes its registration
//      banner to stderr on every invocation (docs/reference/commands.mdx),
//      so a healthy turn is never byte-empty on both streams. Reporting exit
//      0 here tells CI jobs and evaluation harnesses that a turn happened
//      when the agent never received the message.
//    - Source boundary: OpenShell owns the exec transport and OpenClaw owns
//      the turn. NemoClaw cannot repair either from the host, but it does own
//      what it reports to its own caller, so it fails loud instead of
//      laundering an empty dispatch into a success.
//    - Removal condition: drop this guard when the exec transport reports a
//      non-zero status (or a structured error) for a command it did not
//      actually run.
//
// 7. Non-interactive stdin posture.
//
//    - Invalid state: `nemoclaw <name> agent` is documented as a
//      non-interactive one-shot, yet PR #8191 moved the non-JSON transport
//      off `execSandbox` onto a raw `spawnSync` with a hard-coded
//      `stdio[0] = "inherit"`, dropping the TTY-aware stdin guard that
//      `buildSandboxCommandStdio` applies to every other sandbox exec. The JSON
//      transport has carried the same hard-coded inherit since #5683. The
//      result is a live terminal on fd 0 handed to a dispatch whose stdout
//      and stderr are pipes and whose argv says `--no-tty`.
//    - Source boundary: NemoClaw owns which fds it hands to OpenShell.
//      Forwarding a real pipe stays supported so `printf ... | nemoclaw
//      <name> agent` keeps working; only an interactive terminal is withheld.
//    - Removal condition: drop the TTY carve-out if `openclaw agent` gains a
//      documented interactive stdin mode reachable through this wrapper.
//
// 8. Host interruption propagation.
//
//    - Invalid state: the former synchronous transports blocked the Node.js
//      event loop. A host SIGTERM stopped NemoClaw without notifying the
//      OpenShell child, so the in-sandbox agent turn continued until its own
//      deadline.
//    - Source boundary: OpenShell owns remote command cancellation. NemoClaw
//      owns its direct child and uses the shared sandbox exec supervisor to
//      forward SIGTERM, wait for OpenShell to exit, and return exit 143.
//    - Removal condition: none while NemoClaw owns the host-side OpenShell
//      child lifecycle.
//
// 9. Timed-out turn guard (deadline contract).
//
//    - Invalid state: the turn's deadline fires, OpenClaw reports the timeout,
//      and the dispatch still exits 0 (#8723). Measured on three platforms and
//      on both transports, so a run that never answered is indistinguishable
//      from one that did, and a CI job or evaluation harness records the
//      timed-out turn as a pass. The empty-dispatch guard above cannot catch
//      it: the timeout report itself makes the streams non-empty.
//    - Source boundary: OpenClaw owns the deadline and the exit code, and that
//      code is the same whether this wrapper or a bare `openshell sandbox exec`
//      runs the turn. NemoClaw owns what it reports to its own caller, so it
//      classifies a timeout the way it already classifies an embedded-fallback
//      run rather than forwarding a success.
//    - Detection differs per transport because the evidence does. The JSON
//      transport reads the declared `meta.timeoutPhase` field, in
//      `openClawAgentIncompleteTurnSignal`. The non-JSON transport has only
//      text, so it matches the sentence OpenClaw prints, exactly as the
//      embedded-fallback branch matches its own banner.
//    - Removal condition: drop this guard when `openclaw agent` exits non-zero
//      for a turn whose deadline fired.
//
// Regression tests: `passthrough-dispatch.test.ts` owns the classifier and the
// supervised process lifecycle; `passthrough-help.test.ts` owns the diagnostic
// text.

import { spawn, type StdioOptions } from "node:child_process";

import { isStdinTty } from "../../../core/stdin";
import { runSandboxExecChild, type SandboxExecChild, type SandboxExecSignalSource } from "../exec";

/**
 * Exit code for a dispatch that reported success without delivering a turn.
 * Matches the wrapper's other non-recoverable dispatch failures.
 */
export const SILENT_AGENT_DISPATCH_EXIT_CODE = 1;

/** The subset of a child-process result the delivery classifier reads. */
export type AgentDispatchOutcome = {
  error?: Error;
  status: number | null;
  signal?: NodeJS.Signals | null;
};

export type AgentDispatchResult = AgentDispatchOutcome & {
  stderr: string;
  stdout: string;
};

type AgentDispatchReadable = {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
};

type AgentDispatchCaptureBudget = {
  bytes: number;
  overflowed: boolean;
};

export type AgentDispatchChild = SandboxExecChild & {
  stderr: AgentDispatchReadable | null;
  stdout: AgentDispatchReadable | null;
};

export type AgentDispatchSpawner = (
  binary: string,
  args: readonly string[],
  stdio: StdioOptions,
) => AgentDispatchChild;

export type AgentDispatchRunner = (
  binary: string,
  args: readonly string[],
  options?: {
    maxBufferBytes?: number;
    stdinIsTty?: boolean;
  },
) => Promise<AgentDispatchResult>;

export type AgentDispatchRunDeps = {
  signalSource?: SandboxExecSignalSource;
  spawnChild?: AgentDispatchSpawner;
};

const DEFAULT_AGENT_DISPATCH_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

const defaultAgentDispatchSpawner: AgentDispatchSpawner = (binary, args, stdio) =>
  spawn(binary, [...args], { stdio }) as unknown as AgentDispatchChild;

function captureAgentDispatchStream(
  stream: AgentDispatchReadable | null,
  child: AgentDispatchChild,
  chunks: Buffer[],
  maxBufferBytes: number,
  budget: AgentDispatchCaptureBudget,
  setOverflowError: (error: Error) => void,
): void {
  stream?.on("data", (chunk) => {
    if (budget.overflowed) return;
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const nextSize = budget.bytes + data.byteLength;
    if (nextSize > maxBufferBytes) {
      budget.overflowed = true;
      setOverflowError(
        new Error(`agent output exceeded the ${maxBufferBytes}-byte combined capture limit`),
      );
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      return;
    }
    budget.bytes = nextSize;
    chunks.push(data);
  });
}

/**
 * Capture one agent dispatch while the shared sandbox exec supervisor forwards
 * host termination signals to OpenShell and waits for the child to exit.
 */
export async function runAgentDispatch(
  binary: string,
  args: readonly string[],
  options: {
    maxBufferBytes?: number;
    stdinIsTty?: boolean;
  } = {},
  deps: AgentDispatchRunDeps = {},
): Promise<AgentDispatchResult> {
  const stderrChunks: Buffer[] = [];
  const stdoutChunks: Buffer[] = [];
  const captureBudget: AgentDispatchCaptureBudget = { bytes: 0, overflowed: false };
  let overflowError: Error | undefined;
  const maxBufferBytes = options.maxBufferBytes ?? DEFAULT_AGENT_DISPATCH_MAX_BUFFER_BYTES;
  const spawnChild = deps.spawnChild ?? defaultAgentDispatchSpawner;
  const result = await runSandboxExecChild(
    binary,
    args,
    { tty: false },
    (runBinary, runArgs) => {
      const child = spawnChild(
        runBinary,
        runArgs,
        agentDispatchStdio(options.stdinIsTty ?? isStdinTty()),
      );
      const setOverflowError = (error: Error) => {
        overflowError ??= error;
      };
      captureAgentDispatchStream(
        child.stdout,
        child,
        stdoutChunks,
        maxBufferBytes,
        captureBudget,
        setOverflowError,
      );
      captureAgentDispatchStream(
        child.stderr,
        child,
        stderrChunks,
        maxBufferBytes,
        captureBudget,
        setOverflowError,
      );
      return child;
    },
    deps.signalSource,
  );
  try {
    return {
      status: result.status,
      signal: result.signal,
      ...(result.error || overflowError ? { error: result.error ?? overflowError } : {}),
      stderr: Buffer.concat(stderrChunks).toString("utf-8"),
      stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
    };
  } finally {
    result.releaseSignals?.();
  }
}

/**
 * Stdio for a non-interactive agent dispatch. An interactive terminal is
 * withheld from fd 0; a genuine pipe or redirect is still forwarded so
 * scripted stdin keeps working.
 */
export function agentDispatchStdio(stdinIsTty: boolean = isStdinTty()): StdioOptions {
  return [stdinIsTty ? "ignore" : "inherit", "pipe", "pipe"];
}

/**
 * True when the exec transport reported success but produced no bytes at all.
 * Requires both streams to be empty so a quiet-but-real turn (any banner,
 * warning, or reply) is never misread as an empty dispatch.
 */
export function isSilentAgentDispatch(
  result: AgentDispatchOutcome,
  stdout: string,
  stderr: string,
): boolean {
  return !result.error && result.status === 0 && stdout.length === 0 && stderr.length === 0;
}

/**
 * Exit code for a turn whose deadline fired without producing a result.
 * Matches the wrapper's other non-recoverable dispatch failures.
 */
export const TIMED_OUT_AGENT_TURN_EXIT_CODE = 1;

/**
 * The sentence OpenClaw prints when a turn's deadline fires.
 *
 * Read from the OpenClaw 2026.7.1 bundle, where it is a single string literal
 * in one file, and observed verbatim on stdout, sometimes below tool-failure
 * lines. Only the invariant clause is matched so the configuration advice that
 * follows it can be reworded upstream without disabling the guard.
 */
const OPENCLAW_AGENT_TIMEOUT_PATTERN =
  /(?:^|\r?\n)Request timed out before a response was generated[^\r\n]*(?:\r?\n)?$/i;

/**
 * True when the captured output reports that the turn's deadline fired.
 *
 * Text is the only evidence the non-JSON transport has. OpenClaw writes the
 * report as the final line, so matching that position avoids treating a normal
 * reply that quotes or explains the sentence as a timeout. Callers gate on an
 * otherwise successful exit, so an upstream non-zero code is never rewritten.
 */
export function isTimedOutAgentDispatch(stdout: string, stderr: string): boolean {
  return OPENCLAW_AGENT_TIMEOUT_PATTERN.test(stdout) || OPENCLAW_AGENT_TIMEOUT_PATTERN.test(stderr);
}

/** Documented `openclaw agent` options that consume the next argv element. */
export const OPENCLAW_AGENT_VALUE_FLAGS = new Set([
  "-a",
  "--agent",
  "-m",
  "--message",
  "--model",
  "--provider",
  "--reply-channel",
  "--session-id",
  "--session-key",
  "--thinking",
  "--timeout",
  "--to",
]);

/** Documented `openclaw agent` options that consume no argv element. */
export const OPENCLAW_AGENT_BOOLEAN_FLAGS = new Set(["--deliver"]);

/**
 * Extra seconds added to a requested `--timeout` before the host transport
 * stops waiting.
 *
 * The in-sandbox turn owns the deadline and answers first while it can still
 * write to stderr: it reports the timeout, names the config key, and exits.
 * Only a turn that stops answering reaches the host bound, so the extra seconds
 * must outlast an ordinary late finish.
 *
 * This value is a choice, not a derivation. #8723 timed five aborted runs
 * finishing 0.1 s to 20.8 s after their deadline, and four further aborted runs
 * recorded no finish at all, so no measurement establishes an upper bound.
 * Below roughly five seconds the host truncates the turn's own timeout report;
 * above roughly a minute the host bound no longer catches a turn that stops
 * answering. Thirty is inside that range and above every post-deadline finish
 * #8723 recorded. Choose another value inside that range if a slower model or a
 * busier host requires it.
 */
export const AGENT_DISPATCH_DEADLINE_BUFFER_SECONDS = 30;

/**
 * The `--timeout` an `openclaw agent` argv requests, or null when the argv
 * requests none.
 *
 * Mirrors the documented flag grammar only far enough to read one value.
 * Anything unrecognized, malformed, or past a `--` terminator returns null so
 * the host keeps the wait unbounded rather than shortening a turn without
 * evidence. `--timeout 0` disables the deadline upstream and returns null here
 * for the same reason.
 */
export function requestedAgentTimeoutSeconds(argv: readonly string[]): number | null {
  if (argv[0] !== "openclaw" || argv[1] !== "agent") return null;
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (arg === "--") return null;
    if (arg === "--timeout") return parseDeadlineSeconds(argv[index + 1]);
    if (arg.startsWith("--timeout=")) return parseDeadlineSeconds(arg.slice("--timeout=".length));
    if (OPENCLAW_AGENT_VALUE_FLAGS.has(arg)) {
      index += 1;
      continue;
    }
    const equalsIndex = arg.indexOf("=");
    if (
      equalsIndex > 0 &&
      arg.startsWith("--") &&
      OPENCLAW_AGENT_VALUE_FLAGS.has(arg.slice(0, equalsIndex))
    ) {
      continue;
    }
    if (
      arg === "--json" ||
      arg.startsWith("--json=") ||
      OPENCLAW_AGENT_BOOLEAN_FLAGS.has(arg)
    ) {
      continue;
    }
    return null;
  }
  return null;
}

function parseDeadlineSeconds(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const seconds = Number(raw);
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : null;
}

/**
 * The host transport deadline for an `openclaw agent` argv, or undefined when
 * the argv requested none. Undefined leaves `openshell sandbox exec` on its own
 * default, which is no timeout.
 *
 * A requested deadline near the safe-integer ceiling stays unbounded rather
 * than becoming a bound the host cannot represent. Past that ceiling the buffer
 * addition rounds, so the wait would silently differ from the number written to
 * the command line. That matches how this module treats every other value it
 * cannot read.
 */
export function agentDispatchDeadlineSeconds(argv: readonly string[]): number | undefined {
  const requested = requestedAgentTimeoutSeconds(argv);
  if (requested === null) return undefined;
  const deadline = requested + AGENT_DISPATCH_DEADLINE_BUFFER_SECONDS;
  return Number.isSafeInteger(deadline) ? deadline : undefined;
}
