// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import vm from "node:vm";
import {
  patchBundleMcpRuntimeText,
  patchMcpStartupBackoffText,
} from "../../scripts/patch-openclaw-mcp-reliability.mts";
import { patchOpenClawWorkerArchiveModule } from "../../scripts/lib/patch-openclaw-worker-proxy.mts";
import {
  OPENCLAW_WORKER_ARCHIVE_SOURCE,
  WORKER_MCP_EMBEDDED_SOURCE,
} from "../fixtures/openclaw-worker-proxy.ts";

type Layout = "readable" | "embedded" | "split";
function archivedFixture(name: string): string {
  const source = fs.readFileSync(
    new URL(`../agents/openclaw/fixtures/mcp-worker-${name}.txt`, import.meta.url),
    "utf8",
  );
  const marker = "/* native MCP fixture begins */";
  const complete =
    name === "sqlite-store.worker.mjs"
      ? OPENCLAW_WORKER_ARCHIVE_SOURCE.replace(WORKER_MCP_EMBEDDED_SOURCE, "") + marker + source
      : marker + source;
  return patchOpenClawWorkerArchiveModule(complete, name).text.split(marker)[1];
}

export const runtimeSource = fs.readFileSync(
  new URL("../agents/openclaw/fixtures/mcp-startup-runtime-10.5.js.txt", import.meta.url),
  "utf8",
);
export const backoffSource = fs.readFileSync(
  new URL("../agents/openclaw/fixtures/mcp-startup-backoff-10.5.js.txt", import.meta.url),
  "utf8",
);
export const resetError = () => Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });

