// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import * as http from "node:http";
import path from "node:path";
import type { Session } from "../state/onboard-session";

export type ModelRouterStopOutcome =
  | "stopped"
  | "not-running"
  | "not-router"
  | "unavailable"
  | "failed";

// Hold the same kernel process identity across graceful shutdown and escalation.
// A reused numeric PID can never redirect either signal to a replacement.
export const MODEL_ROUTER_PIDFD_STOP_SCRIPT = String.raw`
import os
import select
import signal
import sys

if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
    print("unavailable")
    raise SystemExit(0)

pid, port = int(sys.argv[1]), sys.argv[2]
try:
    descriptor = os.pidfd_open(pid)
except ProcessLookupError:
    print("not-running")
    raise SystemExit(0)
except OSError:
    print("unavailable")
    raise SystemExit(0)

try:
    with open(f"/proc/{pid}/cmdline", "rb") as source:
        command = source.read(65537)
    if len(command) > 65536 or (command and not command.endswith(b"\0")):
        print("failed")
        raise SystemExit(0)
    args = [value.decode() for value in command.split(b"\0") if value]
    names = [os.path.basename(value) for value in args[:2]]
    matches_port = any(
        (value == "--port" and args[index + 1:index + 2] == [port])
        or value == "--port=" + port
        for index, value in enumerate(args)
    )
    if "model-router" not in names or "proxy" not in args or not matches_port:
        print("not-router")
        raise SystemExit(0)
    exited = select.poll()
    exited.register(descriptor, select.POLLIN)
    signal.pidfd_send_signal(descriptor, signal.SIGTERM)
    if not exited.poll(3000):
        signal.pidfd_send_signal(descriptor, signal.SIGKILL)
    print("stopped" if exited.poll(1000) else "failed")
except (ProcessLookupError, FileNotFoundError):
    print("not-running")
except Exception:
    # After acquiring the descriptor, never authorize a numeric-PID fallback.
    print("failed")
finally:
    os.close(descriptor)
`;

export function stopModelRouterWithPidfd(pid: number, port: number): ModelRouterStopOutcome {
  if (
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    return "failed";
  }
  if (process.platform !== "linux") return "unavailable";
  try {
    const result = execFileSync(
      "python3",
      ["-I", "-c", MODEL_ROUTER_PIDFD_STOP_SCRIPT, String(pid), String(port)],
      {
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
        maxBuffer: 1024,
      },
    ).trim();
    if (["stopped", "not-running", "not-router", "unavailable"].includes(result)) {
      return result as ModelRouterStopOutcome;
    }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return "unavailable";
    }
    // A timeout may follow delivery of SIGTERM. Do not signal again by PID.
  }
  return "failed";
}

export const ROUTER_HEALTH_TIMEOUT_MS = 3000;

export type ModelRouterProcessOwnershipDeps = {
  isRunning?: (pid: number | null | undefined) => boolean;
  readCommandLine?: (pid: number) => string[] | null;
};

export type StopModelRouterProcessDeps = ModelRouterProcessOwnershipDeps & {
  isResponsive?: (port: number, timeoutMs?: number) => Promise<boolean>;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (delayMs: number) => Promise<void>;
  stopWithHandle?: (pid: number, port: number) => ModelRouterStopOutcome;
};

type ModelRouterCommandLineReaderDeps = {
  readProcCommandLine?: (pid: number) => string[] | null;
  readPsCommandLine?: (pid: number) => string[] | null;
  /** Override the /proc PID enumeration (injectable for tests). */
  listProcPids?: () => number[];
};

export type ModelRouterProcessLookup =
  | { status: "found"; pid: number }
  | { status: "absent" }
  | { status: "unavailable" };

export type RouterHealthSnapshot = {
  healthy: boolean;
  body: string | null;
  capturedBodyBytes: number;
  elapsedMs: number;
  outcome: "complete" | "timeout" | "transport_error" | "body_limit" | "aborted";
  statusCode: number | null;
};

const ROUTER_HEALTH_BODY_MAX_BYTES = 64 * 1024;

/**
 * Fetch semantic /health and keep a bounded body for diagnosis. LiteLLM
 * probes every upstream endpoint for this request, so callers must allow the
 * upstream checks to finish and must not overlap observations. The timeout is
 * a wall-clock deadline, not a socket idle timeout.
 */
