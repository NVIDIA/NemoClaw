// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const OPENSHELL_GATEWAY_USER_SERVICE = "openshell-gateway";

export interface OpenShellGatewayUserServiceOptions {
  commandExists?: (command: string) => boolean;
  env?: NodeJS.ProcessEnv;
  existsSync?: (filePath: string) => boolean;
  platform?: NodeJS.Platform;
  prepareServiceEnv?: () => void;
  spawnSyncImpl?: SpawnSyncLike;
}

export interface OpenShellGatewayUserServiceStartResult {
  attempted: boolean;
  fallbackAllowed: boolean;
  reason?: string;
  started: boolean;
}

export interface OpenShellGatewayUserServiceStopResult {
  attempted: boolean;
  reason?: string;
  stopped: boolean;
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

interface OpenShellGatewayUserServiceIdentity {
  execStart: string;
  fragmentPath: string;
}

export function getOpenShellGatewayUserServicePaths(): string[] {
  return [
    "/usr/local/lib/systemd/user/openshell-gateway.service",
    "/usr/lib/systemd/user/openshell-gateway.service",
    "/lib/systemd/user/openshell-gateway.service",
  ];
}

export function getOpenShellGatewayUserServiceBinaryPaths(): string[] {
  return ["/usr/local/bin/openshell-gateway", "/usr/bin/openshell-gateway"];
}

export function hasOpenShellGatewayUserService(
  opts: Pick<OpenShellGatewayUserServiceOptions, "existsSync" | "platform"> = {},
): boolean {
  if ((opts.platform ?? process.platform) !== "linux") return false;
  const existsSync = opts.existsSync ?? fs.existsSync;
  return getOpenShellGatewayUserServicePaths().some((candidate) => existsSync(candidate));
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
  return /Failed to connect to bus|No medium found|XDG_RUNTIME_DIR|System has not been booted|Host is down/i.test(
    reason,
  );
}

function runSystemctlUser(
  args: string[],
  opts: Required<Pick<OpenShellGatewayUserServiceOptions, "env" | "spawnSyncImpl">>,
): { ok: boolean; reason?: string; stdout?: string } {
  const result = opts.spawnSyncImpl("systemctl", ["--user", ...args], {
    encoding: "utf-8",
    env: opts.env,
    stdio: ["ignore", "pipe", "pipe"],
  } satisfies SpawnSyncOptions);
  if (result.error) {
    return { ok: false, reason: result.error.message };
  }
  if (result.status !== 0) {
    const detail =
      text(result.stderr).trim() || text(result.stdout).trim() || `exit ${String(result.status)}`;
    return { ok: false, reason: detail };
  }
  return { ok: true, stdout: text(result.stdout) };
}

function parseSystemctlShowProperties(output: string): Record<string, string> {
  const properties: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    properties[line.slice(0, separator)] = line.slice(separator + 1).trim();
  }
  return properties;
}

function isTrustedOpenShellGatewayUserServiceIdentity(
  identity: OpenShellGatewayUserServiceIdentity,
): boolean {
  const fragmentPath = path.normalize(identity.fragmentPath.trim());
  const trustedUnit = getOpenShellGatewayUserServicePaths().some(
    (candidate) => path.normalize(candidate) === fragmentPath,
  );
  if (!trustedUnit) return false;
  const execStartPath = extractSystemdExecStartPath(identity.execStart);
  if (!execStartPath) return false;
  const normalizedExecStartPath = path.normalize(execStartPath);
  return getOpenShellGatewayUserServiceBinaryPaths().some(
    (candidate) => path.normalize(candidate) === normalizedExecStartPath,
  );
}

function extractSystemdExecStartPath(execStart: string): string | null {
  const pathMatch = /(?:^|[\s;])path=([^\s;]+)/.exec(execStart);
  if (!pathMatch) return null;
  const execStartPath = pathMatch[1]?.trim();
  return execStartPath && path.isAbsolute(execStartPath) ? execStartPath : null;
}

