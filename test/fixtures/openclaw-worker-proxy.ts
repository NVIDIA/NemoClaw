// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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
