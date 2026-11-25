// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  INJECTED_START_RETRY_HELPER,
  ABORTABLE_RETRY_HELPER,
} from "./openclaw-mcp-retry-payloads.mts";

type Pair = readonly [string, string];
// Exact expressions from the SRI-verified 2026.10.5 archive. The archive owner
// restores every pair and checks the complete native manifest before publishing.
export const WORKER_ARCHIVE_MCP_PATCHES: Record<string, readonly Pair[]> = {
  "sqlite-store.worker.mjs": [
    [
      "function createServerMcpRuntime(Ot)",
      INJECTED_START_RETRY_HELPER + ABORTABLE_RETRY_HELPER + "function createServerMcpRuntime(Ot)",
    ],
    [
      "loadCatalog=async()=>{if(failIfDisposed(),Hr)",
      "nemoClawMcpCleanupFailed=()=>Di,loadCatalog=async()=>{if(failIfDisposed(),Hr)",
    ],
    [
      'if(!Hr){let Ot=new Client({name:`openclaw-bundle-mcp`,version:`0.0.0`},{capabilities:buildMcpClientCapabilities(Fn),jsonSchemaValidator:Di,listChanged:{tools:{autoRefresh:!1,debounceMs:0,onChanged:Ot=>{Ot&&logWarn(`bundle-mcp: failed to refresh changed tool list for server "${_n}": ${redactMcpDiagnosticError(Ot)}`),invalidateCatalog()}}}}),Kt={serverName:_n,client:Ot,...Fn?{withElicitation:bindMcpClientElicitation(Ot)}:{},transport:cr.transport,transportType:cr.transportType,requestTimeoutMs:cr.requestTimeoutMs,connected:!1,retiring:!1,detachStderr:cr.detachStderr};Ot.onclose=()=>{let Ot=Kt.connected;Kt.connected=!1,Kt.disconnectReason=`mcp transport closed`,Ot&&!pr&&!Kt.retiring&&Si===Kt&&(scheduleCatalogServerRetry(`mcp transport closed`),logWarn(`bundle-mcp: server "${_n}" closed; next request reconnects`))},Hr=Kt,Si=Hr}',
      'const nemoClawCreateSession=(cr)=>{let Ot=new Client({name:`openclaw-bundle-mcp`,version:`0.0.0`},{capabilities:buildMcpClientCapabilities(Fn),jsonSchemaValidator:Di,listChanged:{tools:{autoRefresh:!1,debounceMs:0,onChanged:Ot=>{Ot&&logWarn(`bundle-mcp: failed to refresh changed tool list for server "${_n}": ${redactMcpDiagnosticError(Ot)}`),invalidateCatalog()}}}}),Kt={serverName:_n,client:Ot,...Fn?{withElicitation:bindMcpClientElicitation(Ot)}:{},transport:cr.transport,transportType:cr.transportType,requestTimeoutMs:cr.requestTimeoutMs,connected:!1,retiring:!1,detachStderr:cr.detachStderr};Ot.onclose=()=>{let Ot=Kt.connected;Kt.connected=!1,Kt.disconnectReason=`mcp transport closed`,Ot&&!pr&&!Kt.retiring&&Si===Kt&&(scheduleCatalogServerRetry(`mcp transport closed`),logWarn(`bundle-mcp: server "${_n}" closed; next request reconnects`))};return Kt};if(!Hr)Si=Hr=nemoClawCreateSession(cr);const nemoClawConnectWithRetry=async()=>{await connectWithMcpStartupBackoff(kn, xr.signal, async () => {\n const signal = xr.signal;\n signal.throwIfAborted();\n try {\n  await ensureSessionConnected(Hr, cr.connectionTimeoutMs);\n } catch (error) {\n  signal.throwIfAborted();\n  if (wi || cr.transportType !== "streamable-http" || !nemoClawIsTransientMcpStartFailure(error)) throw error;\n  if (!await retireSessionIfCurrent(Hr) || nemoClawMcpCleanupFailed()) throw error;\n  await nemoClawMcpAbortableRetryDelay(signal);\n  failIfDisposed();\n  const retryResolved = resolveMcpTransport(_n, Jn, {\n   cfg: Ot.cfg,\n   agentDir: Ot.agentDir,\n   prepareDataDir: Kt.prepareDataDirsByServer?.[_n]?.dataDir,\n   requesterScope: Ot.requesterScope\n  });\n  if (!retryResolved || retryResolved.transportType !== "streamable-http") throw error;\n  cr = retryResolved;\n  Si = Hr = nemoClawCreateSession(cr);\n  logWarn(`bundle-mcp: retrying transient startup failure for server "${_n}" once with a fresh transport.`);\n  try {\n   await ensureSessionConnected(Hr, Math.min(cr.connectionTimeoutMs, NEMOCLAW_MCP_RETRY_CONNECT_TIMEOUT_MS));\n  } catch (retryError) {\n   signal.throwIfAborted();\n   if (!nemoClawIsTransientMcpStartFailure(retryError)) throw retryError;\n   throw new Error(`${redactMcpDiagnosticError(retryError)}${NEMOCLAW_MCP_TRANSIENT_DIAGNOSTIC_SUFFIX}`, {cause: retryError});\n  }\n }\n}, BUNDLE_MCP_CATALOG_FAILURE_RETRY_MS)};',
    ],
    [
      "let Ot=Hr;await connectWithMcpStartupBackoff(kn,xr.signal,()=>ensureSessionConnected(Ot,cr.connectionTimeoutMs),BUNDLE_MCP_CATALOG_FAILURE_RETRY_MS)",
      "await nemoClawConnectWithRetry()",
    ],
    [
      "acquireLease(){cr+=1;",
      "acquireLease(){if(cr===0&&nemoClawCatalogHasStartDiagnostics(Mr)){resetMcpStartupBackoff(kn,xr.signal);invalidateCatalog();}cr+=1;",
    ],
    [
      "function resetMcpStartupBackoff(Ot){Ot===void 0?startups.clear():startups.delete(Ot)}",
      "/* nemoclaw owner-scoped MCP next-lease recovery (#7958) */\nfunction resetMcpStartupBackoff(Ot, owner) {\n if (owner !== void 0) {\n  const state = startups.get(Ot);\n  if (state?.owner === owner && !state.pending) startups.delete(Ot);\n  return;\n }\n Ot===void 0?startups.clear():startups.delete(Ot);\n}",
    ],
  ],
  "worker-chunk-tcAUzPTe.mjs": [
    [
      "function createServerMcpRuntime(e)",
      INJECTED_START_RETRY_HELPER.replaceAll("logWarn(", "b(") +
        ABORTABLE_RETRY_HELPER +
        "function createServerMcpRuntime(e)",
    ],
    [
      "loadCatalog=async()=>{if(failIfDisposed(),v)",
      "nemoClawMcpCleanupFailed=()=>C,loadCatalog=async()=>{if(failIfDisposed(),v)",
    ],
    [
      'if(!_){let e=new me({name:`openclaw-bundle-mcp`,version:`0.0.0`},{capabilities:buildMcpClientCapabilities(s),jsonSchemaValidator:S,listChanged:{tools:{autoRefresh:!1,debounceMs:0,onChanged:e=>{e&&b(`bundle-mcp: failed to refresh changed tool list for server "${r}": ${L(e)}`),invalidateCatalog()}}}}),t={serverName:r,client:e,...s?{withElicitation:Pe(e)}:{},transport:d.transport,transportType:d.transportType,requestTimeoutMs:d.requestTimeoutMs,connected:!1,retiring:!1,detachStderr:d.detachStderr};e.onclose=()=>{let e=t.connected;t.connected=!1,t.disconnectReason=`mcp transport closed`,e&&!f&&!t.retiring&&x===t&&(scheduleCatalogServerRetry(`mcp transport closed`),b(`bundle-mcp: server "${r}" closed; next request reconnects`))},_=t,x=_}',
      'const nemoClawCreateSession=(d)=>{let e=new me({name:`openclaw-bundle-mcp`,version:`0.0.0`},{capabilities:buildMcpClientCapabilities(s),jsonSchemaValidator:S,listChanged:{tools:{autoRefresh:!1,debounceMs:0,onChanged:e=>{e&&b(`bundle-mcp: failed to refresh changed tool list for server "${r}": ${L(e)}`),invalidateCatalog()}}}}),t={serverName:r,client:e,...s?{withElicitation:Pe(e)}:{},transport:d.transport,transportType:d.transportType,requestTimeoutMs:d.requestTimeoutMs,connected:!1,retiring:!1,detachStderr:d.detachStderr};e.onclose=()=>{let e=t.connected;t.connected=!1,t.disconnectReason=`mcp transport closed`,e&&!f&&!t.retiring&&x===t&&(scheduleCatalogServerRetry(`mcp transport closed`),b(`bundle-mcp: server "${r}" closed; next request reconnects`))};return t};if(!_)x=_=nemoClawCreateSession(d);const nemoClawConnectWithRetry=async()=>{await _e(a, p.signal, async () => {\n const signal = p.signal;\n signal.throwIfAborted();\n try {\n  await ensureSessionConnected(_, d.connectionTimeoutMs);\n } catch (error) {\n  signal.throwIfAborted();\n  if (v || d.transportType !== "streamable-http" || !nemoClawIsTransientMcpStartFailure(error)) throw error;\n  if (!await retireSessionIfCurrent(_) || nemoClawMcpCleanupFailed()) throw error;\n  await nemoClawMcpAbortableRetryDelay(signal);\n  failIfDisposed();\n  const retryResolved = resolveMcpTransport(r, u, {\n   cfg: e.cfg,\n   agentDir: e.agentDir,\n   prepareDataDir: t.prepareDataDirsByServer?.[r]?.dataDir,\n   requesterScope: e.requesterScope\n  });\n  if (!retryResolved || retryResolved.transportType !== "streamable-http") throw error;\n  d = retryResolved;\n  x = _ = nemoClawCreateSession(d);\n  b(`bundle-mcp: retrying transient startup failure for server "${r}" once with a fresh transport.`);\n  try {\n   await ensureSessionConnected(_, Math.min(d.connectionTimeoutMs, NEMOCLAW_MCP_RETRY_CONNECT_TIMEOUT_MS));\n  } catch (retryError) {\n   signal.throwIfAborted();\n   if (!nemoClawIsTransientMcpStartFailure(retryError)) throw retryError;\n   throw new Error(`${L(retryError)}${NEMOCLAW_MCP_TRANSIENT_DIAGNOSTIC_SUFFIX}`, {cause: retryError});\n  }\n }\n}, Q)};',
    ],
    [
      "let e=_;await _e(a,p.signal,()=>ensureSessionConnected(e,d.connectionTimeoutMs),Q)",
      "await nemoClawConnectWithRetry()",
    ],
    [
      "acquireLease(){d+=1;",
      "acquireLease(){if(d===0&&nemoClawCatalogHasStartDiagnostics(m)){Ce(a,p.signal);invalidateCatalog();}d+=1;",
    ],
  ],
  "worker-chunk-CbW6oavy.mjs": [
    [
      "function resetMcpStartupBackoff(e){e===void 0?Z.clear():Z.delete(e)}",
      "/* nemoclaw owner-scoped MCP next-lease recovery (#7958) */\nfunction resetMcpStartupBackoff(e, owner) {\n if (owner !== void 0) {\n  const state = Z.get(e);\n  if (state?.owner === owner && !state.pending) Z.delete(e);\n  return;\n }\n e===void 0?Z.clear():Z.delete(e);\n}",
    ],
  ],
};
