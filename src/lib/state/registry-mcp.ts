// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isBlockedMcpUrlTargetHost, MCP_SERVER_URL_MAX_LENGTH } from "../security/mcp-url-target";

export interface McpBridgeEntry {
  server: string;
  agent: string;
  adapter?: string;
  url: string;
  env: string[];
  providerName?: string;
  /** Immutable OpenShell ObjectMeta.id captured after provider creation. */
  providerId?: string;
  policyName: string;
  addedAt: string;
  updatedAt?: string;
  /**
   * Durable add-transaction marker. `prepared` owns no OpenShell/adapter
   * resources yet; `preflighted` proves the derived names were absent before
   * side effects began. Exact retry/cleanup additionally requires `providerId`
   * once provider creation succeeds. Omitted entries are fully committed
   * bridges (including legacy records, which fail closed without providerId).
   */
  addState?: "prepared" | "preflighted";
}

export interface SandboxMcpState {
  bridges: Record<string, McpBridgeEntry>;
  /** Set after in-sandbox adapter scrub/provider detach and before delete. */
  destroyPreparedAt?: string;
  /**
   * Set only after OpenShell has confirmed the sandbox was deleted (or was
   * already absent) and global MCP provider cleanup is still in progress.
   * The bridge entries remain the durable cleanup manifest until every exact
   * matching provider has been deleted.
   */
  destroyPendingAt?: string;
}

const MCP_SERVER_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const MCP_ENV_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MCP_SAFE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const MCP_PROVIDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const MCP_ADAPTERS = new Set(["mcporter", "hermes-config", "deepagents-config"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function serializeSandboxMcpStateForDisk(value: unknown): SandboxMcpState | undefined {
  const state = normalizeSandboxMcpState(value);
  if (!state) return undefined;
  return state;
}

export function normalizeSandboxMcpState(value: unknown): SandboxMcpState | undefined {
  if (!isRecord(value)) return undefined;
  const bridgesValue = value.bridges;
  if (!isRecord(bridgesValue)) return undefined;
  const bridges: Record<string, McpBridgeEntry> = {};
  for (const [name, rawEntry] of Object.entries(bridgesValue)) {
    const entry = normalizeMcpBridgeEntry(name, rawEntry);
    if (entry) bridges[entry.server] = entry;
  }
  const destroyPendingAt =
    typeof value.destroyPendingAt === "string" && value.destroyPendingAt
      ? value.destroyPendingAt
      : undefined;
  const destroyPreparedAt =
    typeof value.destroyPreparedAt === "string" && value.destroyPreparedAt
      ? value.destroyPreparedAt
      : undefined;
  if (Object.keys(bridges).length === 0 && !destroyPreparedAt && !destroyPendingAt) {
    return undefined;
  }
  return {
    bridges,
    ...(destroyPreparedAt ? { destroyPreparedAt } : {}),
    ...(destroyPendingAt ? { destroyPendingAt } : {}),
  };
}

function normalizeMcpUrl(value: string): string | null {
  if (value.length > MCP_SERVER_URL_MAX_LENGTH) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!parsed.hostname || parsed.username || parsed.password) return null;
  if (isBlockedMcpUrlTargetHost(parsed.hostname)) return null;
  if (parsed.hash) parsed.hash = "";
  if (!parsed.pathname) parsed.pathname = "/";
  const normalized = parsed.toString();
  return normalized.length <= MCP_SERVER_URL_MAX_LENGTH ? normalized : null;
}

function normalizeMcpBridgeEntry(server: string, value: unknown): McpBridgeEntry | null {
  if (!isRecord(value)) return null;
  const serverName = typeof value.server === "string" && value.server ? value.server : server;
  if (!MCP_SERVER_RE.test(serverName)) return null;
  const url = typeof value.url === "string" ? normalizeMcpUrl(value.url) : null;
  const policyName = typeof value.policyName === "string" ? value.policyName : "";
  if (!url || !MCP_SAFE_NAME_RE.test(policyName)) return null;
  const rawEnv = value.env;
  const env =
    Array.isArray(rawEnv) &&
    rawEnv.every((entry): entry is string => typeof entry === "string" && MCP_ENV_RE.test(entry))
      ? [...new Set(rawEnv)]
      : null;
  if (!env) return null;
  const adapter = typeof value.adapter === "string" && value.adapter ? value.adapter : undefined;
  if (adapter && !MCP_ADAPTERS.has(adapter)) return null;
  const providerName =
    typeof value.providerName === "string" && value.providerName ? value.providerName : undefined;
  if (providerName && !MCP_SAFE_NAME_RE.test(providerName)) return null;
  const providerId =
    typeof value.providerId === "string" && value.providerId ? value.providerId : undefined;
  if (value.providerId !== undefined && (!providerId || !MCP_PROVIDER_ID_RE.test(providerId))) {
    return null;
  }
  if (providerId && !providerName) return null;
  const rawAddState = value.addState;
  const addState =
    rawAddState === undefined
      ? undefined
      : rawAddState === "prepared" || rawAddState === "preflighted"
        ? rawAddState
        : "preflighted";
  return {
    server: serverName,
    agent: typeof value.agent === "string" && value.agent ? value.agent : "openclaw",
    ...(adapter ? { adapter } : {}),
    url,
    env,
    ...(providerName ? { providerName } : {}),
    ...(providerId ? { providerId } : {}),
    policyName,
    addedAt:
      typeof value.addedAt === "string" && value.addedAt
        ? value.addedAt
        : new Date(0).toISOString(),
    ...(typeof value.updatedAt === "string" ? { updatedAt: value.updatedAt } : {}),
    ...(addState ? { addState } : {}),
  };
}
