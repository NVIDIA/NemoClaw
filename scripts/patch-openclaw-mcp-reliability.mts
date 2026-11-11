#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);

const { MARKER, INJECTED_START_RETRY_HELPER, ABORTABLE_RETRY_HELPER } = await import(
  fs.existsSync(path.join(import.meta.dirname, "lib/openclaw-mcp-retry-payloads.mts"))
    ? "./lib/openclaw-mcp-retry-payloads.mts"
    : "./openclaw-mcp-retry-payloads.mts"
);
export { MARKER, INJECTED_START_RETRY_HELPER };

/** Client identity that only the compiled bundle-mcp session runtime carries. */
const TARGET_SIGNATURE = '"openclaw-bundle-mcp"';

const TASK_OPEN_PATTERN =
  "\t\t\t\t\ttasks: preparedEntries.map(({ serverName, rawServer, resolved, safeServerName }) => async () => {";
const TASK_CLOSE_PATTERN = [
  "\t\t\t\t\t}),",
  "\t\t\t\t\tlimit: BUNDLE_MCP_CATALOG_CONNECT_CONCURRENCY,",
].join("\n");
const START_FAILURE_RETURN_PATTERN = [
  "\t\t\t\t\t\t\treturn {",
  "\t\t\t\t\t\t\t\tserverName,",
  "\t\t\t\t\t\t\t\tserverEntry: null,",
  "\t\t\t\t\t\t\t\ttoolEntries: [],",
  "\t\t\t\t\t\t\t\tdiagnostics: diags",
  "\t\t\t\t\t\t\t};",
].join("\n");
const LIST_TOOLS_PATTERN = [
  "\t\t\t\t\t\t\tconst listedTools = await listAllToolsBestEffort({",
  "\t\t\t\t\t\t\t\tclient: session.client,",
  "\t\t\t\t\t\t\t\ttimeoutMs: getCatalogListTimeoutMs(rawServer, resolved.requestTimeoutMs),",
  "\t\t\t\t\t\t\t\tsuppressUnsupported: Boolean(!capabilities.tools && (capabilities.resources || capabilities.prompts))",
  "\t\t\t\t\t\t\t});",
].join("\n");
const ACQUIRE_LEASE_PATTERN = ["\t\tacquireLease() {", "\t\t\tactiveLeases += 1;"].join("\n");
const TRANSPORT_FACTORY_PATTERN = "function resolveMcpTransport(serverName, rawServer) {";
const LOG_WARN_PATTERN = "logWarn(";

const PREPARED_ENTRY_20260901_PATTERN = [
  "\t\t\t\t\t\trawServer,",
  "\t\t\t\t\t\tresolved,",
  "\t\t\t\t\t\tsafeServerName,",
  "\t\t\t\t\t\tlaunchDescription",
].join("\n");
const PREPARED_ENTRY_20260901_REPLACEMENT = [
  "\t\t\t\t\t\trawServer,",
  "\t\t\t\t\t\ttransportSource,",
  "\t\t\t\t\t\tresolved,",
  "\t\t\t\t\t\tsafeServerName,",
  "\t\t\t\t\t\tlaunchDescription",
].join("\n");
const TASK_OPEN_20260901_PATTERN =
  "\t\t\t\tconst tasks = preparedEntries.map(({ serverName, rawServer, resolved, safeServerName, launchDescription }) => async () => {";
const TASK_CLOSE_20260901_PATTERN = [
  "\t\t\t\t});",
  "\t\t\t\tconst { results, firstError, hasError } = await runTasksWithConcurrency({",
].join("\n");
const START_FAILURE_RETURN_20260901_PATTERN = [
  "\t\t\t\t\t\treturn {",
  "\t\t\t\t\t\t\tserverName,",
  "\t\t\t\t\t\t\tserverEntry: null,",
  "\t\t\t\t\t\t\ttoolEntries: [],",
  "\t\t\t\t\t\t\tpolicyToolEntries: [],",
  "\t\t\t\t\t\t\tdiagnostics: diags",
  "\t\t\t\t\t\t};",
].join("\n");
const TRANSPORT_FACTORY_IMPORT_20260901_PATTERN = " t as resolveMcpTransport,";
const SESSION_SCOPE_BINDINGS_20260901_PATTERN = [
  "function createSessionMcpRuntime(params) {",
  "\tconst { loaded, fingerprint: computedFingerprint } = loadSessionMcpConfig({",
  "\t\tworkspaceDir: params.workspaceDir,",
  "\t\tcfg: params.cfg,",
].join("\n");
const PREPARED_TRANSPORT_SCOPE_20260901_PATTERN = [
  "\t\t\t\tfor (const [serverName, rawServer] of Object.entries(loaded.mcpServers)) {",
  "\t\t\t\t\tfailIfDisposed();",
  "\t\t\t\t\tif (retryServerNames && !retryServerNames.has(serverName)) continue;",
  "\t\t\t\t\tconst override = params.connectionOverrides?.get(serverName);",
  "\t\t\t\t\tconst transportSource = override ? applyMcpConnectionOverride(rawServer, override) : rawServer;",
  "\t\t\t\t\tconst dataDirOwnership = Object.hasOwn(loaded.prepareDataDirsByServer ?? {}, serverName) ? loaded.prepareDataDirsByServer?.[serverName] : void 0;",
  "\t\t\t\t\tconst resolved = resolveMcpTransport(serverName, transportSource, {",
  "\t\t\t\t\t\tcfg: params.cfg,",
  "\t\t\t\t\t\tagentDir: params.agentDir,",
  "\t\t\t\t\t\tprepareDataDir: dataDirOwnership?.dataDir,",
  "\t\t\t\t\t\trequesterScope: params.requesterScope",
  "\t\t\t\t\t});",
].join("\n");

