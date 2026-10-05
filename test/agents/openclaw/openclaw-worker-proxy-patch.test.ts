// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { patchOpenClawWorkerProxyText } from "../../../scripts/lib/patch-openclaw-worker-proxy.mts";

// Exact expressions from the 2026.9.5 worker, with network calls replaced by
// observable return values. Locals retain their reviewed bundled identities.
const SOURCE = `
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

interface Runtime {
  namespace: { withStrictGuardedFetchMode(): (value: object) => { mode: string } };
  assertExplicitProxyAllowed(...args: unknown[]): Promise<void>;
  webFetch(
    value: object,
    proxy: boolean,
  ): { mode: string; policy: { allowedHostnames?: string[]; hostnameAllowlist?: string[] } };
  managed(mode: string, dispatcher?: object): boolean;
  preflight(): { mode: string; policy: { hostnameAllowlist: string[] } };
  timeout: number;
}

function runtime(sandbox: boolean): Runtime {
  return vm.runInNewContext(patchOpenClawWorkerProxyText(SOURCE), {
    process: { env: sandbox ? { OPENSHELL_SANDBOX: "1" } : {} },
    URL,
  }) as Runtime;
}

describe("OpenClaw 2026.9.5 worker proxy compatibility", () => {
  it("is idempotent and rejects missing, duplicate, and changed expressions", () => {
    const patched = patchOpenClawWorkerProxyText(SOURCE);
    expect(patchOpenClawWorkerProxyText(patched)).toBe(patched);
    expect(() => patchOpenClawWorkerProxyText(SOURCE.replace("15e3", "2e4"))).toThrow(/Unreviewed/);
    expect(() => patchOpenClawWorkerProxyText(SOURCE + SOURCE)).toThrow(/Unreviewed/);
    expect(() =>
      patchOpenClawWorkerProxyText(
        SOURCE.replace("isManagedProxyActive(),", "isManagedProxyActive()&&false,"),
      ),
    ).toThrow(/Unreviewed/);
  });

  it("allows the explicit sandbox proxy while preserving native validation outside it", async () => {
    await expect(
      runtime(true).assertExplicitProxyAllowed({ mode: "explicit-proxy" }),
    ).resolves.toBeUndefined();
    await expect(
      runtime(false).assertExplicitProxyAllowed({ mode: "explicit-proxy" }),
    ).rejects.toThrow("native proxy check");
  });

  it.each([
    [false, false, "host.openshell.internal"],
    [false, false, "10.0.0.1"],
    [false, false, "public.example"],
    [false, true, "host.openshell.internal"],
    [false, true, "10.0.0.1"],
    [false, true, "public.example"],
    [true, false, "host.openshell.internal"],
    [true, false, "10.0.0.1"],
    [true, false, "public.example"],
    [true, true, "host.openshell.internal"],
    [true, true, "10.0.0.1"],
    [true, true, "public.example"],
  ])("limits sandbox=%s proxy=%s web_fetch exceptions for %s", (sandbox, proxy, hostname) => {
    const policy = {
      allowedHostnames: ["existing.example"],
      hostnameAllowlist: ["host.openshell.internal"],
    };
    const result = runtime(sandbox).webFetch({ url: `http://${hostname}/`, policy }, proxy);
    expect(result.mode).toBe(proxy ? "trusted_env_proxy" : "strict");
    expect([...result.policy.allowedHostnames!]).toEqual(
      sandbox && proxy && hostname === "host.openshell.internal"
        ? ["existing.example", "host.openshell.internal"]
        : ["existing.example"],
    );
    expect(result.policy.hostnameAllowlist).toEqual(policy.hostnameAllowlist);
    expect(policy.allowedHostnames).toEqual(["existing.example"]);
  });

  it.each([false, true])(
    "preserves dispatchers and strict-fetch policy with sandbox=%s",
    (sandbox) => {
      const result = runtime(sandbox);
      expect(result.managed("strict")).toBe(sandbox);
      expect(result.managed("strict", { mode: "direct" })).toBe(false);
      expect(result.managed("strict", { mode: "explicit-proxy" })).toBe(false);
      expect(result.managed("trusted_env_proxy")).toBe(false);
    },
  );

  it("keeps the cron allowlist, media proxy export, and 60 second handshake timeout", () => {
    const result = runtime(true);
    expect(result.preflight().mode).toBe("trusted_env_proxy");
    expect(result.preflight().policy.hostnameAllowlist).toEqual(["inference.local"]);
    expect(result.namespace.withStrictGuardedFetchMode()({}).mode).toBe("trusted_env_proxy");
    expect(result.timeout).toBe(60_000);
  });
});
