// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { reconcileModelRouter } from "./model-router";

const RECORDED_ROUTER_PID = 4321;
const PREPARED_ROUTER = {
  blueprintDir: "/test/repo/nemoclaw-blueprint",
  litellmConfigPath: "/test/state/litellm-proxy.yaml",
  poolConfig: "models: []\n",
  poolConfigPath: "/test/repo/nemoclaw-blueprint/router/pool-config.yaml",
  routerCommand: "/test/model-router",
  stateDir: "/test/state",
};

function reconcileWithPreparedRouter(
  overrides: Parameters<typeof reconcileModelRouter>[0] = {},
): Promise<void> {
  return reconcileModelRouter({ prepareRouter: () => PREPARED_ROUTER, ...overrides });
}

const holder = vi.hoisted(() => ({
  currentRecoveryHash: "MATCHING-HASH" as string | null,
  legacyCredentialHash: "LEGACY-CREDENTIAL-HASH" as string | null,
  recordedRecoveryHash: "MATCHING-HASH" as string | null,
  snapshotBody: null as string | null,
  stop: (() => Promise.reject(new Error("router restart reached"))) as () => Promise<void>,
  stopped: [] as Array<[number, number]>,
  reachabilityProbes: 0,
  updatedSession: null as {
    routerPid?: number | null;
    routerCredentialHash?: string | null;
  } | null,
}));

vi.mock("./model-router-process", () => ({
  ROUTER_HEALTH_TIMEOUT_MS: 3_000,
  getRouterHealthSnapshot: vi.fn(async () => ({ healthy: true, body: holder.snapshotBody })),
  isRouterHealthy: vi.fn(async () => true),
  doesModelRouterProcessOwnPort: vi.fn(() => true),
  inspectModelRouterProcessForPort: vi.fn(() => ({ status: "missing" as const })),
  stopModelRouterProcess: vi.fn(async (pid: number, port: number) => {
    holder.stopped.push([pid, port]);
    await holder.stop();
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
    routerCredentialHash: holder.recordedRecoveryHash,
  }),
  updateSession: vi.fn(
    (
      updater: (session: { routerPid?: number | null; routerCredentialHash?: string | null }) => {
        routerPid?: number | null;
        routerCredentialHash?: string | null;
      },
    ) => {
      holder.updatedSession = updater({
        routerPid: RECORDED_ROUTER_PID,
        routerCredentialHash: holder.recordedRecoveryHash,
      });
    },
  ),
}));

vi.mock("../security/credential-hash", () => ({
  hashCredential: (value: string) =>
    value.startsWith("{") ? holder.currentRecoveryHash : holder.legacyCredentialHash,
}));

vi.mock("./host-service-reachability", () => ({
  probeHostServiceSandboxReachability: vi.fn(async () => {
    holder.reachabilityProbes += 1;
    return { ok: true };
  }),
  formatHostServiceUnreachableMessage: () => "",
}));