/** Anchors this patch rewrites; each must appear exactly once before patching. */
const UNPATCHED_TARGET_PATTERNS = [
  TASK_OPEN_PATTERN,
  TASK_CLOSE_PATTERN,
  START_FAILURE_RETURN_PATTERN,
  LIST_TOOLS_PATTERN,
  ACQUIRE_LEASE_PATTERN,
];
/** Anchors this patch only reads; the retry reuses the upstream transport factory. */
const REQUIRED_PATTERNS = [...UNPATCHED_TARGET_PATTERNS, TRANSPORT_FACTORY_PATTERN];

const TASK_OPEN_REPLACEMENT = [
  "\t\t\t\t\ttasks: preparedEntries.map(({ serverName, rawServer, resolved, safeServerName }) => nemoClawWithMcpStartRetry({",
  "\t\t\t\t\t\tserverName,",
  "\t\t\t\t\t\tinitialResolved: resolved,",
  "\t\t\t\t\t\tresolveTransport: () => resolveMcpTransport(serverName, rawServer),",
  "\t\t\t\t\t\tattempt: async (resolved) => {",
].join("\n");
const TASK_CLOSE_REPLACEMENT = [
  "\t\t\t\t\t\t}",
  "\t\t\t\t\t})),",
  "\t\t\t\t\tlimit: BUNDLE_MCP_CATALOG_CONNECT_CONCURRENCY,",
].join("\n");
const START_FAILURE_RETURN_REPLACEMENT = [
  "\t\t\t\t\t\t\treturn {",
  "\t\t\t\t\t\t\t\tserverName,",
  "\t\t\t\t\t\t\t\tserverEntry: null,",
  "\t\t\t\t\t\t\t\ttoolEntries: [],",
  "\t\t\t\t\t\t\t\tdiagnostics: diags,",
  "\t\t\t\t\t\t\t\t[NEMOCLAW_MCP_START_FAILURE]: {",
  "\t\t\t\t\t\t\t\t\terror,",
  "\t\t\t\t\t\t\t\t\treusedSession",
  "\t\t\t\t\t\t\t\t}",
  "\t\t\t\t\t\t\t};",
].join("\n");
const LIST_TOOLS_REPLACEMENT = [
  "\t\t\t\t\t\t\tlet listedTools = await listAllToolsBestEffort({",
  "\t\t\t\t\t\t\t\tclient: session.client,",
  "\t\t\t\t\t\t\t\ttimeoutMs: getCatalogListTimeoutMs(rawServer, resolved.requestTimeoutMs),",
  "\t\t\t\t\t\t\t\tsuppressUnsupported: Boolean(!capabilities.tools && (capabilities.resources || capabilities.prompts))",
  "\t\t\t\t\t\t\t});",
  '\t\t\t\t\t\t\tif (resolved.transportType === "streamable-http" && capabilities.tools && listedTools.length === 0) {',
  '\t\t\t\t\t\t\t\tlogWarn(`bundle-mcp: tool-capable server "${serverName}" returned an empty initial tool list; retrying once on the established transport.`);',
  "\t\t\t\t\t\t\t\tawait nemoClawMcpRetryDelay();",
  "\t\t\t\t\t\t\t\tlistedTools = await listAllToolsBestEffort({",
  "\t\t\t\t\t\t\t\t\tclient: session.client,",
  "\t\t\t\t\t\t\t\t\ttimeoutMs: getCatalogListTimeoutMs(rawServer, resolved.requestTimeoutMs),",
  "\t\t\t\t\t\t\t\t\tsuppressUnsupported: false",
  "\t\t\t\t\t\t\t\t});",
  "\t\t\t\t\t\t\t}",
].join("\n");
const ACQUIRE_LEASE_REPLACEMENT = [
  "\t\tacquireLease() {",
  "\t\t\tif (activeLeases === 0 && nemoClawCatalogHasStartDiagnostics(catalog)) catalog = null;",
  "\t\t\tactiveLeases += 1;",
].join("\n");

