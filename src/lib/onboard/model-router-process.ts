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

type ModelRouterCommandLineReaderDeps = {
  readProcCommandLine?: (pid: number) => string[] | null;
  readPsCommandLine?: (pid: number) => string[] | null;
};

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
  const commandName = path.basename(args[0] || "");
  if (commandName !== "model-router") return false;
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

export async function stopModelRouterProcess(pid: number, port: number): Promise<void> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  for (let _attempt = 0; _attempt < 10; _attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (!isProcessRunning(pid) && !(await isRouterHealthy(port, 1000))) return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already stopped
  }
  for (let _attempt = 0; _attempt < 5; _attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (!isProcessRunning(pid) && !(await isRouterHealthy(port, 1000))) return;
  }
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
