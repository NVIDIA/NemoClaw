// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Source-of-truth boundary for the agent dispatch contract (#8796).
//
// Both `nemoclaw <name> agent` transports capture the child's streams and
// forward its exit code. That makes "the child exited 0" the only success
// signal, so a dispatch that never ran the turn is indistinguishable from a
// turn that ran and answered.
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
//      `buildSandboxExecStdio` applies to every other sandbox exec. The JSON
//      transport has carried the same hard-coded inherit since #5683. The
//      result is a live terminal on fd 0 handed to a dispatch whose stdout
//      and stderr are pipes and whose argv says `--no-tty`.
//    - Source boundary: NemoClaw owns which fds it hands to OpenShell.
//      Forwarding a real pipe stays supported so `printf ... | nemoclaw
//      <name> agent` keeps working; only an interactive terminal is withheld.
//    - Removal condition: drop the TTY carve-out if `openclaw agent` gains a
//      documented interactive stdin mode reachable through this wrapper.
//
// Regression tests: `passthrough-dispatch.test.ts` owns the classifier and the
// stdio shape; `passthrough-help.test.ts` owns the diagnostic text.

import type { StdioOptions } from "node:child_process";

import { isStdinTty } from "../../../core/stdin";

/**
 * Exit code for a dispatch that reported success without delivering a turn.
 * Matches the wrapper's other non-recoverable dispatch failures.
 */
export const SILENT_AGENT_DISPATCH_EXIT_CODE = 1;

/** The subset of a `spawnSync` return the delivery classifier reads. */
export type AgentDispatchOutcome = {
  error?: unknown;
  status: number | null;
};

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