const TASK_OPEN_20260901_REPLACEMENT = [
  "\t\t\t\tconst tasks = preparedEntries.map(({ serverName, rawServer, transportSource, resolved, safeServerName, launchDescription }) => nemoClawWithMcpStartRetry({",
  "\t\t\t\t\tserverName,",
  "\t\t\t\t\tinitialResolved: resolved,",
  "\t\t\t\t\tresolveTransport: () => resolveMcpTransport(serverName, transportSource, {",
  "\t\t\t\t\t\tcfg: params.cfg,",
  "\t\t\t\t\t\tagentDir: params.agentDir,",
  "\t\t\t\t\t\tprepareDataDir: loaded.prepareDataDirsByServer?.[serverName]?.dataDir,",
  "\t\t\t\t\t\trequesterScope: params.requesterScope",
  "\t\t\t\t\t}),",
  "\t\t\t\t\tattempt: async (resolved) => {",
].join("\n");
const TASK_CLOSE_20260901_REPLACEMENT = [
  "\t\t\t\t\t}",
  "\t\t\t\t}));",
  "\t\t\t\tconst { results, firstError, hasError } = await runTasksWithConcurrency({",
].join("\n");
const START_FAILURE_RETURN_20260901_REPLACEMENT = [
  "\t\t\t\t\t\treturn {",
  "\t\t\t\t\t\t\tserverName,",
  "\t\t\t\t\t\t\tserverEntry: null,",
  "\t\t\t\t\t\t\ttoolEntries: [],",
  "\t\t\t\t\t\t\tpolicyToolEntries: [],",
  "\t\t\t\t\t\t\tdiagnostics: diags,",
  "\t\t\t\t\t\t\t[NEMOCLAW_MCP_START_FAILURE]: {",
  "\t\t\t\t\t\t\t\terror,",
  "\t\t\t\t\t\t\t\treusedSession",
  "\t\t\t\t\t\t\t}",
  "\t\t\t\t\t\t};",
].join("\n");

const LEGACY_SHAPE = {
  unpatched: UNPATCHED_TARGET_PATTERNS,
  required: REQUIRED_PATTERNS,
  patched: [
    MARKER,
    TASK_OPEN_REPLACEMENT,
    TASK_CLOSE_REPLACEMENT,
    START_FAILURE_RETURN_REPLACEMENT,
    LIST_TOOLS_REPLACEMENT,
    ACQUIRE_LEASE_REPLACEMENT,
  ],
  replacements: [
    [TASK_OPEN_PATTERN, TASK_OPEN_REPLACEMENT],
    [TASK_CLOSE_PATTERN, TASK_CLOSE_REPLACEMENT],
    [START_FAILURE_RETURN_PATTERN, START_FAILURE_RETURN_REPLACEMENT],
    [LIST_TOOLS_PATTERN, LIST_TOOLS_REPLACEMENT],
    [ACQUIRE_LEASE_PATTERN, ACQUIRE_LEASE_REPLACEMENT],
  ],
} as const;

const SHAPE_20260901 = {
  unpatched: [
    PREPARED_ENTRY_20260901_PATTERN,
    TASK_OPEN_20260901_PATTERN,
    TASK_CLOSE_20260901_PATTERN,
    START_FAILURE_RETURN_20260901_PATTERN,
    ACQUIRE_LEASE_PATTERN,
  ],
  required: [
    PREPARED_ENTRY_20260901_PATTERN,
    TASK_OPEN_20260901_PATTERN,
    TASK_CLOSE_20260901_PATTERN,
    START_FAILURE_RETURN_20260901_PATTERN,
    ACQUIRE_LEASE_PATTERN,
    TRANSPORT_FACTORY_IMPORT_20260901_PATTERN,
    SESSION_SCOPE_BINDINGS_20260901_PATTERN,
    PREPARED_TRANSPORT_SCOPE_20260901_PATTERN,
  ],
  patched: [
    MARKER,
    PREPARED_ENTRY_20260901_REPLACEMENT,
    TASK_OPEN_20260901_REPLACEMENT,
    TASK_CLOSE_20260901_REPLACEMENT,
    START_FAILURE_RETURN_20260901_REPLACEMENT,
    ACQUIRE_LEASE_REPLACEMENT,
  ],
  replacements: [
    [PREPARED_ENTRY_20260901_PATTERN, PREPARED_ENTRY_20260901_REPLACEMENT],
    [TASK_OPEN_20260901_PATTERN, TASK_OPEN_20260901_REPLACEMENT],
    [TASK_CLOSE_20260901_PATTERN, TASK_CLOSE_20260901_REPLACEMENT],
    [START_FAILURE_RETURN_20260901_PATTERN, START_FAILURE_RETURN_20260901_REPLACEMENT],
    [ACQUIRE_LEASE_PATTERN, ACQUIRE_LEASE_REPLACEMENT],
  ],
} as const;

// 2026.9.2 owns connection and catalog state per server. Preserve that ownership
// while applying the same bounded startup retry around one server's load.
const SERVER_TRANSPORT_PATTERN = [
  "\t\t\tconst resolved = resolveMcpTransport(serverName, transportSource, {",
  "\t\t\t\tcfg: params.cfg,",
  "\t\t\t\tagentDir: params.agentDir,",
  "\t\t\t\tprepareDataDir: loaded.prepareDataDirsByServer?.[serverName]?.dataDir,",
  "\t\t\t\trequesterScope: params.requesterScope",
  "\t\t\t});",
].join("\n");
const SERVER_ATTEMPT_OPEN_PATTERN = [
  "\t\t\t\ttools: []",
  "\t\t\t};",
  "\t\t\tconst safeServerName = params.safeServerNamesByServer?.get(serverName) ?? serverName;",
].join("\n");
const SERVER_ATTEMPT_OPEN_REPLACEMENT = SERVER_ATTEMPT_OPEN_PATTERN.replace(
  "\t\t\tconst safeServerName",
  [
    "\t\t\treturn await nemoClawWithMcpStartRetry({",
    "\t\t\t\tserverName,",
    "\t\t\t\tinitialResolved: resolved,",
    "\t\t\t\tresolveTransport: () => resolveMcpTransport(serverName, transportSource, {",
    "\t\t\t\t\tcfg: params.cfg,",
    "\t\t\t\t\tagentDir: params.agentDir,",
    "\t\t\t\t\tprepareDataDir: loaded.prepareDataDirsByServer?.[serverName]?.dataDir,",
    "\t\t\t\t\trequesterScope: params.requesterScope",
    "\t\t\t\t}),",
    "\t\t\t\tattempt: async (resolved) => {",
    "\t\t\tconst safeServerName",
  ].join("\n"),
);
const SERVER_ATTEMPT_CLOSE_PATTERN = "\t\t\t}\n\t\t})();\n\t\tcatalogInFlight = inFlight;";
const SERVER_ATTEMPT_CLOSE_REPLACEMENT =
  "\t\t\t}\n\t\t\t\t}\n\t\t\t})();\n\t\t})();\n\t\tcatalogInFlight = inFlight;";
