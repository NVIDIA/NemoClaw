// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile, spawnSync } from "node:child_process";
import { addAbortListener } from "node:events";
import path from "node:path";
import type { TestContext } from "vitest";
import { ownChildProcess } from "./child-process-lifecycle";
import {
  createHostProcessWorkspace,
  type HostProcessWorkspace,
  trailingJsonPayload,
} from "./host-process-harness";

/**
 * Child-process setup mechanics for onboarding suites that spawn the CLI or a
 * generated scenario script in a real Node process. The harness owns the
 * temporary workspace, fake-bin executables, environment composition, spawn
 * call, and trailing JSON payload extraction. Stub script contents, scenario
 * environment values, and assertions stay in each test. Every helper returns
 * fresh mutable state and touches no parent-process global.
 */

/** The repository root the spawned processes run from. */
export const testRepoRoot = path.join(import.meta.dirname, "..", "..");

/** A disposable workspace holding the spawned process's home and fake bin. */
export type OnboardProcessWorkspace = HostProcessWorkspace;

/** Creation options for createOnboardProcessWorkspace. */
export interface OnboardProcessWorkspaceOptions {
  /** Create HOME as a `home/` directory beside bin instead of the root. */
  separateHome?: boolean;
}

/** Creates a fresh temporary workspace with a created bin directory. */
export function createOnboardProcessWorkspace(
  prefix: string,
  options?: OnboardProcessWorkspaceOptions,
): OnboardProcessWorkspace {
  return createHostProcessWorkspace(prefix, options);
}

/**
 * The inherited-process environment for a workspace: HOME at the workspace
 * home and the fake bin prepended to PATH. Returns a fresh object per call.
 */
export function workspaceEnv(
  workspace: OnboardProcessWorkspace,
  overrides?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return workspace.environment(overrides);
}

/**
 * A minimal spawn environment that inherits nothing but PATH plus the
 * Windows keys Node needs to spawn at all. Returns a fresh object per call.
 */
export function minimalSpawnEnv(home: string, overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: process.env.PATH || "/usr/bin:/bin",
    NO_COLOR: "1",
  };
  for (const key of ["ComSpec", "PATHEXT", "SystemRoot", "WINDIR"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...overrides };
}

/** Spawn options for runOnboardProcess. */
export interface RunOnboardProcessOptions {
  env: NodeJS.ProcessEnv;
  /** Working directory; defaults to the repository root. */
  cwd?: string;
  /** Kill the child after this many milliseconds. */
  timeoutMs?: number;
  /** Signal used when the timeout expires. */
  killSignal?: NodeJS.Signals;
  /** Optional stdin for interactive process fixtures. */
  input?: string;
}

/** The decoded outcome of one spawned process run. */
export interface OnboardProcessResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  error: Error | undefined;
  stdout: string;
  stderr: string;
  /** stdout and stderr joined with a newline. */
  output: string;
}

/** Runs `node <argv...>` synchronously from the repository root. */
export function runOnboardProcess(
  argv: readonly string[],
  options: RunOnboardProcessOptions,
): OnboardProcessResult {
  const result = spawnSync(process.execPath, [...argv], {
    cwd: options.cwd ?? testRepoRoot,
    encoding: "utf-8",
    env: options.env,
    ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
    ...(options.killSignal === undefined ? {} : { killSignal: options.killSignal }),
    ...(options.input === undefined ? {} : { input: options.input }),
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return {
    status: result.status,
    signal: result.signal,
    error: result.error,
    stdout,
    stderr,
    output: `${stdout}\n${stderr}`,
  };
}

/** Runs a Node fixture asynchronously and waits for its pipes to close. */
export function runOnboardProcessAsync(
  argv: readonly string[],
  options: Pick<RunOnboardProcessOptions, "env" | "cwd"> & {
    timeoutMs: number;
    context: Pick<TestContext, "signal" | "onTestFinished">;
  },
): Promise<OnboardProcessResult> {
  return new Promise((resolve) => {
    options.context.signal.throwIfAborted();
    const child = execFile(
      process.execPath,
      [...argv],
      {
        cwd: options.cwd ?? testRepoRoot,
        env: options.env,
        encoding: "utf8",
        timeout: options.timeoutMs,
        killSignal: "SIGKILL",
      },
      (error, stdout, stderr) => {
        // Launch errors can invoke this callback before the child closes.
        void owner.closed.then(() =>
          resolve({
            status: error ? (typeof error.code === "number" ? error.code : null) : 0,
            signal: child.signalCode,
            error: error && typeof error.code !== "number" ? error : undefined,
            stdout,
            stderr,
            output: `${stdout}\n${stderr}`,
          }),
        );
      },
    );
    const owner = ownChildProcess(child);
    options.context.onTestFinished(owner.terminate);
    const abort = addAbortListener(options.context.signal, () => child.kill("SIGKILL"));
    child.once("close", () => abort[Symbol.dispose]());
    child.stdin?.end();
  });
}

/** Runs a generated onboarding script with a bounded hard-kill timeout. */
export function runBoundedOnboardScript(
  scriptPath: string,
  options: Omit<RunOnboardProcessOptions, "killSignal" | "timeoutMs">,
): OnboardProcessResult {
  return runOnboardProcess([scriptPath], { ...options, timeoutMs: 45_000, killSignal: "SIGKILL" });
}

/**
 * Parses the last stdout line that is a JSON object; scenario scripts print
 * their result payload after any incidental logging. Throws with the full
 * stdout when no payload line exists.
 */
export { trailingJsonPayload };
