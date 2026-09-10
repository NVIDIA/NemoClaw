// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import type { OpenShellRuntimeSelection } from "../../adapters/openshell/runtime-selection.js";
import type { AgentMcpAdapter } from "../../agent/defs.js";
import { inspectMcpDeniedToolSelectors } from "../../security/mcp-denied-tool-selector.js";

export interface RebuildMcpHandoffEntry {
  server: string;
  agent: string;
  adapter?: AgentMcpAdapter;
  url: string;
  env: string[];
  denyTools?: string[];
  trustedPrivateHost?: string;
  allowedIps?: string[];
  providerName?: string;
  providerId?: string;
  policyName: string;
  source?: "native" | "legacy" | "legacy-registry" | "policy";
}

export interface RebuildMcpHandoff {
  entries: RebuildMcpHandoffEntry[];
  runtimeSelection: OpenShellRuntimeSelection;
  /** Cleanup-only identity; retired handoffs cannot be consumed for recovery. */
  retired?: boolean;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const REBUILD_MCP_ENTRY_KEYS = new Set([
  "adapter",
  "agent",
  "allowedIps",
  "denyTools",
  "env",
  "policyName",
  "providerId",
  "providerName",
  "server",
  "source",
  "trustedPrivateHost",
  "url",
]);
const REBUILD_MCP_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function isRebuildMcpHandoffEntry(value: unknown): value is RebuildMcpHandoffEntry {
  if (
    !isObjectRecord(value) ||
    Object.keys(value).some((key) => !REBUILD_MCP_ENTRY_KEYS.has(key)) ||
    typeof value.server !== "string" ||
    !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(value.server) ||
    typeof value.agent !== "string" ||
    !REBUILD_MCP_NAME_PATTERN.test(value.agent) ||
    (value.adapter !== undefined &&
      value.adapter !== "openclaw-config" &&
      value.adapter !== "hermes-config" &&
      value.adapter !== "deepagents-config") ||
    typeof value.url !== "string" ||
    value.url.length > 4096 ||
    !Array.isArray(value.env) ||
    value.env.length > 1 ||
    !value.env.every((name) => typeof name === "string" && /^[A-Z][A-Z0-9_]{0,127}$/u.test(name)) ||
    (value.denyTools !== undefined &&
      (() => {
        const inspection = inspectMcpDeniedToolSelectors(value.denyTools);
        return !inspection.ok || !inspection.canonical;
      })()) ||
    typeof value.policyName !== "string" ||
    !REBUILD_MCP_NAME_PATTERN.test(value.policyName) ||
    (value.trustedPrivateHost !== undefined &&
      (typeof value.trustedPrivateHost !== "string" ||
        value.trustedPrivateHost.length > 253 ||
        /[\r\n\0]/u.test(value.trustedPrivateHost))) ||
    (value.allowedIps !== undefined &&
      (!Array.isArray(value.allowedIps) ||
        value.allowedIps.length > 128 ||
        !value.allowedIps.every(
          (address) => typeof address === "string" && address.length > 0 && address.length <= 64,
        ))) ||
    (value.providerName !== undefined &&
      (typeof value.providerName !== "string" ||
        !REBUILD_MCP_NAME_PATTERN.test(value.providerName))) ||
    (value.providerId !== undefined &&
      (typeof value.providerId !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(value.providerId))) ||
    (value.source !== undefined &&
      value.source !== "native" &&
      value.source !== "legacy" &&
      value.source !== "legacy-registry" &&
      value.source !== "policy")
  ) {
    return false;
  }
  try {
    const url = new URL(value.url);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function isRebuildMcpRuntimeSelection(value: unknown): value is OpenShellRuntimeSelection {
  return (
    isObjectRecord(value) &&
    Object.keys(value).every(
      (key) => key === "gatewayName" || key === "workspace" || key === "localTlsDir",
    ) &&
    typeof value.gatewayName === "string" &&
    REBUILD_MCP_NAME_PATTERN.test(value.gatewayName) &&
    value.workspace === "default" &&
    (value.localTlsDir === undefined ||
      (typeof value.localTlsDir === "string" &&
        path.isAbsolute(value.localTlsDir) &&
        !/[\r\n\0]/u.test(value.localTlsDir)))
  );
}

export function isRebuildMcpHandoff(value: unknown): value is RebuildMcpHandoff {
  return (
    isObjectRecord(value) &&
    Object.keys(value).every(
      (key) => key === "entries" || key === "runtimeSelection" || key === "retired",
    ) &&
    Array.isArray(value.entries) &&
    value.entries.length > 0 &&
    value.entries.length <= 256 &&
    value.entries.every(isRebuildMcpHandoffEntry) &&
    new Set(value.entries.map((entry) => entry.server)).size === value.entries.length &&
    isRebuildMcpRuntimeSelection(value.runtimeSelection) &&
    (value.retired === undefined || value.retired === true)
  );
}