function readTrustedOpenShellGatewayUserServiceIdentity(
  opts: Required<Pick<OpenShellGatewayUserServiceOptions, "env" | "spawnSyncImpl">>,
): { fallbackAllowed: boolean; ok: boolean; reason?: string } {
  const result = runSystemctlUser(
    ["show", OPENSHELL_GATEWAY_USER_SERVICE, "--property=FragmentPath", "--property=ExecStart"],
    opts,
  );
  if (!result.ok) {
    return {
      fallbackAllowed: userManagerLooksUnavailable(result.reason ?? ""),
      ok: false,
      reason: `systemctl --user show ${OPENSHELL_GATEWAY_USER_SERVICE} failed: ${result.reason}`,
    };
  }

  const properties = parseSystemctlShowProperties(result.stdout ?? "");
  const identity = {
    execStart: properties.ExecStart ?? "",
    fragmentPath: properties.FragmentPath ?? "",
  };
  if (!identity.fragmentPath || !identity.execStart) {
    return {
      fallbackAllowed: true,
      ok: false,
      reason: "service identity is incomplete",
    };
  }
  if (!isTrustedOpenShellGatewayUserServiceIdentity(identity)) {
    return {
      fallbackAllowed: true,
      ok: false,
      reason: `service identity is not the package-managed OpenShell gateway (${identity.fragmentPath})`,
    };
  }
  return { fallbackAllowed: false, ok: true };
}

export function stopOpenShellGatewayUserService(
  opts: Omit<OpenShellGatewayUserServiceOptions, "prepareServiceEnv"> = {},
): OpenShellGatewayUserServiceStopResult {
  const platform = opts.platform ?? process.platform;
  if (platform !== "linux") {
    return { attempted: false, stopped: false, reason: "not a Linux host" };
  }
  const existsSync = opts.existsSync ?? fs.existsSync;
  if (!hasOpenShellGatewayUserService({ existsSync, platform })) {
    return { attempted: false, stopped: false, reason: "service unit not installed" };
  }

  const env = opts.env ?? process.env;
  const commandExists = opts.commandExists ?? ((command) => defaultCommandExists(command, env));
  if (!commandExists("systemctl")) {
    return { attempted: true, stopped: false, reason: "systemctl is not available" };
  }

  const spawnSyncImpl = opts.spawnSyncImpl ?? spawnSync;
  const identity = readTrustedOpenShellGatewayUserServiceIdentity({ env, spawnSyncImpl });
  if (!identity.ok) {
    return { attempted: true, stopped: false, reason: identity.reason };
  }

  const result = runSystemctlUser(["stop", OPENSHELL_GATEWAY_USER_SERVICE], {
    env,
    spawnSyncImpl,
  });
  if (!result.ok) {
    return {
      attempted: true,
      stopped: false,
      reason: `systemctl --user stop ${OPENSHELL_GATEWAY_USER_SERVICE} failed: ${result.reason}`,
    };
  }

  return { attempted: true, stopped: true };
}

export function startOpenShellGatewayUserService(
  opts: OpenShellGatewayUserServiceOptions = {},
): OpenShellGatewayUserServiceStartResult {
  const platform = opts.platform ?? process.platform;
  if (platform !== "linux") {
    return { attempted: false, fallbackAllowed: true, started: false, reason: "not a Linux host" };
  }
  const existsSync = opts.existsSync ?? fs.existsSync;
  if (!hasOpenShellGatewayUserService({ existsSync, platform })) {
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
  for (const args of [["daemon-reload"]]) {
    const result = runSystemctlUser(args, { env, spawnSyncImpl });
    if (!result.ok) {
      const reason = `systemctl --user ${args.join(" ")} failed: ${result.reason}`;
      return {
        attempted: true,
        fallbackAllowed: userManagerLooksUnavailable(result.reason ?? ""),
        reason,
        started: false,
      };
    }
  }

  const identity = readTrustedOpenShellGatewayUserServiceIdentity({ env, spawnSyncImpl });
  if (!identity.ok) {
    return {
      attempted: true,
      fallbackAllowed: identity.fallbackAllowed,
      reason: identity.reason,
      started: false,
    };
  }

  try {
    opts.prepareServiceEnv?.();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      attempted: true,
      fallbackAllowed: false,
      reason: `failed to prepare OpenShell gateway service environment: ${detail}`,
      started: false,
    };
  }

  for (const args of [
    ["enable", OPENSHELL_GATEWAY_USER_SERVICE],
    ["restart", OPENSHELL_GATEWAY_USER_SERVICE],
  ]) {
    const result = runSystemctlUser(args, { env, spawnSyncImpl });
    if (!result.ok) {
      const reason = `systemctl --user ${args.join(" ")} failed: ${result.reason}`;
      return {
        attempted: true,
        fallbackAllowed: userManagerLooksUnavailable(result.reason ?? ""),
        reason,
        started: false,
      };
    }
  }

  return { attempted: true, fallbackAllowed: false, started: true };
}
