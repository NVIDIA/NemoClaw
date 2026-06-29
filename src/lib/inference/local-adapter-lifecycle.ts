// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { waitUntilAsync } from "../core/wait";

export type JsonObject = Record<string, unknown>;

export type RunCaptureFn = (
  args: string[],
  options?: { ignoreError?: boolean; suppressOutput?: boolean },
) => unknown;

export type RunFn = (
  args: string[],
  options?: { ignoreError?: boolean; suppressOutput?: boolean },
) => unknown;

export const DEFAULT_LOCAL_ADAPTER_STATE_DIR = path.join(os.homedir(), ".nemoclaw");

export function ensureLocalAdapterStateDir(stateDir = DEFAULT_LOCAL_ADAPTER_STATE_DIR): void {
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  }
  // Tighten permissions in case the directory was created with a lax umask.
  try {
    const stat = fs.statSync(stateDir);
    if ((stat.mode & 0o077) !== 0) {
      fs.chmodSync(stateDir, 0o700);
    }
  } catch {
    // Best effort — stat/chmod may fail on non-POSIX or read-only fs.
  }
}

function ensureParentDir(filePath: string): void {
  ensureLocalAdapterStateDir(path.dirname(filePath));
}

export function writeLocalAdapterSecretFile(filePath: string, value: string): void {
  ensureParentDir(filePath);
  fs.writeFileSync(filePath, `${value}\n`, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

export function readLocalAdapterTextFile(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, "utf8").trim() || null;
  } catch {
    return null;
  }
}

export function writeLocalAdapterJsonFile(filePath: string, value: unknown): void {
  ensureParentDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

export function appendLocalAdapterJsonLine(filePath: string, value: unknown): void {
  ensureParentDir(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

export function readLocalAdapterJsonFile(filePath: string): JsonObject | null {
  const raw = readLocalAdapterTextFile(filePath);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : null;
  } catch {
    return null;
  }
}

export function removeLocalAdapterFile(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    /* best-effort cleanup */
  }
}

export function persistLocalAdapterPid(filePath: string, pid: number | null | undefined): void {
  if (!Number.isInteger(pid) || !pid || pid <= 0) return;
  writeLocalAdapterSecretFile(filePath, String(pid));
}

export function loadLocalAdapterPid(filePath: string): number | null {
  const raw = readLocalAdapterTextFile(filePath);
  if (!raw) return null;
  const pid = Number.parseInt(raw, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export function isLocalAdapterProcess(
  pid: number | null | undefined,
  processNeedle: string,
  runCapture: RunCaptureFn,
): boolean {
  if (!Number.isInteger(pid) || !pid || pid <= 0) return false;
  const cmdline = runCapture(["ps", "-p", String(pid), "-o", "args="], { ignoreError: true });
  return Boolean(String(cmdline || "").includes(processNeedle));
}

export function killLocalAdapterPid(options: {
  pidPath: string;
  processNeedle: string;
  run: RunFn;
  runCapture: RunCaptureFn;
}): void {
  const persistedPid = loadLocalAdapterPid(options.pidPath);
  if (isLocalAdapterProcess(persistedPid, options.processNeedle, options.runCapture)) {
    options.run(["kill", String(persistedPid)], { ignoreError: true, suppressOutput: true });
  }
  removeLocalAdapterFile(options.pidPath);
}

export function spawnDetachedNodeAdapter(options: {
  scriptPath: string;
  env: Record<string, string>;
  buildEnv: (extraEnv?: Record<string, string>) => NodeJS.ProcessEnv;
}): ChildProcess {
  const child = spawn(process.execPath, [options.scriptPath], {
    detached: true,
    stdio: "ignore",
    env: options.buildEnv(options.env),
  });
  child.unref();
  return child;
}

export function localAdapterTokenHash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function probeLocalAdapterHealth(options: {
  host: string;
  port: number;
  path?: string;
  timeoutMs?: number;
  expectedTokenHash?: string | null;
  tokenHashField?: string;
}): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: options.host,
        port: options.port,
        path: options.path || "/health",
        method: "GET",
        timeout: options.timeoutMs || 1000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            resolve(false);
            return;
          }
          if (!options.expectedTokenHash) {
            resolve(true);
            return;
          }
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonObject;
            resolve(body[options.tokenHashField || "tokenHash"] === options.expectedTokenHash);
          } catch {
            resolve(false);
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
    req.end();
  });
}

export async function waitForLocalAdapterHealth(
  probe: () => Promise<boolean>,
  options: { attempts?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const attempts = options.attempts || 20;
  const intervalMs = options.intervalMs || 100;
  return waitUntilAsync(probe, {
    initialIntervalMs: intervalMs,
    maxIntervalMs: intervalMs,
    backoffFactor: 1,
    maxAttempts: attempts,
  });
}