export function createHarness(
  layout: Layout,
  options: {
    errors?: Array<Error | undefined>;
    transportType?: string;
    cleanup?: "closed" | "uncertain";
    onDelay?: () => void;
  } = {},
) {
  const clients: object[] = [];
  const invalidators: Array<() => void> = [];
  const connections: Array<{ client: object; transport: object; timeoutMs: number }> = [];
  const disposals: object[] = [];
  const delays: number[] = [];
  const resolutions: unknown[] = [];
  let listFailure: Error | undefined;
  const context = vm.createContext({
    Error,
    AbortController,
    AbortSignal,
    clearTimeout,
    setTimeout: (callback: () => void, delay: number) => {
      delays.push(delay);
      const timer = setTimeout(callback, 1);
      queueMicrotask(() => options.onDelay?.());
      return timer;
    },
    resolveGlobalSingleton: (_key: symbol, init: () => unknown) => init(),
    racePromiseWithAbortSignal: async (promise: Promise<unknown>, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      const result = await promise;
      signal?.throwIfAborted();
      return result;
    },
    redactMcpDiagnosticError: (error: Error) => error.message,
    logWarn: () => {},
    BUNDLE_MCP_CATALOG_FAILURE_RETRY_MS: 1000,
    BUNDLE_MCP_FAILURE_THRESHOLD: 3,
    BUNDLE_MCP_FAILURE_COOLDOWN_MS: 1000,
    MCP_ELICITATION_TIMEOUT_MS: 1000,
    createMcpRequestLifecycle: () => ({}),
    createDisposedError: () => new Error("disposed"),
    resolveMcpTransport: (_name: string, _server: unknown, scope: unknown) => {
      resolutions.push(scope);
      return {
        transport: {},
        transportType: options.transportType ?? "streamable-http",
        connectionTimeoutMs: 20000,
        requestTimeoutMs: 5000,
        description: "fixture",
      };
    },
    createMcpJsonSchemaValidator: () => ({}),
    buildMcpClientCapabilities: () => ({}),
    Client: class {
      constructor(_info: unknown, options: { listChanged: { tools: { onChanged: () => void } } }) {
        clients.push(this);
        invalidators.push(options.listChanged.tools.onChanged);
      }
      getServerCapabilities() {
        return { tools: {} };
      }
      getServerVersion() {
        return {};
      }
    },
    McpClientConnectTimeoutError: class extends Error {},
    connectMcpClient: async (input: { client: object; transport: object; timeoutMs: number }) => {
      connections.push(input);
      const error = options.errors?.[connections.length - 1];
      if (error) throw error;
    },
    disposeBundleMcpSession: async (session: object) => {
      disposals.push(session);
      return options.cleanup ?? "closed";
    },
    recordAgentCleanupFailure: () => {},
    summarizeServerCapabilities: (caps: unknown) => caps,
    listAllMcpTools: async () => {
      if (listFailure) throw listFailure;
      return [{ name: "search" }];
    },
    getCatalogListTimeoutMs: () => 5000,
    normalizeMcpToolFilter: () => undefined,
    isRecord: () => true,
    isRecord$3: () => true,
    normalizeMcpToolCatalog: (tools: unknown[]) => ({ metadata: {}, tools }),
    projectBundleMcpCatalogTools: ({
      normalizedTools,
    }: {
      normalizedTools: { tools: unknown[] };
    }) => ({ tools: normalizedTools.tools }),
    readMcpAppIcons: () => undefined,
    readMcpAppSettingsCapability: () => undefined,
    resolveProjectedMcpCodexToolApprovalMode: () => undefined,
    isMcpHttpSessionExpired: () => false,
    projectBundleMcpCatalogFailure: (_catalog: unknown, diagnostic: unknown) => ({
      servers: {},
      tools: [],
      diagnostics: [diagnostic],
    }),
  });
  vm.runInContext(patchMcpStartupBackoffText(backoffSource, "backoff.mjs").text, context);
  if (layout === "readable") {
    vm.runInContext(
      patchBundleMcpRuntimeText(runtimeSource, "runtime.js").text.replace(/^import[^\n]*\n/gm, ""),
      context,
    );
  } else if (layout === "embedded") {
    vm.runInContext(archivedFixture("sqlite-store.worker.mjs"), context);
  } else {
    // These are separate native modules: their short local names intentionally overlap.
    const manager = vm.createContext({
      Z: new Map(),
      s: context.racePromiseWithAbortSignal,
      H: context.redactMcpDiagnosticError,
      McpStartupBackoffError: context.McpStartupBackoffError,
    });
    vm.runInContext(archivedFixture("worker-chunk-CbW6oavy.mjs"), manager);
    Object.assign(context, {
      _e: manager.connectWithMcpStartupBackoff,
      Ce: manager.resetMcpStartupBackoff,
      F: context.McpStartupBackoffError,
      connectWithMcpStartupBackoff: manager.connectWithMcpStartupBackoff,
      resetMcpStartupBackoff: manager.resetMcpStartupBackoff,
      X: context.BUNDLE_MCP_FAILURE_THRESHOLD,
      Z: context.BUNDLE_MCP_FAILURE_COOLDOWN_MS,
      Q: context.BUNDLE_MCP_CATALOG_FAILURE_RETRY_MS,
      R: context.MCP_ELICITATION_TIMEOUT_MS,
      D: context.recordAgentCleanupFailure,
      Ke: context.connectMcpClient,
      Ye: context.McpClientConnectTimeoutError,
      qe: context.createMcpRequestLifecycle,
      me: context.Client,
      b: context.logWarn,
      L: context.redactMcpDiagnosticError,
      Ie: context.normalizeMcpToolFilter,
      l: context.isRecord,
      Be: context.readMcpAppIcons,
      ze: context.readMcpAppSettingsCapability,
      le: context.resolveProjectedMcpCodexToolApprovalMode,
      B: context.isMcpHttpSessionExpired,
    });
    vm.runInContext(archivedFixture("worker-chunk-tcAUzPTe.mjs"), context);
  }
  const create = () =>
    context.createServerMcpRuntime({
      serverConfig: {
        loaded: {
          mcpServers: { remote: {} },
          prepareDataDirsByServer: { remote: { dataDir: "/owned" } },
        },
        fingerprint: "same",
      },
      serverName: "remote",
      workspaceDir: "/workspace",
      agentDir: "/agent",
      requesterScope: "requester",
      sessionId: "proof",
    });
  return {
    create,
    clients,
    connections,
    disposals,
    delays,
    resolutions,
    context,
    invalidate: () => invalidators.at(-1)?.(),
    failList: (error: Error) => {
      listFailure = error;
    },
  };
}