const SERVER_FAILURE_PATTERN = "\t\t\t\t\tdiagnostics: diags\n\t\t\t\t};";
const SERVER_FAILURE_REPLACEMENT = [
  "\t\t\t\t\tdiagnostics: diags,",
  "\t\t\t\t\t[NEMOCLAW_MCP_START_FAILURE]: { error, reusedSession }",
  "\t\t\t\t};",
].join("\n");
const SERVER_REPLACEMENTS = [
  [SERVER_ATTEMPT_OPEN_PATTERN, SERVER_ATTEMPT_OPEN_REPLACEMENT],
  [SERVER_ATTEMPT_CLOSE_PATTERN, SERVER_ATTEMPT_CLOSE_REPLACEMENT],
  [SERVER_FAILURE_PATTERN, SERVER_FAILURE_REPLACEMENT],
  [ACQUIRE_LEASE_PATTERN, ACQUIRE_LEASE_REPLACEMENT],
] as const;
const SHAPE_20260902 = {
  unpatched: SERVER_REPLACEMENTS.map(([upstream]) => upstream),
  required: [
    "function createServerMcpRuntime(params) {",
    SERVER_TRANSPORT_PATTERN,
    ...SERVER_REPLACEMENTS.map(([upstream]) => upstream),
  ],
  patched: [MARKER, ...SERVER_REPLACEMENTS.map(([, patched]) => patched)],
  replacements: SERVER_REPLACEMENTS,
} as const;