describe("model router reconciliation", () => {
  beforeEach(() => {
    holder.currentRecoveryHash = "MATCHING-HASH";
    holder.legacyCredentialHash = "LEGACY-CREDENTIAL-HASH";
    holder.recordedRecoveryHash = "MATCHING-HASH";
    holder.snapshotBody = null;
    holder.stop = () => Promise.reject(new Error("router restart reached"));
    holder.stopped = [];
    holder.reachabilityProbes = 0;
    holder.updatedSession = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reuses a recorded router whose health snapshot names a healthy endpoint", async () => {
    holder.snapshotBody = JSON.stringify({
      healthy_endpoints: [{ api_base: "https://integrate.api.nvidia.com/v1" }],
      unhealthy_endpoints: [],
    });

    await reconcileWithPreparedRouter();

    expect(holder.stopped).toEqual([]);
    expect(holder.reachabilityProbes).toBe(1);
  });

  it("restarts a recorded router that answers 2xx with no healthy endpoint (#9437)", async () => {
    holder.snapshotBody = JSON.stringify({
      healthy_endpoints: [],
      unhealthy_endpoints: [{ api_base: "https://integrate.api.nvidia.com/v1" }],
    });

    await expect(reconcileWithPreparedRouter()).rejects.toThrow("router restart reached");

    expect(holder.stopped).toEqual([[RECORDED_ROUTER_PID, expect.any(Number)]]);
    expect(holder.reachabilityProbes).toBe(0);
  });

  it("replaces a healthy recorded router and persists its new pool recovery identity", async () => {
    holder.snapshotBody = JSON.stringify({
      healthy_endpoints: [{ api_base: "https://integrate.api.nvidia.com/v1" }],
      unhealthy_endpoints: [],
    });
    holder.recordedRecoveryHash = "PREVIOUS-POOL-HASH";
    holder.stop = async () => undefined;
    const startRouter = vi.fn(async () => 9876);

    await reconcileWithPreparedRouter({ startRouter });

    expect(holder.stopped).toEqual([[RECORDED_ROUTER_PID, expect.any(Number)]]);
    expect(startRouter).toHaveBeenCalledOnce();
    expect(holder.updatedSession).toMatchObject({
      routerPid: 9876,
      routerCredentialHash: "MATCHING-HASH",
    });
    expect(holder.reachabilityProbes).toBe(1);
  });

  it("reports a recovery action when a validated replacement fails after stopping the router", async () => {
    holder.snapshotBody = JSON.stringify({
      healthy_endpoints: [{ api_base: "https://integrate.api.nvidia.com/v1" }],
      unhealthy_endpoints: [],
    });
    holder.recordedRecoveryHash = "PREVIOUS-POOL-HASH";
    holder.stop = async () => undefined;
    const startRouter = vi.fn(async () => Promise.reject(new Error("replacement exited")));

    await expect(reconcileWithPreparedRouter({ startRouter })).rejects.toThrow(
      /previous Model Router process was stopped.*replacement failed to start.*replacement exited.*Repair the reported problem and rerun onboarding/,
    );

    expect(holder.stopped).toEqual([[RECORDED_ROUTER_PID, expect.any(Number)]]);
    expect(holder.updatedSession).toBeNull();
    expect(holder.reachabilityProbes).toBe(0);
  });

  it("restarts a healthy router recorded before pool identity tracking", async () => {
    holder.snapshotBody = JSON.stringify({
      healthy_endpoints: [{ api_base: "https://integrate.api.nvidia.com/v1" }],
      unhealthy_endpoints: [],
    });
    holder.recordedRecoveryHash = holder.legacyCredentialHash;

    await expect(reconcileWithPreparedRouter()).rejects.toThrow("router restart reached");

    expect(holder.stopped).toEqual([[RECORDED_ROUTER_PID, expect.any(Number)]]);
    expect(holder.reachabilityProbes).toBe(0);
  });

  it("preserves a healthy recorded router when the pool configuration is invalid", async () => {
    holder.snapshotBody = JSON.stringify({
      healthy_endpoints: [{ api_base: "https://integrate.api.nvidia.com/v1" }],
      unhealthy_endpoints: [],
    });
    const realReadFile = fs.readFileSync.bind(fs);
    vi.spyOn(fs, "readFileSync").mockImplementation(((file, ...args) =>
      String(file).endsWith("router/pool-config.yaml")
        ? "models: ["
        : realReadFile(file, ...args)) as typeof fs.readFileSync);

    await expect(reconcileWithPreparedRouter()).rejects.toThrow(
      /Cannot read or parse Model Router pool configuration at .*pool-config\.yaml.*did not change the router process/,
    );

    expect(holder.stopped).toEqual([]);
    expect(holder.reachabilityProbes).toBe(0);
  });

  it("preserves a healthy recorded router when proxy-config rejects a YAML-valid pool", async () => {
    holder.snapshotBody = JSON.stringify({
      healthy_endpoints: [{ api_base: "https://integrate.api.nvidia.com/v1" }],
      unhealthy_endpoints: [],
    });
    holder.recordedRecoveryHash = "PREVIOUS-POOL-HASH";
    const realReadFile = fs.readFileSync.bind(fs);
    vi.spyOn(fs, "readFileSync").mockImplementation(((file, ...args) =>
      String(file).endsWith("router/pool-config.yaml")
        ? "models: []\n"
        : realReadFile(file, ...args)) as typeof fs.readFileSync);
    const prepareRouter = vi.fn(() => {
      throw new Error("model-router proxy-config failed: models must not be empty");
    });
    const startRouter = vi.fn(async () => 9876);

    await expect(reconcileModelRouter({ prepareRouter, startRouter })).rejects.toThrow(
      /Cannot validate replacement Model Router pool configuration at .*pool-config\.yaml.*models must not be empty.*Repair the reported problem.*did not change the router process or recovery identity/,
    );

    expect(prepareRouter).toHaveBeenCalledOnce();
    expect(startRouter).not.toHaveBeenCalled();
    expect(holder.stopped).toEqual([]);
    expect(holder.updatedSession).toBeNull();
    expect(holder.reachabilityProbes).toBe(0);
  });
});
