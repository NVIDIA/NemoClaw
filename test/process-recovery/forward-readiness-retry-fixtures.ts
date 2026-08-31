// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * OpenShell forward-start stubs for the stop-then-start readiness handoff
 * (#10640). The branching lives here so the owning tests stay assertion-only.
 */

import fs from "node:fs";

import { vi } from "vitest";

import * as forwardHealth from "../../src/lib/actions/sandbox/forward-health.js";
import * as openshellRuntime from "../../src/lib/adapters/openshell/runtime.js";

/**
 * The rejection OpenShell 0.0.106 emits during its readiness handoff, in the
 * wrapped box-drawing layout the CLI actually writes.
 */
export const SANDBOX_NOT_READY_DIAGNOSTIC =
  `Error:   \u00d7 code: 'The system is not in a state required for the operation's
   \u2502 execution', message: "sandbox is not ready"
`;

/** The rejection emitted when the spawned ssh child exits before its listener opens. */
export const LISTENER_DIAGNOSTIC = "ssh exited before local forward listener opened";

export interface ForwardStartStubState {
  attempts: number;
  started: boolean;
}

const FORWARD_LIST_HEADER = "SANDBOX  BIND  PORT  PID  STATUS";

function forwardListOutput(owner: string | null, port: number): string {
  return owner === null
    ? FORWARD_LIST_HEADER
    : `${FORWARD_LIST_HEADER}\n${owner}  127.0.0.1  ${port}  12345  running`;
}

function isForwardStart(rawArgs: unknown): boolean {
  const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
  return args[0] === "forward" && args[1] === "start";
}

/** Write OpenShell's rejection to the descriptors the caller supplied. */
function writeDiagnostic(rawOpts: unknown, diagnostic: string): void {
  const stdio = (rawOpts as { stdio?: unknown })?.stdio;
  const handle = Array.isArray(stdio) ? stdio[1] : undefined;
  if (typeof handle !== "number") return;
  fs.writeSync(handle, diagnostic);
}

/**
 * Model a stopped-then-started sandbox: `stop` released the host port, so no
 * local listener exists until OpenShell finishes its readiness handoff and a
 * `forward start` finally succeeds.
 */
export function stubForwardStartFailures(options: {
  diagnostic: string;
  failures: number;
  sandboxName?: string;
  port?: number;
}): ForwardStartStubState {
  const sandboxName = options.sandboxName ?? "beta";
  const port = options.port ?? 18791;
  const state: ForwardStartStubState = { attempts: 0, started: false };

  vi.spyOn(forwardHealth, "isLocalForwardReachable").mockImplementation(() => state.started);
  vi.spyOn(openshellRuntime, "captureOpenshell").mockImplementation(() => ({
    status: 0,
    output: forwardListOutput(state.started ? sandboxName : null, port),
  }));
  vi.spyOn(openshellRuntime, "runOpenshell").mockImplementation(
    (rawArgs: unknown, rawOpts: unknown) => {
      if (!isForwardStart(rawArgs)) return { status: 0 } as never;
      state.attempts += 1;
      if (state.attempts > options.failures) {
        state.started = true;
        return { status: 0 } as never;
      }
      writeDiagnostic(rawOpts, options.diagnostic);
      return { status: 1 } as never;
    },
  );
  return state;
}

/**
 * Model a sibling sandbox binding the same host port while this recovery waits
 * out the readiness handoff. Recovery must fail closed instead of contending.
 */
export function stubForwardStartLostToAnotherSandbox(options: {
  otherSandboxName?: string;
  port?: number;
}): ForwardStartStubState {
  const otherSandboxName = options.otherSandboxName ?? "gamma";
  const port = options.port ?? 18791;
  const state: ForwardStartStubState = { attempts: 0, started: false };

  vi.spyOn(forwardHealth, "isLocalForwardReachable").mockReturnValue(false);
  vi.spyOn(openshellRuntime, "captureOpenshell").mockImplementation(() => ({
    status: 0,
    output: forwardListOutput(state.attempts > 0 ? otherSandboxName : null, port),
  }));
  vi.spyOn(openshellRuntime, "runOpenshell").mockImplementation(
    (rawArgs: unknown, rawOpts: unknown) => {
      if (!isForwardStart(rawArgs)) return { status: 0 } as never;
      state.attempts += 1;
      writeDiagnostic(rawOpts, SANDBOX_NOT_READY_DIAGNOSTIC);
      return { status: 1 } as never;
    },
  );
  return state;
}