// 2026.10.5 serializes startup through shared backoff. Keep the bounded retry
// inside that admitted operation, and rebuild only after confirmed disposal.
const SERVER_SESSION_20261005 = [
  "\t\t\tif (!session) {",
  "\t\t\t\tconst client = new Client({",
  '\t\t\t\t\tname: "openclaw-bundle-mcp",',
  '\t\t\t\t\tversion: "0.0.0"',
  "\t\t\t\t}, {",
  "\t\t\t\t\tcapabilities: buildMcpClientCapabilities(mcpAppsEnabled),",
  "\t\t\t\t\tjsonSchemaValidator: schemaValidator,",
  "\t\t\t\t\tlistChanged: { tools: {",
  "\t\t\t\t\t\tautoRefresh: false,",
  "\t\t\t\t\t\tdebounceMs: 0,",
  "\t\t\t\t\t\tonChanged: (error) => {",
  '\t\t\t\t\t\t\tif (error) logWarn(`bundle-mcp: failed to refresh changed tool list for server "${serverName}": ${redactMcpDiagnosticError(error)}`);',
  "\t\t\t\t\t\t\tinvalidateCatalog();",
  "\t\t\t\t\t\t}",
  "\t\t\t\t\t} }",
  "\t\t\t\t});",
  "\t\t\t\tconst createdSession = {",
  "\t\t\t\t\tserverName,",
  "\t\t\t\t\tclient,",
  "\t\t\t\t\t...mcpAppsEnabled ? { withElicitation: bindMcpClientElicitation(client) } : {},",
  "\t\t\t\t\ttransport: resolved.transport,",
  "\t\t\t\t\ttransportType: resolved.transportType,",
  "\t\t\t\t\trequestTimeoutMs: resolved.requestTimeoutMs,",
  "\t\t\t\t\tconnected: false,",
  "\t\t\t\t\tretiring: false,",
  "\t\t\t\t\tdetachStderr: resolved.detachStderr",
  "\t\t\t\t};",
  "\t\t\t\tclient.onclose = () => {",
  "\t\t\t\t\tconst wasConnected = createdSession.connected;",
  "\t\t\t\t\tcreatedSession.connected = false;",
  '\t\t\t\t\tcreatedSession.disconnectReason = "mcp transport closed";',
  "\t\t\t\t\tif (wasConnected && !retiredCatalog && !createdSession.retiring && currentSession === createdSession) {",
  '\t\t\t\t\t\tscheduleCatalogServerRetry("mcp transport closed");',
  '\t\t\t\t\t\tlogWarn(`bundle-mcp: server "${serverName}" closed; next request reconnects`);',
  "\t\t\t\t\t}",
  "\t\t\t\t};",
  "\t\t\t\tsession = createdSession;",
  "\t\t\t\tcurrentSession = session;",
  "\t\t\t}",
  "",
].join("\n");
const SERVER_SESSION_20261005_PATCHED = [
  "\t\t\tconst nemoClawCreateSession = (resolved) => {",
  "\t\t\t\tconst client = new Client({",
  '\t\t\t\t\tname: "openclaw-bundle-mcp",',
  '\t\t\t\t\tversion: "0.0.0"',
  "\t\t\t\t}, {",
  "\t\t\t\t\tcapabilities: buildMcpClientCapabilities(mcpAppsEnabled),",
  "\t\t\t\t\tjsonSchemaValidator: schemaValidator,",
  "\t\t\t\t\tlistChanged: { tools: {",
  "\t\t\t\t\t\tautoRefresh: false,",
  "\t\t\t\t\t\tdebounceMs: 0,",
  "\t\t\t\t\t\tonChanged: (error) => {",
  '\t\t\t\t\t\t\tif (error) logWarn(`bundle-mcp: failed to refresh changed tool list for server "${serverName}": ${redactMcpDiagnosticError(error)}`);',
  "\t\t\t\t\t\t\tinvalidateCatalog();",
  "\t\t\t\t\t\t}",
  "\t\t\t\t\t} }",
  "\t\t\t\t});",
  "\t\t\t\tconst createdSession = {",
  "\t\t\t\t\tserverName,",
  "\t\t\t\t\tclient,",
  "\t\t\t\t\t...mcpAppsEnabled ? { withElicitation: bindMcpClientElicitation(client) } : {},",
  "\t\t\t\t\ttransport: resolved.transport,",
  "\t\t\t\t\ttransportType: resolved.transportType,",
  "\t\t\t\t\trequestTimeoutMs: resolved.requestTimeoutMs,",
  "\t\t\t\t\tconnected: false,",
  "\t\t\t\t\tretiring: false,",
  "\t\t\t\t\tdetachStderr: resolved.detachStderr",
  "\t\t\t\t};",
  "\t\t\t\tclient.onclose = () => {",
  "\t\t\t\t\tconst wasConnected = createdSession.connected;",
  "\t\t\t\t\tcreatedSession.connected = false;",
  '\t\t\t\t\tcreatedSession.disconnectReason = "mcp transport closed";',
  "\t\t\t\t\tif (wasConnected && !retiredCatalog && !createdSession.retiring && currentSession === createdSession) {",
  '\t\t\t\t\t\tscheduleCatalogServerRetry("mcp transport closed");',
  '\t\t\t\t\t\tlogWarn(`bundle-mcp: server "${serverName}" closed; next request reconnects`);',
  "\t\t\t\t\t}",
  "\t\t\t\t};",
  "\t\t\t\treturn createdSession;",
  "\t\t\t};",
  "\t\t\tif (!session) currentSession = session = nemoClawCreateSession(resolved);",
  "",
].join("\n");
const SERVER_CONNECT_20261005 = [
  "\t\t\t\t\tconst connectingSession = session;",
  "\t\t\t\t\tawait connectWithMcpStartupBackoff(startupKey, lifecycleAbortController.signal, () => ensureSessionConnected(connectingSession, resolved.connectionTimeoutMs), BUNDLE_MCP_CATALOG_FAILURE_RETRY_MS);",
].join("\n");
const SERVER_CONNECT_20261005_PATCHED = [
  "\t\t\t\t\tawait connectWithMcpStartupBackoff(startupKey, lifecycleAbortController.signal, async () => {",
  "\t\t\t\t\t\tconst signal = lifecycleAbortController.signal;",
  "\t\t\t\t\t\tsignal.throwIfAborted();",
  "\t\t\t\t\t\ttry {",
  "\t\t\t\t\t\t\tawait ensureSessionConnected(session, resolved.connectionTimeoutMs);",
  "\t\t\t\t\t\t} catch (error) {",
  "\t\t\t\t\t\t\tsignal.throwIfAborted();",
  '\t\t\t\t\t\t\tif (reusedSession || resolved.transportType !== "streamable-http" || !nemoClawIsTransientMcpStartFailure(error)) throw error;',
  "\t\t\t\t\t\t\tif (!await retireSessionIfCurrent(session) || cleanupFailed) throw error;",
  "\t\t\t\t\t\t\tawait nemoClawMcpAbortableRetryDelay(signal);",
  "\t\t\t\t\t\t\tfailIfDisposed();",
  "\t\t\t\t\t\t\tconst retryResolved = resolveMcpTransport(serverName, transportSource, {",
  "\t\t\t\t\t\t\t\tcfg: params.cfg,",
  "\t\t\t\t\t\t\t\tagentDir: params.agentDir,",
  "\t\t\t\t\t\t\t\tprepareDataDir: loaded.prepareDataDirsByServer?.[serverName]?.dataDir,",
  "\t\t\t\t\t\t\t\trequesterScope: params.requesterScope",
  "\t\t\t\t\t\t\t});",
  '\t\t\t\t\t\t\tif (!retryResolved || retryResolved.transportType !== "streamable-http") throw error;',
  "\t\t\t\t\t\t\tresolved = retryResolved;",
  "\t\t\t\t\t\t\tcurrentSession = session = nemoClawCreateSession(resolved);",
  '\t\t\t\t\t\t\tlogWarn(`bundle-mcp: retrying transient startup failure for server "${serverName}" once with a fresh transport.`);',
  "\t\t\t\t\t\t\ttry {",
  "\t\t\t\t\t\t\t\tawait ensureSessionConnected(session, Math.min(resolved.connectionTimeoutMs, NEMOCLAW_MCP_RETRY_CONNECT_TIMEOUT_MS));",
  "\t\t\t\t\t\t\t} catch (retryError) {",
  "\t\t\t\t\t\t\t\tsignal.throwIfAborted();",
  "\t\t\t\t\t\t\t\tif (!nemoClawIsTransientMcpStartFailure(retryError)) throw retryError;",
  "\t\t\t\t\t\t\t\tthrow new Error(`${redactMcpDiagnosticError(retryError)}${NEMOCLAW_MCP_TRANSIENT_DIAGNOSTIC_SUFFIX}`, { cause: retryError });",
  "\t\t\t\t\t\t\t}",
  "\t\t\t\t\t\t}",
  "\t\t\t\t\t}, BUNDLE_MCP_CATALOG_FAILURE_RETRY_MS);",
].join("\n");
const SERVER_LEASE_20261005_PATCHED = [
  "\t\tacquireLease() {",
  "\t\t\tif (activeLeases === 0 && nemoClawCatalogHasStartDiagnostics(catalog)) {",
  "\t\t\t\tresetMcpStartupBackoff(startupKey, lifecycleAbortController.signal);",
  "\t\t\t\tinvalidateCatalog();",
  "\t\t\t}",
  "\t\t\tactiveLeases += 1;",
].join("\n");
const SERVER_REPLACEMENTS_20261005 = [
  [SERVER_TRANSPORT_PATTERN, SERVER_TRANSPORT_PATTERN.replace("const resolved", "let resolved")],
  [SERVER_SESSION_20261005, SERVER_SESSION_20261005_PATCHED],
  [SERVER_CONNECT_20261005, SERVER_CONNECT_20261005_PATCHED],
  [ACQUIRE_LEASE_PATTERN, SERVER_LEASE_20261005_PATCHED],
] as const;
const SERVER_LIFECYCLE_20261005 = [
  [
    "\tconst disposeSession = (session) => {",
    "\t\tif (session.disposePromise) return session.disposePromise;",
    "\t\tconst closing = disposeBundleMcpSession(session).then((outcome) => {",
    '\t\t\tif (outcome === "uncertain") {',
    "\t\t\t\tcleanupFailed = true;",
    "\t\t\t\trecordAgentCleanupFailure();",
    "\t\t\t}",
    "\t\t}).catch((error) => {",
    "\t\t\tcleanupFailed = true;",
    "\t\t\trecordAgentCleanupFailure();",
    "\t\t\tthrow error;",
    "\t\t}).finally(() => pendingDisposals.delete(closing));",
    "\t\tsession.disposePromise = closing;",
    "\t\tpendingDisposals.add(closing);",
    "\t\treturn closing;",
    "\t};",
    "",
  ].join("\n"),
  [
    "\tconst ensureSessionConnected = async (session, connectionTimeoutMs) => {",
    '\t\tif (session.retiring) throw new Error(`bundle-mcp server "${session.serverName}" is retiring`);',
    "\t\tif (session.connected) return;",
    "\t\tsession.connectPromise ??= connectMcpClient({",
    "\t\t\tclient: session.client,",
    "\t\t\ttransport: session.transport,",
    "\t\t\ttimeoutMs: connectionTimeoutMs",
    "\t\t}).catch((error) => {",
    '\t\t\tif (error instanceof McpClientConnectTimeoutError) throw new Error(`MCP server "${session.serverName}" timed out: did not complete initialize within ${connectionTimeoutMs / 1e3}s`, { cause: error });',
    "\t\t\tthrow error;",
    "\t\t}).then(() => {",
    "\t\t\tsession.connected = true;",
    "\t\t}).finally(() => {",
    "\t\t\tsession.connectPromise = void 0;",
    "\t\t});",
    "\t\tawait session.connectPromise;",
    "\t};",
    "\tconst retireSessionIfCurrent = async (session) => {",
    "\t\tif (currentSession !== session) return false;",
    "\t\tsession.retiring = true;",
    "\t\tcurrentSession = void 0;",
    "\t\tawait disposeSession(session);",
    "\t\treturn true;",
    "\t};",
    "",
  ].join("\n"),
];
const SHAPE_20261005 = {
  unpatched: SERVER_REPLACEMENTS_20261005.map(([upstream]) => upstream),
  required: [
    "const lifecycleAbortController = new AbortController();",
    "let cleanupFailed = false;",
    ...SERVER_LIFECYCLE_20261005,
    ...SERVER_REPLACEMENTS_20261005.map(([upstream]) => upstream),
  ],
  patched: [
    MARKER,
    ...SERVER_LIFECYCLE_20261005,
    ...SERVER_REPLACEMENTS_20261005.map(([, patched]) => patched),
  ],
  replacements: SERVER_REPLACEMENTS_20261005,
} as const;

