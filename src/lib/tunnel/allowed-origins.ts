// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentConfigTarget } from "../sandbox/config";
import type { ConfigObject } from "../security/credential-filter";
import { isConfigObject } from "../security/credential-filter";
import { createCliOpenShellSandboxCommandExecutor } from "../adapters/openshell/sandbox-command-cli";

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
  resolveAgentConfig: (sandboxName: string) => AgentConfigTarget;
  readConfig: (sandboxName: string, target: AgentConfigTarget) => ConfigObject;
  writeAllowedOrigins: (sandboxName: string, origins: string[]) => Promise<void>;
  reloadGateway: (sandboxName: string) => Promise<void>;
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
}

type SandboxConfigModule = {
  resolveAgentConfig: RegisterTunnelOriginDeps["resolveAgentConfig"];
  readSandboxConfig: RegisterTunnelOriginDeps["readConfig"];
};

async function writeNativeOpenClawAllowedOrigins(
  sandboxName: string,
  origins: string[],
): Promise<void> {
  const completed = await createCliOpenShellSandboxCommandExecutor().runBuffered({
    sandboxName,
    target: { kind: "selected" },
    command: [
      "openclaw",
      "config",
      "set",
      "gateway.controlUi.allowedOrigins",
      JSON.stringify(origins),
      "--strict-json",
    ],
    sandboxEnvironment: { HOME: "/sandbox" },
    timeoutMilliseconds: 30_000,
  });
  if (completed.outcome.kind === "failed") {
    throw new Error(completed.outcome.error.message);
  }
  if (completed.outcome.exitCode !== 0) {
    throw new Error(completed.stderr.trim() || "native OpenClaw config write failed");
  }
}

/**
 * Default reload: the same managed gateway restart `config set --restart` uses.
 * A container restart re-reads the freshly written in-sandbox config on start.
 */
async function defaultReloadGateway(sandboxName: string): Promise<void> {
  const { restartSandboxGateway } = require("../actions/sandbox/process-recovery") as {
    restartSandboxGateway: (name: string) => Promise<{ ok: boolean }>;
  };
  await restartSandboxGateway(sandboxName);
}

function resolveDeps(deps: Partial<RegisterTunnelOriginDeps>): Required<RegisterTunnelOriginDeps> {
  const needsConfig = !deps.resolveAgentConfig || !deps.readConfig;
  const config = needsConfig ? (require("../sandbox/config") as SandboxConfigModule) : undefined;
  return {
    resolveAgentConfig: deps.resolveAgentConfig ?? config!.resolveAgentConfig,
    readConfig: deps.readConfig ?? config!.readSandboxConfig,
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

    const config = resolved.readConfig(sandboxName, target);
    const { origins, changed } = computeTunnelAllowedOrigins(readAllowedOrigins(config), tunnelUrl);
    if (!changed) {
      info(`Tunnel origin already registered: ${origin}`);
      return;
    }

    await resolved.writeAllowedOrigins(sandboxName, origins);
    info(`Registered tunnel origin with gateway: ${origin}`);

    info("Reloading gateway to apply tunnel origin...");
    await resolved.reloadGateway(sandboxName);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warn(`Could not register tunnel origin (${message}); open the Web UI from the gateway host.`);
  }
}
