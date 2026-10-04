// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChildProcess } from "node:child_process";

import type { ArtifactSink } from "../fixtures/artifacts.ts";
import {
  type ChildProcessProgress,
  spawnObservedChild,
} from "../fixtures/observed-child-process.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";
import { resolveLiveE2eWorkloadSourceEnv } from "../fixtures/shell-probe.ts";
import { dashboardRemoteBindConnectStarted } from "./dashboard-remote-bind-env.ts";

const CONNECT_CAPTURE_LIMIT_BYTES = 1024 * 1024;
const CONNECT_STOP_GRACE_MS = 5_000;

export interface DashboardConnectHandoffResult {
  readonly exitCode: number | null;
  readonly proof: "command-completed" | "forward-started";
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;
}

export interface DashboardConnectHandoffOptions {
  readonly artifacts: ArtifactSink;
  readonly command?: readonly [string, ...string[]];
  readonly env: NodeJS.ProcessEnv;
  readonly progress: ChildProcessProgress;
  readonly sandboxName: string;
  readonly signal?: AbortSignal;
  readonly stopGraceMs?: number;
  readonly timeoutMs: number;
  readonly dashboardPort: string;
  readonly forwardProbe?: () => boolean;
  readonly forwardProbeIntervalMs?: number;
}

function signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch {
    // The child may have exited between the proof callback and cleanup.
  }
}

function signalChildGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (child.pid !== undefined) {
      process.kill(-child.pid, signal);
      return;
    }
  } catch {
    // Fall back to the group leader when the process group is already gone.
  }
  signalChild(child, signal);
}

function appendCaptured(current: string, chunk: string): string {
  const next = current + chunk;
  if (Buffer.byteLength(next, "utf8") > CONNECT_CAPTURE_LIMIT_BYTES) {
    throw new Error("dashboard connect output exceeded the 1 MiB capture limit");
  }
  return next;
}

/**
 * Observe ordinary interactive `connect` until it either finishes normally or
 * proves that forward recovery completed. A proof stops only the connect group
 * leader first: NemoClaw forwards SIGTERM to its attached OpenShell shell,
 * while a correctly backgrounded dashboard forward has already detached its
 * descriptors and remains available for the caller's independent health check.
 */
export async function runDashboardConnectUntilForwardHandoff(
  options: DashboardConnectHandoffOptions,
): Promise<DashboardConnectHandoffResult> {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new RangeError("dashboard connect handoff timeout must be a positive finite value");
  }
  const stopGraceMs = options.stopGraceMs ?? CONNECT_STOP_GRACE_MS;
  if (!Number.isFinite(stopGraceMs) || stopGraceMs <= 0) {
    throw new RangeError("dashboard connect stop grace must be a positive finite value");
  }

  const [command, ...args] = options.command ?? ["nemoclaw", options.sandboxName, "connect"];
  const child = spawnObservedChild(command, args, {
    activityLabel: "command: dashboard-remote-bind-connect",
    progress: options.progress,
    spawn: {
      cwd: REPO_ROOT,
      detached: true,
      env: resolveLiveE2eWorkloadSourceEnv({ ...options.env }),
      stdio: ["ignore", "pipe", "pipe"],
    },
  });

  let stdout = "";
  let stderr = "";
  let forwardProof = false;
  let proofStopRequested = false;
  let deadlineExpired = false;
  let aborted = false;
  let cleanupEscalated = false;
  let captureError: Error | null = null;
  let forceKillTimer: NodeJS.Timeout | undefined;
  let forwardProbeTimer: NodeJS.Timeout | undefined;

  const scheduleForcedCleanup = (): void => {
    if (forceKillTimer) return;
    forceKillTimer = setTimeout(() => {
      cleanupEscalated = true;
      signalChildGroup(child, "SIGKILL");
    }, stopGraceMs);
  };
  const terminateGroup = (): void => {
    signalChildGroup(child, "SIGTERM");
    scheduleForcedCleanup();
  };
  const requestProofStop = (): void => {
    if (proofStopRequested) return;
    proofStopRequested = true;
    signalChild(child, "SIGTERM");
    scheduleForcedCleanup();
  };
  const inspectProof = (): void => {
    if (forwardProof || captureError) return;
    forwardProof = dashboardRemoteBindConnectStarted(
      { exitCode: null, stdout, stderr },
      options.sandboxName,
      options.dashboardPort,
    );
    if (forwardProof) requestProofStop();
  };
  const inspectForwardProbe = (): void => {
    if (forwardProof || captureError || !options.forwardProbe) return;
    try {
      forwardProof = options.forwardProbe();
      if (forwardProof) requestProofStop();
    } catch (error) {
      captureError = error instanceof Error ? error : new Error(String(error));
      terminateGroup();
    }
  };
  const capture = (stream: "stdout" | "stderr", chunk: Buffer | string): void => {
    if (captureError) return;
    try {
      if (stream === "stdout") stdout = appendCaptured(stdout, chunk.toString());
      else stderr = appendCaptured(stderr, chunk.toString());
      inspectProof();
    } catch (error) {
      captureError = error instanceof Error ? error : new Error(String(error));
      terminateGroup();
    }
  };
  child.stdout?.on("data", (chunk: Buffer | string) => capture("stdout", chunk));
  child.stderr?.on("data", (chunk: Buffer | string) => capture("stderr", chunk));
  if (options.forwardProbe) {
    inspectForwardProbe();
    forwardProbeTimer = setInterval(inspectForwardProbe, options.forwardProbeIntervalMs ?? 250);
  }

  const deadline = setTimeout(() => {
    deadlineExpired = true;
    terminateGroup();
  }, options.timeoutMs);
  const abort = (): void => {
    aborted = true;
    terminateGroup();
  };
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });

  let spawnError: Error | null = null;
  child.once("error", (error) => {
    spawnError = error;
  });
  const { exitCode, signal } = await new Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once("close", (code, closeSignal) => resolve({ exitCode: code, signal: closeSignal }));
  });
  clearTimeout(deadline);
  if (forceKillTimer) clearTimeout(forceKillTimer);
  if (forwardProbeTimer) clearInterval(forwardProbeTimer);
  options.signal?.removeEventListener("abort", abort);

  const artifactBase = "dashboard-connect-handoff";
  const artifactPaths = {
    stdout: await options.artifacts.writeText(`${artifactBase}.stdout.txt`, stdout),
    stderr: await options.artifacts.writeText(`${artifactBase}.stderr.txt`, stderr),
  };
  await options.artifacts.writeJson(`${artifactBase}.result.json`, {
    command: [command, ...args],
    exitCode,
    signal,
    deadlineExpired,
    cleanupEscalated,
    forwardProof,
    proofStopRequested,
    stdout: artifactPaths.stdout,
    stderr: artifactPaths.stderr,
  });

  if (spawnError) throw spawnError;
  if (captureError) throw captureError;
  if (aborted) throw new Error("dashboard connect handoff was cancelled");
  if (deadlineExpired) {
    throw new Error("dashboard connect did not complete or prove forward handoff within budget");
  }
  if (forwardProof) {
    if (cleanupEscalated) {
      throw new Error(
        "dashboard connect retained captured descriptors after forward proof and required forced cleanup",
      );
    }
    return { exitCode, proof: "forward-started", signal, stderr, stdout };
  }
  if (exitCode === 0) {
    return { exitCode, proof: "command-completed", signal, stderr, stdout };
  }
  throw new Error(
    `dashboard connect exited before proving forward handoff (exit ${exitCode ?? "unknown"}${signal ? `, signal ${signal}` : ""})`,
  );
}
