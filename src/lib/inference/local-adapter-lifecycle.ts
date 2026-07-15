// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type ChildProcess, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { GATEWAY_PORT } from "../core/ports";
import { waitUntilAsync } from "../core/wait";
import { rejectSymlinksOnPath } from "../state/config-io";
import { nemoclawStateRoot } from "../state/state-root";

export type JsonObject = Record<string, unknown>;

export type RunCaptureFn = (
  args: string[],
  options?: { ignoreError?: boolean; suppressOutput?: boolean },
) => unknown;

export type RunFn = (
  args: string[],
  options?: { ignoreError?: boolean; suppressOutput?: boolean },
) => unknown;

export type LocalAdapterProcessMatcher = string | RegExp | ((commandLine: string) => boolean);

export const DEFAULT_LOCAL_ADAPTER_STATE_DIR = nemoclawStateRoot(os.homedir(), GATEWAY_PORT);

export function ensureLocalAdapterStateDir(stateDir = DEFAULT_LOCAL_ADAPTER_STATE_DIR): void {
  rejectSymlinksOnPath(stateDir);
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  }
  rejectSymlinksOnPath(stateDir);
  // Tighten permissions in case the directory was created with a lax umask.
  const stat = fs.lstatSync(stateDir);
  if (!stat.isDirectory()) {
    throw new Error(`Refusing to use local adapter state path: ${stateDir} is not a directory`);
  }
  if ((stat.mode & 0o077) !== 0) {
    fs.chmodSync(stateDir, 0o700);
  }
}

function ensureParentDir(filePath: string): void {
  ensureLocalAdapterStateDir(path.dirname(filePath));
}

function writePrivateLocalAdapterFile(filePath: string, value: string, append = false): void {
  ensureParentDir(filePath);

  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  if (noFollow === 0) {
    try {
      if (fs.lstatSync(filePath).isSymbolicLink()) {
        throw new Error(`Refusing to write local adapter state through symbolic link: ${filePath}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  const flags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    (append ? fs.constants.O_APPEND : fs.constants.O_TRUNC) |
    noFollow |
    (fs.constants.O_NONBLOCK ?? 0);
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, flags, 0o600);
    if (!fs.fstatSync(fd).isFile()) {
      throw new Error(`Refusing to write local adapter state to non-file path: ${filePath}`);
    }
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, value, "utf8");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function writeLocalAdapterSecretFile(filePath: string, value: string): void {
  writePrivateLocalAdapterFile(filePath, `${value}\n`);
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
  writePrivateLocalAdapterFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function appendLocalAdapterJsonLine(filePath: string, value: unknown): void {
  writePrivateLocalAdapterFile(filePath, `${JSON.stringify(value)}\n`, true);
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
  processMatcher: LocalAdapterProcessMatcher,
  runCapture: RunCaptureFn,
): boolean {
  if (!Number.isInteger(pid) || !pid || pid <= 0) return false;
  const commandLine = String(
    runCapture(["ps", "-p", String(pid), "-o", "args="], { ignoreError: true }) || "",
  );
  if (typeof processMatcher === "string") return commandLine.includes(processMatcher);
  return processMatcher instanceof RegExp
    ? processMatcher.test(commandLine)
    : processMatcher(commandLine);
}

export function killLocalAdapterPid(options: {
  pidPath: string;
  processMatcher: LocalAdapterProcessMatcher;
  run: RunFn;
  runCapture: RunCaptureFn;
}): void {
  const persistedPid = loadLocalAdapterPid(options.pidPath);
  if (isLocalAdapterProcess(persistedPid, options.processMatcher, options.runCapture)) {
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
