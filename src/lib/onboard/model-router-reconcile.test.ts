// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import { reconcileModelRouter } from "./model-router";
import {
  probeHostServiceSandboxReachability,
  formatHostServiceUnreachableMessage,
} from "./host-service-reachability";
import { saveCredential } from "../credentials/store";

const RECORDED_ROUTER_PID = 4321;

const holder = vi.hoisted(() => ({
  responsive: true,
  snapshotBody: null as string | null,
  snapshotCalls: 0,
  stopped: [] as Array<[number, number]>,
  reachabilityProbes: 0,
  routerPort: 4000 as number | null,
  updatedRouterPorts: [] as Array<number | null>,
}));

// `stopModelRouterProcess` throws a sentinel so each case ends at the
// reuse decision. Restarting the router is `startModelRouter`'s contract and
// is covered by `test/onboarding/onboard-model-router.test.ts`.
vi.mock("./model-router-process", () => ({
  ROUTER_HEALTH_TIMEOUT_MS: 3_000,
  getRouterHealthSnapshot: vi.fn(async () => {
    holder.snapshotCalls += 1;
    return {
      healthy: true,
      body: holder.snapshotBody,
      capturedBodyBytes: Buffer.byteLength(holder.snapshotBody ?? ""),
      elapsedMs: 45_000,
      outcome: "complete",
      statusCode: 200,
    };
  }),
  isRouterResponsive: vi.fn(async () => holder.responsive),
  doesModelRouterProcessOwnPort: vi.fn(() => true),
  inspectModelRouterProcessForPort: vi.fn(() => ({ status: "absent" as const })),
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
    routerPort: holder.routerPort,
    routerCredentialHash: "MATCHING-HASH",
  }),
  updateSession: vi.fn((update: (session: { routerPort: number | null }) => unknown) => {
    const current = { routerPort: holder.routerPort };
    update(current);
    holder.updatedRouterPorts.push(current.routerPort);
  }),
}));

vi.mock("../security/credential-hash", () => ({ hashCredential: () => "MATCHING-HASH" }));

vi.mock("./host-service-reachability", () => ({
  probeHostServiceSandboxReachability: vi.fn(async () => {
    holder.reachabilityProbes += 1;
    return { ok: true };
  }),
  formatHostServiceUnreachableMessage: vi.fn(
    () => "Inspect the selected bridge and its firewall rules.",
  ),
}));

describe("model router reconciliation", () => {
  beforeEach(() => {
    holder.responsive = true;
    holder.snapshotBody = null;
    holder.snapshotCalls = 0;
    holder.stopped = [];
    holder.reachabilityProbes = 0;
    holder.routerPort = 4000;
    holder.updatedRouterPorts = [];
  });

  it("reuses a recorded router whose health snapshot names a healthy endpoint", async () => {
    holder.snapshotBody = JSON.stringify({
      healthy_endpoints: [{ api_base: "https://integrate.api.nvidia.com/v1" }],
      unhealthy_endpoints: [],
    });

    await reconcileModelRouter();

    expect(holder.stopped).toEqual([]);
    expect(holder.reachabilityProbes).toBe(1);
    expect(holder.updatedRouterPorts).toEqual([]);
  });

  it("reuses a healthy native router when the historical Docker bridge is blocked", async () => {
    holder.snapshotBody = JSON.stringify({ healthy_endpoints: [{}] });
    vi.mocked(probeHostServiceSandboxReachability).mockImplementationOnce(async (options) => {
      // Native supervisor capability is supplied by the runtime provider. A
      // bridge-only probe would report the stale UFW failure for this host.
      return (options as { nativeSupervisorNetwork?: boolean }).nativeSupervisorNetwork
        ? { ok: true, reason: "ok", networkName: "host", gatewayIp: "127.0.0.1" }
        : {
            ok: false,
            reason: "tcp_failed",
            networkName: "openshell-cluster-nemoclaw",
            detail: "UFW blocks bridge",
          };
    });
    await expect(reconcileModelRouter()).resolves.toBeUndefined();
    expect(probeHostServiceSandboxReachability).toHaveBeenCalledWith({
      port: 4000,
      nativeSupervisorNetwork: true,
    });
    expect(holder.stopped).toEqual([]);
  });

  it.each([
    ["host", "  Check that Model Router listens on 127.0.0.1:4000 for the native supervisor.", 0],
    ["openshell-cluster-nemoclaw", "Inspect the selected bridge and its firewall rules.", 1],
  ] as const)(
    "reports the correct repair for unreachable %s routing",
    async (networkName, message, bridgeCalls) => {
      holder.snapshotBody = JSON.stringify({ healthy_endpoints: [{}] });
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.mocked(probeHostServiceSandboxReachability).mockResolvedValueOnce({
        ok: false,
        reason: "tcp_failed",
        networkName,
      });
      await expect(reconcileModelRouter()).rejects.toThrow("cannot reach the Model Router");
      expect(error).toHaveBeenCalledWith(message);
      expect(formatHostServiceUnreachableMessage).toHaveBeenCalledTimes(bridgeCalls);
      expect(holder.stopped).toEqual([]);
    },
  );

  it("backfills the cleanup port when reusing a legacy router session", async () => {
    holder.routerPort = null;
    holder.snapshotBody = JSON.stringify({
      healthy_endpoints: [{ api_base: "https://integrate.api.nvidia.com/v1" }],
      unhealthy_endpoints: [],
    });

    await reconcileModelRouter();

    expect(holder.updatedRouterPorts).toEqual([4000]);
  });

  it("retains the router receipt and credential when the configured port changes", async () => {
    holder.routerPort = 14000;
    holder.snapshotBody = JSON.stringify({ healthy_endpoints: [{}] });
    vi.mocked(saveCredential).mockClear();

    await expect(reconcileModelRouter()).rejects.toThrow(/recorded Model Router port 14000/);

    expect(holder.routerPort).toBe(14000);
    expect(holder.updatedRouterPorts).toEqual([]);
    expect(holder.stopped).toEqual([]);
    expect(holder.snapshotCalls).toBe(0);
    expect(saveCredential).not.toHaveBeenCalled();

    holder.routerPort = 4000;
    await reconcileModelRouter();
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

  it("restarts the recorded router when liveness fails without starting a duplicate (#12089)", async () => {
    holder.responsive = false;

    await expect(reconcileModelRouter()).rejects.toThrow("router restart reached");

    expect(holder.snapshotCalls).toBe(0);
    expect(holder.stopped).toEqual([[RECORDED_ROUTER_PID, expect.any(Number)]]);
  });
});
