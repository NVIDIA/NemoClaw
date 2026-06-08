// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ProbeContext } from "./types.ts";

/**
 * Shared utilities for built-in probes. Two responsibilities:
 *
 *   1. Entering the sandbox via the canonical bash wrapper
 *      (`validation_suites/sandbox-exec.sh`) instead of re-implementing
 *      the ssh-config / openshell-exec logic in TS. This keeps the
 *      transport choice in ONE place \u2014 if the wrapper changes
 *      (e.g. switches from openshell-exec to ssh-config preferred),
 *      every probe inherits the new behavior.
 *
 *   2. Spawning host-side CLIs (`nemoclaw`, `openshell`) with timeouts
 *      and structured outcome capture. Probes never invoke spawn
 *      directly so timeout and stdio handling stays consistent.
 *
 * Probe code MUST treat the returned `stdout`/`stderr` as already-bounded
 * (we slice the tail). The full output is never returned or logged from
 * here \u2014 evidence files keep the structured fields a probe explicitly
 * decides to persist.
 */

const VALIDATION_SUITES_REL = "test/e2e-scenario/validation_suites";
const TAIL_BYTES = 2048;

export interface CmdResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
}

interface RunOptions {
  /** Hard cap; on expiry the helper SIGTERMs the child and resolves. */
  timeoutMs: number;
  /** stdin payload for `runSandboxCmdStdin`. UTF-8 only. */
  stdin?: string;
  /** Override env. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Override cwd. Defaults to ProbeContext.repoRoot resolution. */
  cwd?: string;
}

function tail(buf: string, max = TAIL_BYTES): string {
  return buf.length <= max ? buf : buf.slice(-max);
}

/**
 * Reject NUL bytes in any string that flows into a child process. Mirrors
 * the defense-in-depth used by src/lib/runner.ts (normalizeSpawnFile /
 * normalizeSpawnArgs) so probe-side spawns enforce the same boundary.
 */
function rejectNulByte(value: string, label: string): string {
  if (value.includes("\u0000")) {
    throw new Error(`${label} must not contain NUL bytes`);
  }
  return value;
}

/**
 * Spawn a bash script and capture the result. Internal helper used by
 * the sandbox-cmd path; not exported because direct bash spawning by
 * probes invites the same drift the canonical wrapper exists to
 * prevent.
 *
 * Contract that addresses CodeQL js/shell-command-injection-from-environment:
 *
 *   1. The `script` parameter is always a string LITERAL at every call
 *      site — callers do not interpolate user-controlled data into
 *      the script body.
 *   2. `bashArgs` carry all variable data and reach the script via
 *      bash positional parameters ($1, $2, ...). Bash treats positional
 *      argv as data, not code, so the values bypass parser expansion.
 *   3. Every string in `bashArgs` is NUL-byte-rejected here — NUL is
 *      the only byte process-spawn cannot survive cleanly.
 *   4. The bash binary path is hard-coded; `shell: false` is implicit
 *      because spawn() does not enable a shell when given an explicit
 *      argv array.
 *
 * The lgtm suppression below is justified by this contract; it mirrors
 * the established pattern in src/lib/runner.ts where the same rule is
 * suppressed for argv arrays passed through `bash -c`.
 */
function spawnBash(
  script: string,
  opts: RunOptions,
  bashArgs: readonly string[] = [],
): Promise<CmdResult> {
  const safeArgs = bashArgs.map((arg, idx) =>
    rejectNulByte(String(arg), `spawnBash: bashArgs[${idx + 1}]`),
  );
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    // bash -c reserves the first positional after the script for $0;
    // a fixed sentinel keeps the script's own $1..$N aligned with the
    // caller-supplied bashArgs. Spawn safety contract is documented on
    // spawnBash above (literal script body, NUL-validated positional
    // argv, hard-coded bash binary). The lgtm marker MUST be the line
    // immediately preceding the spawn() call so CodeQL/LGTM picks it up.
    // lgtm[js/shell-command-injection-from-environment]
    const child = spawn("bash", ["-c", script, "e2e-probe-spawn", ...safeArgs], {
      env: opts.env ?? process.env,
      cwd: opts.cwd,
      stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const onTimeout = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }, opts.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = tail(stdout + chunk.toString("utf8"));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = tail(stderr + chunk.toString("utf8"));
    });
    if (opts.stdin !== undefined && child.stdin) {
      child.stdin.end(opts.stdin);
    }
    child.on("error", (err) => {
      clearTimeout(onTimeout);
      resolve({
        exitCode: 127,
        signal: null,
        stdout,
        stderr: tail(stderr + `spawn error: ${err.message}`),
        elapsedMs: Date.now() - startedAt,
      });
    });
    child.on("close", (code, sig) => {
      clearTimeout(onTimeout);
      resolve({
        exitCode: code,
        signal: sig,
        stdout,
        stderr,
        elapsedMs: Date.now() - startedAt,
      });
    });
  });
}

