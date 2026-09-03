// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
const POOL_SNAPSHOT = {
  poolConfig: PREPARED_ROUTER.poolConfig,
  poolConfigPath: PREPARED_ROUTER.poolConfigPath,
  stateDir: PREPARED_ROUTER.stateDir,
};

function reconcileWithPreparedRouter(
  overrides: Parameters<typeof reconcileModelRouter>[0] = {},
): Promise<void> {
  return reconcileModelRouter({
    snapshotPool: () => POOL_SNAPSHOT,
    prepareRouter: () => PREPARED_ROUTER,
    ...overrides,
  });
}

const holder = vi.hoisted(() => ({
  currentRecoveryHash: "MATCHING-HASH" as string | null,
  legacyCredentialHash: "LEGACY-CREDENTIAL-HASH" as string | null,
  recordedRecoveryHash: "MATCHING-HASH" as string | null,
  snapshotBody: null as string | null,
  stop: (() => Promise.reject(new Error("router restart reached"))) as () => Promise<void>,
  stopped: [] as Array<[number, number]>,
  reachabilityProbes: 0,
  recoveryIdentityInputs: [] as string[],
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
  hashCredential: (value: string) => {
    const isRecoveryIdentity = value.startsWith("{");
    holder.recoveryIdentityInputs.push(...(isRecoveryIdentity ? [value] : []));
    return isRecoveryIdentity ? holder.currentRecoveryHash : holder.legacyCredentialHash;
  },
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
    holder.recoveryIdentityInputs = [];
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

    const prepareRouter = vi.fn(() => PREPARED_ROUTER);
    await reconcileWithPreparedRouter({ prepareRouter });

    expect(prepareRouter).not.toHaveBeenCalled();
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
    const snapshotPool = vi.fn(() => ({ ...POOL_SNAPSHOT, poolConfig: "models: [" }));
    const prepareRouter = vi.fn(() => PREPARED_ROUTER);

    await expect(reconcileModelRouter({ snapshotPool, prepareRouter })).rejects.toThrow(
      /Cannot read or parse Model Router pool configuration at .*pool-config\.yaml.*did not change the router process/,
    );

    expect(snapshotPool).toHaveBeenCalledOnce();
    expect(prepareRouter).not.toHaveBeenCalled();
    expect(holder.stopped).toEqual([]);
    expect(holder.reachabilityProbes).toBe(0);
  });

  it("preserves a healthy recorded router when the replacement model is retired (#10969)", async () => {
    holder.snapshotBody = JSON.stringify({
      healthy_endpoints: [{ api_base: "https://integrate.api.nvidia.com/v1" }],
      unhealthy_endpoints: [],
    });
    const realReadFile = fs.readFileSync.bind(fs);
    vi.spyOn(fs, "readFileSync").mockImplementation(((file, ...args) =>
      String(file).endsWith("router/pool-config.yaml")
        ? `routing:
  checkpoint: llm-router/checkpoints/prefill_router_qwen08b.pt
models:
  - name: nemotron-3-nano-reasoning
`
        : realReadFile(file, ...args)) as typeof fs.readFileSync);
    await expect(reconcileModelRouter()).rejects.toThrow(
      /configured model\(s\) retired from NVIDIA Endpoints: nemotron-3-nano-reasoning.*did not change the router process or recovery identity/,
    );

    expect(holder.stopped).toEqual([]);
    expect(holder.updatedSession).toBeNull();
    expect(holder.reachabilityProbes).toBe(0);
  });

  it("preserves a healthy recorded router when proxy-config rejects a YAML-valid pool", async () => {
    holder.snapshotBody = JSON.stringify({
      healthy_endpoints: [{ api_base: "https://integrate.api.nvidia.com/v1" }],
      unhealthy_endpoints: [],
    });
    holder.recordedRecoveryHash = "PREVIOUS-POOL-HASH";
    const prepareRouter = vi.fn(() => {
      throw new Error("model-router proxy-config failed: models must not be empty");
    });
    const startRouter = vi.fn(async () => 9876);

    await expect(
      reconcileModelRouter({
        snapshotPool: () => POOL_SNAPSHOT,
        prepareRouter,
        startRouter,
      }),
    ).rejects.toThrow(
      /Cannot validate replacement Model Router pool configuration at .*pool-config\.yaml.*models must not be empty.*Repair the reported problem.*did not change the router process or recovery identity/,
    );

    expect(prepareRouter).toHaveBeenCalledOnce();
    expect(startRouter).not.toHaveBeenCalled();
    expect(holder.stopped).toEqual([]);
    expect(holder.updatedSession).toBeNull();
    expect(holder.reachabilityProbes).toBe(0);
  });

  it("uses one protected pool snapshot when the source changes before router startup", async () => {
    holder.snapshotBody = JSON.stringify({
      healthy_endpoints: [{ api_base: "https://integrate.api.nvidia.com/v1" }],
      unhealthy_endpoints: [],
    });
    holder.recordedRecoveryHash = "PREVIOUS-POOL-HASH";
    holder.stop = async () => undefined;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-router-pool-snapshot-"));
    const rootDir = path.join(tmpDir, "repo");
    const homeDir = path.join(tmpDir, "home");
    const sourcePath = path.join(rootDir, "nemoclaw-blueprint", "router", "pool-config.yaml");
    const initialPool = `routing:
  checkpoint: llm-router/checkpoints/prefill_router_qwen08b.pt
models:
  - name: gpt-oss-20b-high
    litellm_model: openai/nvidia/openai/gpt-oss-20b
    api_base: https://integrate.api.nvidia.com/v1
`;
    const changedPool = `routing:
  checkpoint: llm-router/checkpoints/prefill_router_qwen08b.pt
models:
  - name: nemotron-3-nano-reasoning
    litellm_model: openai/nvidia/nvidia/nemotron-3-nano-30b-a3b
    api_base: https://integrate.api.nvidia.com/v1
`;
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, initialPool);
    let proxyConfigSnapshotPath = "";
    let proxyConfigPool = "";
    let routerSnapshotPath = "";
    let routerPool = "";

    try {
      await reconcileModelRouter({
        startDeps: {
          rootDir,
          homeDir,
          ensureModelRouterCommand: () => "/test/model-router",
          runProxyConfig: (_command, args) => {
            proxyConfigSnapshotPath = args[args.indexOf("--config") + 1];
            proxyConfigPool = fs.readFileSync(proxyConfigSnapshotPath, "utf8");
            fs.writeFileSync(sourcePath, changedPool);
            return { status: 0 };
          },
          spawnProxy: (_command, args) => {
            routerSnapshotPath = args[args.indexOf("--router-config") + 1];
            routerPool = fs.readFileSync(routerSnapshotPath, "utf8");
            return {
              pid: 9876,
              onError: () => undefined,
              onExit: () => undefined,
              unref: () => undefined,
            };
          },
          openRouterLog: () => null,
          buildSubprocessEnv: (extra) => extra,
          isRouterHealthy: async () => false,
          getRouterHealthSnapshot: async () => ({
            healthy: true,
            body: holder.snapshotBody,
          }),
          sleep: async () => undefined,
          now: () => 0,
          isProcessAlive: () => true,
          terminateProcess: () => undefined,
          getProviderKey: () => "",
        },
      });

      expect(fs.readFileSync(sourcePath, "utf8")).toBe(changedPool);
      expect(proxyConfigSnapshotPath).not.toBe(sourcePath);
      expect(routerSnapshotPath).toBe(proxyConfigSnapshotPath);
      expect(proxyConfigPool).toBe(initialPool);
      expect(routerPool).toBe(initialPool);
      expect(fs.statSync(routerSnapshotPath).mode & 0o777).toBe(0o400);
      expect(holder.recoveryIdentityInputs).toHaveLength(1);
      expect(holder.recoveryIdentityInputs[0]).toContain('"name":"gpt-oss-20b-high"');
      expect(holder.recoveryIdentityInputs[0]).not.toContain("nemotron-3-nano-reasoning");
      expect(holder.stopped).toEqual([[RECORDED_ROUTER_PID, expect.any(Number)]]);
      expect(holder.updatedSession).toMatchObject({
        routerPid: 9876,
        routerCredentialHash: "MATCHING-HASH",
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