// Archived copies are composed by patch-openclaw-worker-proxy.mts, which owns
// full native-manifest admission. Both layouts use the shared retry payload.

type PatchStatus = "already-patched" | "patched";

type PatchTextResult = {
  readonly patched: boolean;
  readonly status: PatchStatus;
  readonly text: string;
};

function usage(): string {
  return "Usage: patch-openclaw-mcp-reliability.mts [--audit] <openclaw-dist-dir>";
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function readOpenClawVersion(distDir: string): string {
  const packageJsonPath = path.resolve(distDir, "..", "package.json");
  let payload: { version?: unknown };
  try {
    payload = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
  } catch (err) {
    throw new Error(
      `Could not read OpenClaw package metadata at ${packageJsonPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (typeof payload.version !== "string") {
    throw new Error(`OpenClaw package metadata missing string version at ${packageJsonPath}`);
  }
  return payload.version;
}

function listJsFiles(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    throw new Error(
      `Could not read OpenClaw dist directory ${dir}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listJsFiles(entryPath));
    else if (entry.isFile() && entry.name.endsWith(".js")) files.push(entryPath);
  }
  return files.sort();
}

/** Fail closed: a recognized bundle-mcp runtime must expose every patch anchor exactly once. */
export function patchBundleMcpRuntimeText(source: string, filePath: string): PatchTextResult {
  const currentLayout =
    source.includes(TASK_OPEN_20260901_PATTERN) ||
    source.includes(TASK_OPEN_20260901_REPLACEMENT) ||
    (source.includes("policyToolEntries: []") && source.includes("launchDescription"));
  const shape = source.includes("connectWithMcpStartupBackoff(startupKey,")
    ? SHAPE_20261005
    : source.includes("function createServerMcpRuntime(params) {")
      ? SHAPE_20260902
      : currentLayout
        ? SHAPE_20260901
        : LEGACY_SHAPE;
  if (source.includes(MARKER)) {
    for (const pattern of [
      ...shape.patched,
      INJECTED_START_RETRY_HELPER,
      ...(shape === SHAPE_20261005 ? [ABORTABLE_RETRY_HELPER] : []),
    ]) {
      const count = countOccurrences(source, pattern);
      if (count !== 1) {
        throw new Error(
          `${filePath}: MCP startup recovery patch is partial or ambiguous; expected exactly one patched target, found ${count}`,
        );
      }
    }
    for (const pattern of shape.unpatched) {
      if (source.includes(pattern)) {
        throw new Error(
          `${filePath}: MCP startup recovery marker is present but an unpatched target remains`,
        );
      }
    }
    return { patched: false, status: "already-patched", text: source };
  }

  if (!source.includes(LOG_WARN_PATTERN)) {
    throw new Error(`${filePath}: bundle-mcp runtime lacks the expected logWarn diagnostic helper`);
  }
  for (const pattern of shape.required) {
    const count = countOccurrences(source, pattern);
    if (count !== 1) {
      throw new Error(
        `${filePath}: expected exactly one MCP startup recovery target, found ${count}`,
      );
    }
  }

  const importMatch = source.match(/^(?:import[^\n]*\n)+/);
  if (!importMatch) {
    throw new Error(`${filePath}: bundle-mcp runtime has no import prologue to anchor the helper`);
  }

  let text = `${source.slice(0, importMatch[0].length)}${INJECTED_START_RETRY_HELPER}${shape === SHAPE_20261005 ? ABORTABLE_RETRY_HELPER : ""}${source.slice(
    importMatch[0].length,
  )}`;
  for (const [upstream, patched] of shape.replacements) text = text.replace(upstream, patched);

  for (const pattern of [
    ...shape.patched,
    INJECTED_START_RETRY_HELPER,
    ...(shape === SHAPE_20261005 ? [ABORTABLE_RETRY_HELPER] : []),
  ]) {
    const count = countOccurrences(text, pattern);
    if (count !== 1) {
      throw new Error(
        `${filePath}: MCP startup recovery patch verification failed; expected exactly one patched target, found ${count}`,
      );
    }
  }
  return { patched: true, status: "patched", text };
}

const STARTUP_RESET_20261005 = [
  "function resetMcpStartupBackoff(key) {",
  "\tif (key === void 0) startups.clear();",
  "\telse startups.delete(key);",
  "}",
  "",
].join("\n");
const STARTUP_RESET_20261005_PATCHED = [
  "/* nemoclaw owner-scoped MCP next-lease recovery (#7958) */",
  "function resetMcpStartupBackoff(key, owner) {",
  "\tif (owner !== void 0) {",
  "\t\tconst state = startups.get(key);",
  "\t\tif (state?.owner === owner && !state.pending) startups.delete(key);",
  "\t\treturn;",
  "\t}",
  "\tif (key === void 0) startups.clear();",
  "\telse startups.delete(key);",
  "}",
  "",
].join("\n");
const STARTUP_BACKOFF_20261005 = [
  "async function connectWithMcpStartupBackoff(key, signal, connect, recoveryRetryMs) {",
  "\twhile (startups.get(key)?.pending) await racePromiseWithAbortSignal(startups.get(key).pending.catch(() => void 0), signal);",
  "\tsignal.throwIfAborted();",
  "\tconst state = startups.get(key) ?? {",
  "\t\towner: signal,",
  "\t\tdelayMs: 15e3,",
  "\t\tretryAfterMs: 0,",
  '\t\tmessage: ""',
  "\t};",
  "\tconst retryAfterMs = () => state.owner === signal && state.delayMs === 3e4 ? state.retryAfterMs - state.delayMs + recoveryRetryMs : state.retryAfterMs;",
  "\tif (Date.now() < retryAfterMs()) throw new McpStartupBackoffError(state, false, retryAfterMs());",
  "\tstartups.set(key, state);",
  "\ttry {",
  "\t\tstate.pending = connect();",
  "\t\tawait state.pending;",
  "\t\tif (startups.get(key) === state) startups.delete(key);",
  "\t} catch (error) {",
  "\t\tif (signal.aborted) {",
  "\t\t\tif (startups.get(key) === state) startups.delete(key);",
  "\t\t\tthrow error;",
  "\t\t}",
  "\t\tstate.delayMs = Math.min(state.delayMs * 2, 6e5);",
  "\t\tstate.retryAfterMs = Date.now() + state.delayMs;",
  "\t\tstate.message = redactMcpDiagnosticError(error);",
  "\t\tthrow new McpStartupBackoffError(state, true, retryAfterMs());",
  "\t} finally {",
  "\t\tstate.pending = void 0;",
  "\t\tfor (const [oldKey, oldState] of startups) {",
  "\t\t\tif (startups.size <= 1024) break;",
  "\t\t\tif (!oldState.pending) startups.delete(oldKey);",
  "\t\t}",
  "\t}",
  "}",
  "",
].join("\n");

/** Only the owning runtime may clear an idle failure at its next lease. */
export function patchMcpStartupBackoffText(source: string, filePath: string): PatchTextResult {
  const patched = source.includes("/* nemoclaw owner-scoped MCP next-lease recovery (#7958) */");
  const expected = patched ? STARTUP_RESET_20261005_PATCHED : STARTUP_RESET_20261005;
  if (
    countOccurrences(source, "/* nemoclaw owner-scoped MCP next-lease recovery (#7958) */") !==
      Number(patched) ||
    countOccurrences(source, expected) !== 1 ||
    countOccurrences(source, STARTUP_BACKOFF_20261005) !== 1 ||
    (patched && source.includes(STARTUP_RESET_20261005))
  ) {
    throw new Error(
      `${filePath}: MCP startup backoff owner guard has an unreviewed or partial shape`,
    );
  }
  return {
    patched: !patched,
    status: patched ? "already-patched" : "patched",
    text: patched ? source : source.replace(expected, STARTUP_RESET_20261005_PATCHED),
  };
}

function prepareStartupBackoffPatch(
  distDir: string,
  source: string,
): { file: string; result: PatchTextResult } | undefined {
  if (!source.includes("connectWithMcpStartupBackoff(startupKey,")) return;
  const imports = [
    ...source.matchAll(/from "(\.\.\/agent-bundle-mcp-manager-api-[A-Za-z0-9_-]+\.mjs)";/g),
  ];
  if (imports.length !== 1)
    throw new Error("Expected one reviewed MCP startup backoff manager import");
  const file = path.join(distDir, path.basename(imports[0][1]));
  return { file, result: patchMcpStartupBackoffText(fs.readFileSync(file, "utf8"), file) };
}

function resolveBundleMcpRuntimeFile(distDir: string): string {
  const targets = listJsFiles(distDir).filter((file) =>
    fs.readFileSync(file, "utf-8").includes(TARGET_SIGNATURE),
  );
  if (targets.length !== 1) {
    throw new Error(
      `Expected exactly one OpenClaw bundle-mcp runtime in ${distDir}, found ${targets.length}`,
    );
  }
  return targets[0];
}

export function patchOpenClawMcpReliability(distDir: string): {
  status: PatchStatus;
  file: string;
  version: string;
} {
  const resolvedDist = path.resolve(distDir);
  const version = readOpenClawVersion(resolvedDist);
  const target = resolveBundleMcpRuntimeFile(resolvedDist);
  const source = fs.readFileSync(target, "utf-8");
  const result = patchBundleMcpRuntimeText(source, target);
  const backoff = prepareStartupBackoffPatch(resolvedDist, source);
  if (backoff?.result.patched) fs.writeFileSync(backoff.file, backoff.result.text);
  if (result.patched) fs.writeFileSync(target, result.text);
  return { status: backoff?.result.patched ? "patched" : result.status, file: target, version };
}

export function auditOpenClawMcpReliability(distDir: string): {
  file: string;
  version: string;
} {
  const resolvedDist = path.resolve(distDir);
  const version = readOpenClawVersion(resolvedDist);
  const target = resolveBundleMcpRuntimeFile(resolvedDist);
  const source = fs.readFileSync(target, "utf-8");
  if (!source.includes(MARKER)) {
    throw new Error(`${target}: MCP startup recovery patch is not applied`);
  }
  const result = patchBundleMcpRuntimeText(source, target);
  const backoff = prepareStartupBackoffPatch(resolvedDist, source);
  if (backoff?.result.patched)
    throw new Error(`${backoff.file}: MCP startup backoff owner guard is not applied`);
  if (result.status !== "already-patched") {
    throw new Error(`${target}: MCP startup recovery patch state is not stable`);
  }
  return { file: target, version };
}

function main(argv: readonly string[]): number {
  const args = argv.slice(2);
  const audit = args[0] === "--audit";
  const distDir = audit ? args[1] : args[0];
  if (!distDir || args.length > (audit ? 2 : 1)) {
    console.error(usage());
    return 2;
  }
  try {
    if (audit) {
      const result = auditOpenClawMcpReliability(distDir);
      console.log(
        `INFO: OpenClaw MCP startup recovery audit ok: ${result.file} (openclaw ${result.version})`,
      );
      return 0;
    }
    const result = patchOpenClawMcpReliability(distDir);
    console.log(
      `INFO: OpenClaw MCP startup recovery ${result.status}: ${result.file} (openclaw ${result.version})`,
    );
    return 0;
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  process.exitCode = main(process.argv);
}
