// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import { reconcileModelRouter } from "./model-router";

const RECORDED_ROUTER_PID = 4321;

const holder = vi.hoisted(() => ({
  snapshotBody: null as string | null,
  stopped: [] as Array<[number, number]>,
  reachabilityProbes: 0,
}));

// `stopModelRouterProcess` throws a sentinel so each case ends at the
// reuse decision. Restarting the router is `startModelRouter`'s contract and
// is covered by `test/onboarding/onboard-model-router.test.ts`.
vi.mock("./model-router-process", () => ({
  ROUTER_HEALTH_TIMEOUT_MS: 3_000,
  getRouterHealthSnapshot: vi.fn(async () => ({ healthy: true, body: holder.snapshotBody })),
  isRouterHealthy: vi.fn(async () => true),
  doesModelRouterProcessOwnPort: vi.fn(() => true),
  inspectModelRouterProcessForPort: vi.fn(() => ({ status: "missing" as const })),
  stopModelRouterProcess: vi.fn(async (pid: number, port: number) => {
    holder.stopped.push([pid, port]);
    throw new Error("router restart reached");
  }),
}));

vi.mock("../credentials/store", () => ({
  normalizeCredentialValue: (value: string) => value,
  resolveProviderCredential: () => "",
  saveCredential: vi.fn(),
}));

vi.mock("./credential-env", () => ({
  hydrateCredentialEnv: () => "nvapi-TEST-NOT-A-REAL-ROUTER-KEY",
}));

vi.mock("../state/onboard-session", () => ({
  loadSession: () => ({
    routerPid: RECORDED_ROUTER_PID,
    routerCredentialHash: "MATCHING-HASH",
  }),
  updateSession: vi.fn(),
}));

vi.mock("../security/credential-hash", () => ({ hashCredential: () => "MATCHING-HASH" }));

vi.mock("./host-service-reachability", () => ({
  probeHostServiceSandboxReachability: vi.fn(async () => {
    holder.reachabilityProbes += 1;
    return { ok: true };
  }),
  formatHostServiceUnreachableMessage: () => "",
}));

describe("model router reconciliation", () => {
  beforeEach(() => {
    holder.snapshotBody = null;
    holder.stopped = [];
    holder.reachabilityProbes = 0;
  });

  it("reuses a recorded router whose health snapshot names a healthy endpoint", async () => {
    holder.snapshotBody = JSON.stringify({
      healthy_endpoints: [{ api_base: "https://integrate.api.nvidia.com/v1" }],
      unhealthy_endpoints: [],
    });

    await reconcileModelRouter();

    expect(holder.stopped).toEqual([]);
    expect(holder.reachabilityProbes).toBe(1);
  });

  it("restarts a recorded router that answers 2xx with no healthy endpoint (#9437)", async () => {
    holder.snapshotBody = JSON.stringify({
      healthy_endpoints: [],
      unhealthy_endpoints: [{ api_base: "https://integrate.api.nvidia.com/v1" }],
    });

    await expect(reconcileModelRouter()).rejects.toThrow("router restart reached");

    expect(holder.stopped).toEqual([[RECORDED_ROUTER_PID, expect.any(Number)]]);
    expect(holder.reachabilityProbes).toBe(0);
  });
});
