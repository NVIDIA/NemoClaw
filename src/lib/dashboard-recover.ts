// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Dashboard chain recovery — link-aware, idempotent. All deps injected.
 */

import type { DashboardDeliveryChain } from "./dashboard-contract";
import type { DashboardHealthDeps, ChainStatus } from "./dashboard-health";
import { verifyDashboardChain } from "./dashboard-health";

export interface DashboardRecoverDeps extends DashboardHealthDeps {
  restartGateway: (name: string, port: number, agent: unknown) => boolean;
  stopForward: (port: number) => void;
  startForward: (target: string, name: string) => void;
  getSessionAgent: (name: string) => unknown;
}

export interface RecoverResult {
  attempted: boolean;
  before: ChainStatus;
  after: ChainStatus | null;
  actions: string[];
}

/** Recover broken links in order: gateway → forward → CORS (diagnose-only). */
export function recoverDashboardChain(name: string, chain: DashboardDeliveryChain, deps: DashboardRecoverDeps): RecoverResult {
  const before = verifyDashboardChain(name, chain, deps);
  if (before.healthy) return { attempted: false, before, after: null, actions: [] };

  const actions: string[] = [];
  if (!before.links.gateway.ok) {
    const ok = deps.restartGateway(name, chain.port, deps.getSessionAgent(name));
    actions.push(ok ? "restarted gateway" : "gateway restart failed");
  }
  if (!before.links.forward.ok) {
    deps.stopForward(chain.port);
    deps.startForward(chain.forwardTarget, name);
    actions.push("re-established forward");
  }
  if (!before.links.cors.ok) {
    actions.push(`CORS mismatch — rebuild required (${before.links.cors.detail})`);
  }

  const after = verifyDashboardChain(name, chain, deps);
  return { attempted: true, before, after, actions };
}
