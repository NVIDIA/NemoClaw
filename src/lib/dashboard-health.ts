// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Dashboard chain health verification — checks all links of the delivery
 * chain and produces a per-link diagnosis. All deps injected.
 */

import type { DashboardDeliveryChain } from "./dashboard-contract";

export interface DashboardHealthDeps {
  executeSandboxCommand: (name: string, script: string) => { status: number; stdout: string } | null;
  captureForwardList: () => string | null;
  downloadSandboxConfig: (name: string) => { gateway?: { controlUi?: { allowedOrigins?: string[] } } } | null;
}

export interface LinkStatus { ok: boolean; detail: string }

export interface ChainStatus {
  healthy: boolean;
  links: { gateway: LinkStatus; forward: LinkStatus; cors: LinkStatus };
  diagnosis: string;
}

const ALIVE_CODES = new Set(["200", "401"]);

function verifyGateway(name: string, chain: DashboardDeliveryChain, deps: DashboardHealthDeps): LinkStatus {
  const result = deps.executeSandboxCommand(name,
    `curl -so /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:${chain.port}${chain.healthEndpoint} 2>/dev/null || echo 000`);
  if (!result) return { ok: false, detail: "sandbox unreachable" };
  const s = result.stdout.trim();
  return ALIVE_CODES.has(s) ? { ok: true, detail: `HTTP ${s}` } : { ok: false, detail: `HTTP ${s}` };
}

function verifyForward(name: string, chain: DashboardDeliveryChain, deps: DashboardHealthDeps): LinkStatus {
  const output = deps.captureForwardList();
  if (!output) return { ok: false, detail: `no forward for port ${chain.port}` };
  const portStr = String(chain.port);
  // openshell forward list columns: SANDBOX  BIND  PORT  PID  STATUS
  for (const line of output.split("\n")) {
    const p = line.trim().split(/\s+/);
    if (p[2] === portStr) {
      if (p[0] !== name) return { ok: false, detail: `port ${portStr} owned by ${p[0]}` };
      const status = (p[4] ?? "").toLowerCase();
      if (status && status !== "running") return { ok: false, detail: `forward ${status} (PID ${p[3] ?? "?"})` };
      return { ok: true, detail: `PID ${p[3] ?? "?"} on ${p[1] ?? "?"}` };
    }
  }
  return { ok: false, detail: `no forward for port ${chain.port}` };
}

function verifyCors(name: string, chain: DashboardDeliveryChain, deps: DashboardHealthDeps): LinkStatus {
  const config = deps.downloadSandboxConfig(name);
  if (!config) return { ok: false, detail: "could not download openclaw.json" };
  const origins = config.gateway?.controlUi?.allowedOrigins ?? [];
  let accessOrigin: string | null;
  try { accessOrigin = new URL(chain.accessUrl).origin; } catch { return { ok: false, detail: "bad accessUrl" }; }
  return origins.includes(accessOrigin)
    ? { ok: true, detail: `allowedOrigins includes ${accessOrigin}` }
    : { ok: false, detail: `missing ${accessOrigin} in allowedOrigins` };
}

export function verifyDashboardChain(name: string, chain: DashboardDeliveryChain, deps: DashboardHealthDeps): ChainStatus {
  const gateway = verifyGateway(name, chain, deps);
  const forward = verifyForward(name, chain, deps);
  const cors = verifyCors(name, chain, deps);
  const links = { gateway, forward, cors };
  const healthy = gateway.ok && forward.ok && cors.ok;
  const diagnosis = Object.entries(links).filter(([, l]) => !l.ok).map(([n, l]) => `${n}: ${l.detail}`).join("; ");
  return { healthy, links, diagnosis };
}
