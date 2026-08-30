// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { GATEWAY_PORT } from "../core/ports";
import {
  resolveGatewayPortFromName,
  resolveGatewayStateDirForPort,
  resolveSandboxGatewayName,
  type SandboxGatewayBinding,
} from "../onboard/gateway-binding";
import type { ReleaseGatewayPortOptions } from "./gateway-port-release";

function isValidPort(value: number | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

/**
 * Parse an operator-set `NEMOCLAW_GATEWAY_PORT` (not the 8080 default).
 * Returns null when unset, empty, or not a usable port integer.
 */
export function resolveExplicitGatewayPortEnv(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.NEMOCLAW_GATEWAY_PORT;
  if (raw === undefined) return null;
  const trimmed = String(raw).trim();
  if (trimmed === "" || !/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return null;
  return parsed;
}

/** True when the operator set a usable NEMOCLAW_GATEWAY_PORT override. */
export function hasExplicitGatewayPortEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveExplicitGatewayPortEnv(env) !== null;
}

export function makeGatewayDebug(env: NodeJS.ProcessEnv): (message: string) => void {
  const enabled = (env.NODE_DEBUG ?? "").includes("nemoclaw:gateway");
  return enabled ? (message: string) => console.error(`[nemoclaw:gateway] ${message}`) : () => {};
}

/**
 * Resolve the selected sandbox's persisted gateway port. Because the caller
 * will signal processes, every missing, unreadable, or invalid named-sandbox
 * binding fails closed instead of falling back to another sandbox's default
 * port. A no-name call and a valid legacy row may still use GATEWAY_PORT.
 */
export function resolveStopGatewayPort(
  options: ReleaseGatewayPortOptions,
  getSandbox: (name: string) => SandboxGatewayBinding | null,
  debug: (message: string) => void = () => {},
  warn: (message: string) => void = () => {},
): number | null {
  if (options.port !== undefined) return isValidPort(options.port) ? options.port : null;
  if (!options.sandboxName) return GATEWAY_PORT;

  let entry: SandboxGatewayBinding | null;
  try {
    entry = getSandbox(options.sandboxName);
  } catch (error) {
    // Source boundary: the registry write path should guarantee readable data.
    // Keep this guard until that path also validates/heals pre-existing rows.
    warn(
      `Registry lookup failed for sandbox ${JSON.stringify(options.sandboxName)}; ` +
        "skipping gateway release. Run with NODE_DEBUG=nemoclaw:gateway for details.",
    );
    debug(
      `registry lookup for sandbox ${JSON.stringify(options.sandboxName)} threw; ` +
        `skipping gateway release: ${(error as Error).message ?? String(error)}`,
    );
    return null;
  }
  if (!entry) return null;

  try {
    return resolveGatewayPortFromName(resolveSandboxGatewayName(entry));
  } catch (error) {
    // Source boundary: onboard/registry writes validate new bindings, but old
    // or tampered rows can still exist. Never coerce one to the default port.
    debug(
      `persisted gateway binding for sandbox ${JSON.stringify(options.sandboxName)} is invalid; ` +
        `skipping gateway release: ${(error as Error).message ?? String(error)}`,
    );
    return null;
  }
}

export function resolveGatewayReleaseStateDir(
  port: number,
  env: NodeJS.ProcessEnv,
  homeDir: string,
): string {
  return resolveGatewayStateDirForPort({
    configured: env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR,
    home: homeDir,
    port,
  });
}
