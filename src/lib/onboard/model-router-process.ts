// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import * as http from "node:http";
import path from "node:path";
import type { Session } from "../state/onboard-session";

export const ROUTER_HEALTH_TIMEOUT_MS = 3000;

export type ModelRouterProcessOwnershipDeps = {
  isRunning?: (pid: number | null | undefined) => boolean;
  readCommandLine?: (pid: number) => string[] | null;
};

export type StopModelRouterProcessDeps = ModelRouterProcessOwnershipDeps & {
  isHealthy?: (port: number, timeoutMs?: number) => Promise<boolean>;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (delayMs: number) => Promise<void>;
};

type ModelRouterCommandLineReaderDeps = {
  readProcCommandLine?: (pid: number) => string[] | null;
  readPsCommandLine?: (pid: number) => string[] | null;
  /** Override the /proc PID enumeration (injectable for tests). */
  listProcPids?: () => number[];
};

export type RouterHealthSnapshot = {
  healthy: boolean;
  body: string | null;
};

const ROUTER_HEALTH_BODY_MAX_BYTES = 64 * 1024;

/**
 * Fetch /health and keep the response body for diagnosis (#8962). Unlike
 * `isRouterHealthy`, this waits for the body, so callers pass a longer
 * timeout; `startModelRouter` uses 30 seconds. LiteLLM's /health probes
 * every upstream endpoint per request and can answer well after the
 * 3-second liveness budget. The timeout is a wall-clock deadline, not a
 * socket idle timeout, so a responder that trickles bytes cannot hold the
 * caller past it; whatever body arrived by then is returned.
 */
export async function getRouterHealthSnapshot(
  port: number,
  timeoutMs = ROUTER_HEALTH_TIMEOUT_MS,
): Promise<RouterHealthSnapshot> {
  return new Promise<RouterHealthSnapshot>((resolve) => {
    let settled = false;
    const chunks: Buffer[] = [];
    let size = 0;
    let responseHealthy = false;
    const bufferedBody = () => (chunks.length > 0 ? Buffer.concat(chunks).toString("utf8") : null);
    const settle = (snapshot: RouterHealthSnapshot) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(snapshot);
    };
    const request = http
      .get(`http://127.0.0.1:${port}/health`, (res: http.IncomingMessage) => {
        responseHealthy = (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300;
        res.on("data", (chunk: Buffer) => {
          const remaining = ROUTER_HEALTH_BODY_MAX_BYTES - size;
          const kept = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
          chunks.push(kept);
          size += kept.length;
          if (size >= ROUTER_HEALTH_BODY_MAX_BYTES) {
            res.destroy();
            settle({ healthy: responseHealthy, body: bufferedBody() });
          }
        });
        res.on("end", () => settle({ healthy: responseHealthy, body: bufferedBody() }));
        res.on("error", () => settle({ healthy: responseHealthy, body: bufferedBody() }));
      })
      .on("error", () => settle({ healthy: responseHealthy, body: bufferedBody() }));
    const deadline = setTimeout(() => {
      request.destroy();
      settle({ healthy: responseHealthy, body: bufferedBody() });
    }, timeoutMs);
    deadline.unref?.();
  });
}

export async function isRouterHealthy(
  port: number,
  timeoutMs = ROUTER_HEALTH_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (healthy: boolean) => {
      if (settled) return;
      settled = true;
      resolve(healthy);
    };
    const request = http
      .get(`http://127.0.0.1:${port}/health`, (res: http.IncomingMessage) => {
        res.resume();
        settle((res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300);
      })
      .on("error", () => settle(false));
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      settle(false);
    });
  });
}

