// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type SpawnSyncOptions, spawnSync } from "node:child_process";
import fs from "node:fs";

const LINUX_START_TICKS = /^\d+$/u;

export interface HostProcessIdentity {
  readonly argv: readonly string[];
  readonly startIdentity: string;
}

export interface HostProcessIdentityCommandResult {
  readonly error?: Error;
  readonly status: number | null;
  readonly stderr?: Buffer | string | null;
  readonly stdout?: Buffer | string | null;
}

export type RunHostProcessIdentityCommand = (
  command: string,
  args: string[],
  options?: SpawnSyncOptions,
) => HostProcessIdentityCommandResult;

export type ReadHostProcessFile = (filePath: string, encoding?: BufferEncoding) => Buffer | string;

export interface LinuxHostProcessIdentityOptions {
  readonly readFile?: ReadHostProcessFile;
}

function output(value: Buffer | string | null | undefined): string {
  return typeof value === "string" ? value : Buffer.isBuffer(value) ? value.toString("utf8") : "";
}

function errnoCode(error: unknown): string {
  return error !== null && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : "";
}

/**
 * Read argv plus Linux `/proc/<pid>/stat` field 22 as one canonical process
 * generation identity. Reading stat twice excludes PID reuse across capture.
 */
export function captureLinuxHostProcessIdentity(
  pid: number,
  options: LinuxHostProcessIdentityOptions = {},
): HostProcessIdentity | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const readProcessFile: ReadHostProcessFile =
    options.readFile ??
    ((filePath, encoding) =>
      encoding ? fs.readFileSync(filePath, encoding) : fs.readFileSync(filePath));
  const readStat = (): string | null => {
    let stat: string;
    try {
      stat = String(readProcessFile(`/proc/${String(pid)}/stat`, "utf8"));
    } catch (error) {
      const code = errnoCode(error);
      if (code === "ENOENT" || code === "ESRCH") return null;
      throw new Error(`Failed to read host process stat identity: ${String(error)}`);
    }
    const closeParen = stat.lastIndexOf(")");
    if (closeParen < 0) return null;
    const fields = stat
      .slice(closeParen + 1)
      .trim()
      .split(/\s+/u);
    const startTicks = fields[19];
    return startTicks && LINUX_START_TICKS.test(startTicks)
      ? `linux-proc-start:${startTicks}`
      : null;
  };
  const firstStart = readStat();
  if (firstStart === null) return null;

  let argvBuffer: Buffer;
  try {
    const capturedArgv = readProcessFile(`/proc/${String(pid)}/cmdline`);
    argvBuffer = Buffer.isBuffer(capturedArgv) ? capturedArgv : Buffer.from(capturedArgv, "utf8");
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ENOENT" || code === "ESRCH") return null;
    throw new Error(`Failed to read host process argv identity: ${String(error)}`);
  }
  const argv = argvBuffer.toString("utf8").split("\0");
  if (argv.at(-1) === "") argv.pop();
  if (argv.length === 0 || argv.some((value) => !value)) {
    throw new Error("Host process returned incomplete Linux identity");
  }
  const secondStart = readStat();
  if (secondStart !== firstStart) return null;
  return { argv, startIdentity: firstStart };
}

export function captureDarwinHostProcessIdentity(
  pid: number,
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly run?: RunHostProcessIdentityCommand;
  } = {},
): HostProcessIdentity | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const run = options.run ?? spawnSync;
  const result = run("/bin/ps", ["-ww", "-p", String(pid), "-o", "lstart=", "-o", "command="], {
    encoding: "utf8",
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = output(result.stdout).trim();
  const stderr = output(result.stderr).trim();
  if (!result.error && result.status === 1 && !stdout && !stderr) return null;
  if (result.error || result.status !== 0) {
    const reason = result.error?.message || stderr || `exit ${String(result.status)}`;
    throw new Error(`Failed to read host process identity: ${reason}`);
  }
  const match = /^(\S{3}\s+\S{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/u.exec(stdout);
  if (!match?.[1] || !match[2]) {
    throw new Error("Host process returned incomplete macOS identity");
  }
  // macOS ps exposes the complete serialized argv rather than NUL-delimited entries.
  return { argv: [match[2]], startIdentity: `darwin-lstart:${match[1]}` };
}

export function captureHostProcessIdentity(
  pid: number,
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly platform?: NodeJS.Platform;
    readonly run?: RunHostProcessIdentityCommand;
  } = {},
): HostProcessIdentity | null {
  const platform = options.platform ?? process.platform;
  if (platform === "linux") return captureLinuxHostProcessIdentity(pid);
  if (platform === "darwin") {
    return captureDarwinHostProcessIdentity(pid, {
      env: options.env,
      run: options.run,
    });
  }
  return null;
}