/**
 * Run a command inside the scenario's sandbox via the canonical
 * `e2e_sandbox_exec` shell wrapper. Picks up the same ssh-config
 * preferred / openshell-exec fallback transport, the per-call
 * timeout, and the classified diagnostic on hang.
 *
 * `args` is treated as a single argv vector by the wrapper. Each
 * element is passed as a positional bash parameter (not
 * interpolated into the script body) so payloads with shell
 * metacharacters survive intact and no user-controlled data flows
 * into the shell command string.
 */
export async function runSandboxCmd(
  ctx: ProbeContext,
  args: readonly string[],
  opts: { timeoutMs?: number; perCallSeconds?: number; stdin?: string } = {},
): Promise<CmdResult> {
  if (!ctx.sandboxName) {
    return {
      exitCode: 1,
      signal: null,
      stdout: "",
      stderr: "runSandboxCmd: ProbeContext.sandboxName is null (E2E_SANDBOX_NAME unset in context.env)",
      elapsedMs: 0,
    };
  }
  const wrapperPath = path.resolve(ctx.repoRoot, VALIDATION_SUITES_REL, "sandbox-exec.sh");
  if (!fs.existsSync(wrapperPath)) {
    return {
      exitCode: 1,
      signal: null,
      stdout: "",
      stderr: `runSandboxCmd: wrapper not found at ${wrapperPath}`,
      elapsedMs: 0,
    };
  }
  const fnName = opts.stdin === undefined ? "e2e_sandbox_exec" : "e2e_sandbox_exec_stdin";
  // Per-call wrapper cap (bash-side timeout); outer node-side cap
  // sits a few seconds above so node always wins and we get a clean
  // CmdResult even if bash hangs mid-output.
  const perCall = opts.perCallSeconds ?? 25;
  const outerMs = opts.timeoutMs ?? perCall * 1000 + 5_000;
  // All user-controlled values (wrapper path from ctx.repoRoot,
  // sandbox name, payload argv) are passed as positional bash
  // parameters rather than interpolated into the script body.
  // Layout: $1=wrapperPath, $2=fnName, $3=sandboxName, $4..$N=argv.
  // CodeQL alert 715 — "shell command built from environment
  // values" — is cleared by this contract because no user data
  // appears in the script string.
  const script = `set -uo pipefail
. "$1"
E2E_SANDBOX_EXEC_TIMEOUT_SECONDS=${perCall} "$2" "$3" -- "\${@:4}"
`;
  return spawnBash(
    script,
    {
      timeoutMs: outerMs,
      stdin: opts.stdin,
      env: { ...process.env, E2E_CONTEXT_DIR: ctx.contextDir },
      cwd: ctx.repoRoot,
    },
    [wrapperPath, fnName, ctx.sandboxName, ...args],
  );
}

/**
 * Spawn a host-side CLI directly. Use for `nemoclaw` / `openshell`
 * commands that operate against the host, not inside the sandbox
 * (e.g. `nemoclaw <sb> shields status`, `openshell policy get`).
 */
export function runHostCmd(
  bin: string,
  args: readonly string[],
  opts: { timeoutMs?: number; cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<CmdResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    const child = spawn(bin, [...args], {
      env: opts.env ?? process.env,
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const onTimeout = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = tail(stdout + chunk.toString("utf8"));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = tail(stderr + chunk.toString("utf8"));
    });
    child.on("error", (err) => {
      clearTimeout(onTimeout);
      resolve({
        exitCode: 127,
        signal: null,
        stdout,
        stderr: tail(stderr + `spawn error: ${err.message}`),
        elapsedMs: Date.now() - startedAt,
      });
    });
    child.on("close", (code, sig) => {
      clearTimeout(onTimeout);
      resolve({
        exitCode: code,
        signal: sig,
        stdout,
        stderr,
        elapsedMs: Date.now() - startedAt,
      });
    });
  });
}

/**
 * Best-effort write of structured probe evidence. Every built-in
 * probe writes its structured outcome to ProbeContext.evidencePath
 * via this helper so the artifact bundle has a uniform JSON layout.
 */
export function writeProbeEvidence(evidencePath: string, payload: unknown): void {
  try {
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    fs.writeFileSync(evidencePath, JSON.stringify(payload, null, 2));
  } catch {
    /* evidence is best-effort; never fail the probe on IO */
  }
}