export function isProcessRunning(pid: number | null | undefined): boolean {
  if (!Number.isInteger(pid) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

export function isModelRouterCommandLineForPort(args: readonly string[], port: number): boolean {
  // model-router may run as a Python venv script, where the OS interposes the
  // interpreter: args[0]=python, args[1]=/path/to/model-router. Check both
  // positions so /proc-based detection works regardless of execution mode.
  const name0 = path.basename(args[0] || "");
  const name1 = path.basename(args[1] || "");
  if (name0 !== "model-router" && name1 !== "model-router") return false;
  if (!args.includes("proxy")) return false;
  return args.some((arg, index) => {
    if (arg === "--port") return args[index + 1] === String(port);
    return arg === `--port=${String(port)}`;
  });
}

function splitCommandLine(commandLine: string): string[] | null {
  const args = commandLine.trim().split(/\s+/).filter(Boolean);
  return args.length > 0 ? args : null;
}

function readProcCommandLine(pid: number): string[] | null {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

function readPsCommandLine(pid: number): string[] | null {
  try {
    const output = execFileSync("ps", ["-p", String(pid), "-o", "args="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    });
    return splitCommandLine(output);
  } catch {
    return null;
  }
}

export function readModelRouterProcessCommandLine(
  pid: number,
  deps: ModelRouterCommandLineReaderDeps = {},
): string[] | null {
  return (
    (deps.readProcCommandLine ?? readProcCommandLine)(pid) ??
    (deps.readPsCommandLine ?? readPsCommandLine)(pid)
  );
}

export function doesModelRouterProcessOwnPort(
  pid: number | null | undefined,
  port: number,
  deps: ModelRouterProcessOwnershipDeps = {},
): boolean {
  if (!Number.isInteger(pid) || Number(pid) <= 0) return false;
  const isRunning = deps.isRunning ?? isProcessRunning;
  if (!isRunning(pid)) return false;
  const readCommandLine = deps.readCommandLine ?? readModelRouterProcessCommandLine;
  const args = readCommandLine(Number(pid));
  return Array.isArray(args) && isModelRouterCommandLineForPort(args, port);
}

/**
 * Stop the recorded Model Router process and return only after its PID no
 * longer reports as running and its health endpoint is not healthy. The
 * session stores a numeric PID, not a PID-stable OS handle. Ownership
 * validation and SIGTERM delivery are separate OS operations, so PID reuse can
 * still redirect SIGTERM. Never send SIGKILL without a PID-stable handle.
 */
export async function stopModelRouterProcess(
  pid: number,
  port: number,
  deps: StopModelRouterProcessDeps = {},
): Promise<void> {
  const isRunning = deps.isRunning ?? isProcessRunning;
  const readCommandLine = deps.readCommandLine ?? readModelRouterProcessCommandLine;
  const isHealthy = deps.isHealthy ?? isRouterHealthy;
  const kill = deps.kill ?? ((targetPid, signal) => process.kill(targetPid, signal));
  const sleep =
    deps.sleep ?? ((delayMs) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));

  if (!isRunning(pid)) {
    if (!(await isHealthy(port, 1000))) return;
    throw new Error(
      `NemoClaw refuses to replace the Model Router: recorded PID ${pid} no longer reports as running but port ${port} remains healthy.`,
    );
  }
  if (
    !doesModelRouterProcessOwnPort(pid, port, {
      isRunning,
      readCommandLine,
    })
  ) {
    throw new Error(
      `NemoClaw refuses to stop PID ${pid}: it is not the model-router proxy for port ${port}.`,
    );
  }

  try {
    kill(pid, "SIGTERM");
  } catch (error) {
    if (!isRunning(pid) && !(await isHealthy(port, 1000))) return;
    throw new Error(
      `NemoClaw could not send SIGTERM to Model Router PID ${pid}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  for (let _attempt = 0; _attempt < 10; _attempt++) {
    await sleep(500);
    if (!isRunning(pid) && !(await isHealthy(port, 1000))) return;
  }

  if (!isRunning(pid)) {
    throw new Error(
      `Model Router PID ${pid} no longer reports as running after SIGTERM, but port ${port} remains healthy.`,
    );
  }
  if (
    !doesModelRouterProcessOwnPort(pid, port, {
      isRunning,
      readCommandLine,
    })
  ) {
    throw new Error(
      `Model Router ownership changed during shutdown for PID ${pid}; NemoClaw did not send an escalation signal.`,
    );
  }
  throw new Error(
    `Model Router shutdown did not converge after SIGTERM. NemoClaw refuses PID-based SIGKILL for PID ${pid} because process identity cannot be preserved atomically.`,
  );
}

/**
 * Scan /proc for a model-router process bound to `port`.
 *
 * Used by reconcileModelRouter to auto-recover orphaned routers whose PID
 * was not recorded in the current session (e.g. after a failed install left a
 * running router and the next session starts fresh). Returns null when /proc
 * is unavailable (macOS) or no matching process is found.
 */
export function findModelRouterPidForPort(
  port: number,
  deps: ModelRouterCommandLineReaderDeps = {},
): number | null {
  let pids: number[];
  if (deps.listProcPids) {
    pids = deps.listProcPids();
  } else {
    try {
      pids = fs
        .readdirSync("/proc")
        .map(Number)
        .filter((n) => Number.isFinite(n) && n > 0);
    } catch {
      return null;
    }
  }
  const readCmdLine = deps.readProcCommandLine ?? readProcCommandLine;
  for (const pid of pids) {
    const args = readCmdLine(pid);
    if (args && isModelRouterCommandLineForPort(args, port)) return pid;
  }
  return null;
}

export async function stopTrackedModelRouterForAgentChange(
  session: Pick<Session, "routerPid"> | null,
  port: number,
  deps: ModelRouterProcessOwnershipDeps & {
    stopProcess?: (pid: number, port: number) => Promise<void>;
  } = {},
): Promise<void> {
  const recordedPid = session?.routerPid ?? null;
  if (!doesModelRouterProcessOwnPort(recordedPid, port, deps)) return;
  await (deps.stopProcess ?? stopModelRouterProcess)(recordedPid as number, port);
}
