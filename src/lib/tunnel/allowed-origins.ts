// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type AgentConfigTarget,
  readSandboxConfig,
  resolveAgentConfig,
  setOpenClawConfigValue,
} from "../sandbox/config";
import { resolveSandboxConfigRuntimeSelection } from "../actions/sandbox/mcp-bridge-provider-inspection";
import type { OpenShellRuntimeSelection } from "../adapters/openshell/runtime-selection";
import type { ConfigObject } from "../security/credential-filter";
import { isConfigObject } from "../security/credential-filter";

const TRYCLOUDFLARE_HOST = "trycloudflare.com";

/**
 * Reduce a full tunnel URL (which may carry a path or hash) to an exact
 * `scheme://host[:port]` origin. Returns null for empty input, an unparseable
 * URL, or an opaque origin ("null").
 */
export function tunnelUrlToOrigin(tunnelUrl: string): string | null {
  if (!tunnelUrl) return null;
  try {
    const { origin } = new URL(tunnelUrl);
    return origin && origin !== "null" ? origin : null;
  } catch {
    return null;
  }
}

/** True when the origin's host is trycloudflare.com or a subdomain of it. */
export function isTryCloudflareOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return hostname === TRYCLOUDFLARE_HOST || hostname.endsWith(`.${TRYCLOUDFLARE_HOST}`);
  } catch {
    return false;
  }
}

function normalizeOrigins(existing: unknown): string[] {
  if (!Array.isArray(existing)) return [];
  return existing.filter((entry): entry is string => typeof entry === "string");
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Compute the allowedOrigins list for a tunnel start: drop every existing
 * trycloudflare origin (quick-tunnel URLs churn each start), preserve all other
 * origins in their original order, then append the current tunnel origin.
 * Pure — no I/O. `changed` is false when the result equals the normalized input,
 * so callers can skip the write + gateway reload.
 */
export function computeTunnelAllowedOrigins(
  existing: unknown,
  tunnelUrl: string,
): { origins: string[]; changed: boolean } {
  const normalized = normalizeOrigins(existing);
  const origin = tunnelUrlToOrigin(tunnelUrl);
  if (origin === null) {
    return { origins: normalized, changed: false };
  }

  const result: string[] = [];
  const seen = new Set<string>();
  const addUnique = (value: string): void => {
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  };

  for (const entry of normalized) {
    if (!isTryCloudflareOrigin(entry)) addUnique(entry);
  }
  addUnique(origin);

  return { origins: result, changed: !arraysEqual(result, normalized) };
}

export interface RegisterTunnelOriginDeps {
  resolveRuntimeSelection: (sandboxName: string) => OpenShellRuntimeSelection;
  resolveAgentConfig: (sandboxName: string) => AgentConfigTarget;
  readConfig: (
    sandboxName: string,
    target: AgentConfigTarget,
    runtime: OpenShellRuntimeSelection,
  ) => ConfigObject;
  writeAllowedOrigins: (
    sandboxName: string,
    origins: string[],
    runtime: OpenShellRuntimeSelection,
  ) => Promise<void>;
  reloadGateway: (sandboxName: string, runtime: OpenShellRuntimeSelection) => Promise<void>;
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
}

async function writeNativeOpenClawAllowedOrigins(
  sandboxName: string,
  origins: string[],
  runtime: OpenShellRuntimeSelection,
): Promise<void> {
  setOpenClawConfigValue(sandboxName, "gateway.controlUi.allowedOrigins", origins, runtime);
}

/**
 * Default reload: the same managed gateway restart `config set --restart` uses.
 * A container restart re-reads the freshly written in-sandbox config on start.
 */
async function defaultReloadGateway(
  sandboxName: string,
  runtimeSelection: OpenShellRuntimeSelection,
): Promise<void> {
  const { restartSandboxGateway } = require("../actions/sandbox/process-recovery") as {
    restartSandboxGateway: (
      name: string,
      options: { runtimeSelection: OpenShellRuntimeSelection },
    ) => Promise<{ ok: boolean }>;
  };
  const result = await restartSandboxGateway(sandboxName, { runtimeSelection });
  if (!result.ok)
    throw new Error("OpenClaw gateway restart failed after writing the tunnel origin");
}

function resolveDeps(deps: Partial<RegisterTunnelOriginDeps>): Required<RegisterTunnelOriginDeps> {
  return {
    resolveRuntimeSelection: deps.resolveRuntimeSelection ?? resolveSandboxConfigRuntimeSelection,
    resolveAgentConfig: deps.resolveAgentConfig ?? resolveAgentConfig,
    readConfig: deps.readConfig ?? readSandboxConfig,
    writeAllowedOrigins: deps.writeAllowedOrigins ?? writeNativeOpenClawAllowedOrigins,
    reloadGateway: deps.reloadGateway ?? defaultReloadGateway,
    info: deps.info ?? (() => {}),
    warn: deps.warn ?? (() => {}),
  };
}

function readAllowedOrigins(config: ConfigObject): unknown {
  const gateway = config.gateway;
  if (!isConfigObject(gateway)) return undefined;
  const controlUi = gateway.controlUi;
  if (!isConfigObject(controlUi)) return undefined;
  return controlUi.allowedOrigins;
}

/**
 * Register the tunnel's public origin into the in-sandbox gateway
 * allowedOrigins so the Web UI over the tunnel is accepted. Best-effort and
 * asynchronous: any failure is swallowed with a warning so a working tunnel
 * start is never turned into a hard error. Idempotent (no write/reload when the
 * origin list is unchanged) and OpenClaw-only.
 */
export async function registerTunnelOrigin(
  sandboxName: string,
  tunnelUrl: string,
  deps: Partial<RegisterTunnelOriginDeps> = {},
): Promise<void> {
  const origin = tunnelUrlToOrigin(tunnelUrl);
  if (origin === null) return;

  const info = deps.info ?? (() => {});
  const warn = deps.warn ?? (() => {});

  try {
    const resolved = resolveDeps(deps);
    const target = resolved.resolveAgentConfig(sandboxName);
    if (target.agentName !== "openclaw") {
      info(`tunnel-origin auto-registration is OpenClaw-only; skipping for ${target.agentName}.`);
      return;
    }

    const runtime = resolved.resolveRuntimeSelection(sandboxName);
    const config = resolved.readConfig(sandboxName, target, runtime);
    const { origins, changed } = computeTunnelAllowedOrigins(readAllowedOrigins(config), tunnelUrl);
    if (!changed) {
      info(`Tunnel origin already registered: ${origin}`);
      return;
    }

    await resolved.writeAllowedOrigins(sandboxName, origins, runtime);
    info(`Registered tunnel origin with gateway: ${origin}`);

    info("Reloading gateway to apply tunnel origin...");
    await resolved.reloadGateway(sandboxName, runtime);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warn(`Could not register tunnel origin (${message}); open the Web UI from the gateway host.`);
  }
}
