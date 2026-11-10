// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { WORKER_TOOL_CATALOG_EMBEDDED_SOURCE } from "./openclaw-worker-tool-catalog";
import fs from "node:fs";

export const WORKER_DEVICE_EMBEDDED_SOURCE = fs.readFileSync(
  new URL("../agents/openclaw/fixtures/device-worker-sqlite-store.worker.mjs.txt", import.meta.url),
  "utf8",
);

// Exact expressions from the 2026.9.5 worker, with network calls replaced by
// observable return values. Locals retain their reviewed bundled identities.
export const OPENCLAW_WORKER_PROXY_SOURCE = `
const GUARDED_FETCH_MODE={STRICT:"strict",TRUSTED_ENV_PROXY:"trusted_env_proxy"};
function withStrictGuardedFetchMode(x){return {...x,mode:"strict"}}
function withTrustedEnvProxyGuardedFetchMode(x){return {...x,mode:"trusted_env_proxy"}}
const namespace={withStrictGuardedFetchMode:()=>withStrictGuardedFetchMode};
async function assertExplicitProxyAllowed(Ot,Zt,_n,Dn,kn){throw Error("native proxy check")}
function fetchWithSsrFGuard(x){return x}
function webFetch(kn,_n){return fetchWithSsrFGuard(_n?withTrustedEnvProxyGuardedFetchMode(kn):withStrictGuardedFetchMode(kn))}
function isManagedProxyActive(){return false}
function managed(Ln,wi){let Mi=Ln===GUARDED_FETCH_MODE.STRICT&&isManagedProxyActive(),unused=0;return Mi}
function preflight(){return {policy:{hostnameAllowlist:["inference.local"]},auditContext:\`cron-model-provider-preflight\`}}
const DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS=15e3;
({namespace,assertExplicitProxyAllowed,webFetch,managed,preflight,timeout:DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS})
`;

export const WORKER_MCP_EMBEDDED_SOURCE = fs.readFileSync(
  new URL("../agents/openclaw/fixtures/mcp-worker-sqlite-store.worker.mjs.txt", import.meta.url),
  "utf8",
);

// Exact 2026.10.5 embedded expressions, with observable network stand-ins.
export const OPENCLAW_WORKER_ARCHIVE_PROXY_SOURCE =
  WORKER_MCP_EMBEDDED_SOURCE +
  WORKER_TOOL_CATALOG_EMBEDDED_SOURCE +
  "function sessionDeletion(){let wi=xr.canonicalKey!==`global`&&isAgentMainSessionKey(Ln,xr.canonicalKey);if((xr.canonicalKey===`global`||wi)&&!Si)return invalidSessionRequest(`Cannot delete the main session (${xr.canonicalKey}).`);}" +
  OPENCLAW_WORKER_PROXY_SOURCE.replace(
    "async function assertExplicitProxyAllowed(Ot,Zt,_n,Dn,kn){",
    "async function assertExplicitProxyAllowed(Ot,Kt,Zt,_n,Dn){",
  )
    .replace(
      "function webFetch(kn,_n){return fetchWithSsrFGuard(_n?withTrustedEnvProxyGuardedFetchMode(kn):withStrictGuardedFetchMode(kn))}",
      "function webFetch(Dn,Zt){return fetchWithSsrFGuard(Zt?withTrustedEnvProxyGuardedFetchMode(Dn):withStrictGuardedFetchMode(Dn))}",
    )
    .replace(
      "function managed(Ln,wi){let Mi=Ln===GUARDED_FETCH_MODE.STRICT&&isManagedProxyActive(),unused=0;return Mi}",
      "function managed(Jn,Di){let ea=Jn===GUARDED_FETCH_MODE.STRICT&&isManagedProxyActive(),unused=0;return ea}",
    );

export const OPENCLAW_WORKER_ARCHIVE_SOURCE =
  "{\n" + WORKER_DEVICE_EMBEDDED_SOURCE + "\n}\n" + OPENCLAW_WORKER_ARCHIVE_PROXY_SOURCE;
