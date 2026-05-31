// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const OPENSHELL_GATEWAY_USER_SERVICE = "openshell-gateway";

export interface OpenShellGatewayUserServiceOptions {
  commandExists?: (command: string) => boolean;
  env?: NodeJS.ProcessEnv;
  existsSync?: (filePath: string) => boolean;
  homeDir?: string;
  platform?: NodeJS.Platform;
  spawnSyncImpl?: SpawnSyncLike;
}

export interface OpenShellGatewayUserServiceStartResult {
  attempted: boolean;
  fallbackAllowed: boolean;
  reason?: string;
  started: boolean;
}

export interface SpawnSyncLikeResult {
  error?: Error;
  status: number | null;
  stderr?: Buffer | string | null;
  stdout?: Buffer | string | null;
}

export type SpawnSyncLike = (
  command: string,
  args: string[],
  options?: SpawnSyncOptions,
) => SpawnSyncLikeResult;

export function getOpenShellGatewayUserServicePaths(homeDir = os.homedir()): string[] {
  return [
    path.join(homeDir, ".config", "systemd", "user", "openshell-gateway.service"),
    "/etc/systemd/user/openshell-gateway.service",
    "/usr/local/lib/systemd/user/openshell-gateway.service",
    "/usr/lib/systemd/user/openshell-gateway.service",
    "/lib/systemd/user/openshell-gateway.service",
  ];
}

export function hasOpenShellGatewayUserService(
  opts: Pick<OpenShellGatewayUserServiceOptions, "existsSync" | "homeDir" | "platform"> = {},
): boolean {
  if ((opts.platform ?? process.platform) !== "linux") return false;
  const existsSync = opts.existsSync ?? fs.existsSync;
  return getOpenShellGatewayUserServicePaths(opts.homeDir).some((candidate) => existsSync(candidate));
}

function defaultCommandExists(command: string, env: NodeJS.ProcessEnv): boolean {
  return (
    spawnSync("sh", ["-c", 'command -v "$1" >/dev/null 2>&1', "sh", command], {
      encoding: "utf-8",
      env,
    }).status === 0
  );
}

function text(value: Buffer | string | null | undefined): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf-8");
  return "";
}

function userManagerLooksUnavailable(reason: string): boolean {
  return /Failed to connect to bus|No medium found|XDG_RUNTIME_DIR|System has not been booted|Host is down|No such file or directory/i.test(
    reason,
  );
}

function runSystemctlUser(
  args: string[],
  opts: Required<Pick<OpenShellGatewayUserServiceOptions, "env" | "spawnSyncImpl">>,
): { ok: boolean; reason?: string } {
  const result = opts.spawnSyncImpl("systemctl", ["--user", ...args], {
    encoding: "utf-8",
    env: opts.env,
    stdio: ["ignore", "pipe", "pipe"],
  } satisfies SpawnSyncOptions);
  if (result.error) {
    return { ok: false, reason: result.error.message };
  }
  if (result.status !== 0) {
    const detail = text(result.stderr).trim() || text(result.stdout).trim() || `exit ${String(result.status)}`;
    return { ok: false, reason: detail };
  }
  return { ok: true };
}

export function startOpenShellGatewayUserService(
  opts: OpenShellGatewayUserServiceOptions = {},
): OpenShellGatewayUserServiceStartResult {
  const platform = opts.platform ?? process.platform;
  if (platform !== "linux") {
    return { attempted: false, fallbackAllowed: true, started: false, reason: "not a Linux host" };
  }
  const existsSync = opts.existsSync ?? fs.existsSync;
  if (!hasOpenShellGatewayUserService({ existsSync, homeDir: opts.homeDir, platform })) {
    return {
      attempted: false,
      fallbackAllowed: true,
      started: false,
      reason: "service unit not installed",
    };
  }

  const env = opts.env ?? process.env;
  const commandExists = opts.commandExists ?? ((command) => defaultCommandExists(command, env));
  if (!commandExists("systemctl")) {
    return {
      attempted: true,
      fallbackAllowed: true,
      started: false,
      reason: "systemctl is not available",
    };
  }

  const spawnSyncImpl = opts.spawnSyncImpl ?? spawnSync;
  for (const args of [
    ["daemon-reload"],
    ["enable", OPENSHELL_GATEWAY_USER_SERVICE],
    ["restart", OPENSHELL_GATEWAY_USER_SERVICE],
  ]) {
    const result = runSystemctlUser(args, { env, spawnSyncImpl });
    if (!result.ok) {
      const reason = `systemctl --user ${args.join(" ")} failed: ${result.reason}`;
      return {
        attempted: true,
        fallbackAllowed: args[0] === "daemon-reload" && userManagerLooksUnavailable(result.reason ?? ""),
        reason,
        started: false,
      };
    }
  }

  return { attempted: true, fallbackAllowed: false, started: true };
}