export async function getRouterHealthSnapshot(
  port: number,
  timeoutMs = ROUTER_HEALTH_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<RouterHealthSnapshot> {
  return new Promise<RouterHealthSnapshot>((resolve) => {
    const startedAt = performance.now();
    let settled = false;
    const chunks: Buffer[] = [];
    let size = 0;
    let bodyLimitExceeded = false;
    let statusCode: number | null = null;
    const bufferedBody = () => (chunks.length > 0 ? Buffer.concat(chunks).toString("utf8") : null);
    const settle = (outcome: RouterHealthSnapshot["outcome"]) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal?.removeEventListener("abort", abortRequest);
      resolve({
        healthy:
          outcome === "complete" && statusCode !== null && statusCode >= 200 && statusCode < 300,
        body: bufferedBody(),
        capturedBodyBytes: size,
        elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
        outcome,
        statusCode,
      });
    };
    const request = http
      .get(`http://127.0.0.1:${port}/health`, (res: http.IncomingMessage) => {
        statusCode = res.statusCode ?? null;
        res.on("data", (chunk: Buffer) => {
          const remaining = ROUTER_HEALTH_BODY_MAX_BYTES - size;
          const kept = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
          if (kept.length > 0) {
            chunks.push(kept);
            size += kept.length;
          }
          if (chunk.length > remaining) bodyLimitExceeded = true;
        });
        res.on("end", () => settle(bodyLimitExceeded ? "body_limit" : "complete"));
        res.on("error", () => settle("transport_error"));
      })
      .on("error", () => settle("transport_error"));
    const deadline = setTimeout(() => {
      request.destroy();
      settle("timeout");
    }, timeoutMs);
    deadline.unref?.();
    const abortRequest = () => {
      request.destroy();
      settle("aborted");
    };
    if (signal?.aborted) abortRequest();
    else signal?.addEventListener("abort", abortRequest, { once: true });
  });
}

/** Check the cheap LiteLLM liveness route without running upstream model probes. */
export async function isRouterResponsive(
  port: number,
  timeoutMs = ROUTER_HEALTH_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const settle = (healthy: boolean) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      resolve(healthy);
    };
    const request = http
      .get(`http://127.0.0.1:${port}/health/liveliness`, (res: http.IncomingMessage) => {
        res.resume();
        settle((res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300);
        request.destroy();
      })
      .on("error", () => settle(false));
    deadline = setTimeout(() => {
      request.destroy();
      settle(false);
    }, timeoutMs);
    deadline.unref?.();
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
 * Stop the owned Model Router and require its liveness endpoint to stop responding.
 * Linux verifies exit through a held kernel process handle. Without that handle,
 * the fallback requires the numeric PID to stop reporting as running; ownership
 * validation and SIGTERM delivery can still race PID reuse on that path. Never
 * send SIGKILL without a PID-stable handle.
 */
export async function stopModelRouterProcess(
  pid: number,
  port: number,
  deps: StopModelRouterProcessDeps = {},
): Promise<void> {
  const isRunning = deps.isRunning ?? isProcessRunning;
  const readCommandLine = deps.readCommandLine ?? readModelRouterProcessCommandLine;
  const isResponsive = deps.isResponsive ?? isRouterResponsive;
  const kill = deps.kill ?? ((targetPid, signal) => process.kill(targetPid, signal));
  const sleep =
    deps.sleep ?? ((delayMs) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));

  if (!isRunning(pid)) {
    if (!(await isResponsive(port, 1000))) return;
    throw new Error(
      `NemoClaw refuses to replace the Model Router: recorded PID ${pid} no longer reports as running but port ${port} remains responsive.`,
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

  const stopWithHandle =
    deps.stopWithHandle ?? (deps.kill ? () => "unavailable" : stopModelRouterWithPidfd);
  const handled = stopWithHandle(pid, port);
  if (handled !== "unavailable") {
    if (handled !== "stopped" && handled !== "not-running") {
      throw new Error(`Model Router identity-bound shutdown failed for PID ${pid}: ${handled}.`);
    }
    if (!(await isResponsive(port, 1000))) return;
    throw new Error(`Model Router stopped, but port ${port} remains responsive.`);
  }

  try {
    kill(pid, "SIGTERM");
  } catch (error) {
    if (!isRunning(pid) && !(await isResponsive(port, 1000))) return;
    throw new Error(
      `NemoClaw could not send SIGTERM to Model Router PID ${pid}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  for (let _attempt = 0; _attempt < 10; _attempt++) {
    await sleep(500);
    if (!isRunning(pid) && !(await isResponsive(port, 1000))) return;
  }

  if (!isRunning(pid)) {
    throw new Error(
      `Model Router PID ${pid} no longer reports as running after SIGTERM, but port ${port} remains responsive.`,
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
 * Used by reconcileModelRouter and destroy to recover orphaned routers whose
 * PID was not recorded in the matching session. The result distinguishes a
 * completed scan with no match from an unavailable process inventory so
 * teardown does not erase recovery identity on inconclusive evidence.
 */
export function inspectModelRouterProcessForPort(
  port: number,
  deps: ModelRouterCommandLineReaderDeps = {},
): ModelRouterProcessLookup {
  let pids: number[];
  try {
    if (deps.listProcPids) {
      pids = deps.listProcPids();
    } else {
      pids = fs
        .readdirSync("/proc")
        .map(Number)
        .filter((n) => Number.isFinite(n) && n > 0);
    }
  } catch {
    return { status: "unavailable" };
  }
  const readCmdLine = deps.readProcCommandLine ?? readProcCommandLine;
  for (const pid of pids) {
    const args = readCmdLine(pid);
    if (args && isModelRouterCommandLineForPort(args, port)) return { status: "found", pid };
  }
  return { status: "absent" };
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
