// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { reconcileModelRouter } from "./model-router";
import {
  inspectModelRouterProcessForPort,
  type ModelRouterProcessLookup,
} from "./model-router-process";

const RECORDED_ROUTER_PID = 4321;
const tempDirs = new Set<string>();
const READY_ROUTER_HEALTH = JSON.stringify({
  healthy_endpoints: [{ api_base: "https://integrate.api.nvidia.com/v1" }],
  unhealthy_endpoints: [],
});
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
  createdFileIdentity: null,
  stateDir: PREPARED_ROUTER.stateDir,
};

function createSnapshotFiles(...digests: string[]): { stateDir: string; paths: string[] } {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-router-pool-cleanup-"));
  tempDirs.add(stateDir);
  const paths = digests.map((digest) =>
    path.join(stateDir, `model-router-pool-${digest.repeat(64)}.yaml`),
  );
  for (const snapshotPath of paths) {
    fs.writeFileSync(snapshotPath, "models: []\n", { mode: 0o400 });
  }
  return { stateDir, paths };
}

function fileIdentity(snapshotPath: string): { dev: number; ino: number } {
  const stats = fs.lstatSync(snapshotPath);
  return { dev: stats.dev, ino: stats.ino };
}

function snapshotAt(poolConfigPath: string, stateDir: string) {
  return {
    poolConfig: POOL_SNAPSHOT.poolConfig,
    poolConfigPath,
    createdFileIdentity: fileIdentity(poolConfigPath),
    stateDir,
  };
}

function preparedAt(poolConfigPath: string, stateDir: string) {
  return { ...PREPARED_ROUTER, poolConfigPath, stateDir };
}

function reconcileWithPreparedRouter(
  overrides: Parameters<typeof reconcileModelRouter>[0] = {},
): Promise<void> {
  return reconcileModelRouter({
    snapshotPool: () => POOL_SNAPSHOT,
    prepareRouter: () => PREPARED_ROUTER,
    poolSnapshotForProcess: () => null,
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
  processLookup: { status: "absent" } as ModelRouterProcessLookup,
  processArgs: null as string[] | null,
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
  inspectModelRouterProcessForPort: vi.fn(() => holder.processLookup),
  isModelRouterCommandLineForPort: vi.fn(() => true),
  readModelRouterProcessCommandLine: vi.fn(() => holder.processArgs),
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
    holder.processLookup = { status: "absent" };
    holder.processArgs = null;
    holder.updatedSession = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const tempDir of tempDirs) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDirs.clear();
  });

  function configureHealthyReplacement(): void {
    holder.snapshotBody = READY_ROUTER_HEALTH;
    holder.recordedRecoveryHash = "PREVIOUS-POOL-HASH";
    holder.stop = async () => undefined;
  }

  it("reuses a recorded router whose health snapshot names a healthy endpoint", async () => {
    holder.snapshotBody = READY_ROUTER_HEALTH;

    const prepareRouter = vi.fn(() => PREPARED_ROUTER);
    await reconcileWithPreparedRouter({ prepareRouter });

    expect(prepareRouter).not.toHaveBeenCalled();
    expect(holder.stopped).toEqual([]);
    expect(holder.reachabilityProbes).toBe(1);
  });

  it("discards a newly created raw snapshot when semantic recovery identity permits reuse", async () => {
    holder.snapshotBody = READY_ROUTER_HEALTH;
    holder.processLookup = { status: "found", pid: RECORDED_ROUTER_PID };
    const { stateDir, paths } = createSnapshotFiles("a", "b");
    const [activeSnapshotPath, unusedSnapshotPath] = paths;
    holder.processArgs = [
      "/test/model-router",
      "proxy",
      "--router-config",
      activeSnapshotPath,
      "--port",
      "4000",
    ];
    const prepareRouter = vi.fn(() => PREPARED_ROUTER);

    await reconcileModelRouter({
      snapshotPool: () => snapshotAt(unusedSnapshotPath, stateDir),
      prepareRouter,
    });

    expect(prepareRouter).not.toHaveBeenCalled();
    expect(fs.existsSync(activeSnapshotPath)).toBe(true);
    expect(fs.existsSync(unusedSnapshotPath)).toBe(false);
    expect(holder.stopped).toEqual([]);
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
    configureHealthyReplacement();
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
    configureHealthyReplacement();
    const startRouter = vi.fn(async () => Promise.reject(new Error("replacement exited")));

    await expect(reconcileWithPreparedRouter({ startRouter })).rejects.toThrow(
      /previous Model Router process was stopped.*replacement failed to start.*replacement exited.*Repair the reported problem and rerun onboarding/,
    );

    expect(holder.stopped).toEqual([[RECORDED_ROUTER_PID, expect.any(Number)]]);
    expect(holder.updatedSession).toBeNull();
    expect(holder.reachabilityProbes).toBe(0);
  });

  it("removes only the stopped router snapshot after its replacement becomes active", async () => {
    configureHealthyReplacement();
    const { stateDir, paths } = createSnapshotFiles("a", "b", "c");
    const [oldSnapshotPath, activeSnapshotPath, unrelatedSnapshotPath] = paths;
    const lookalikePath = path.join(stateDir, "model-router-pool-not-a-digest.yaml");
    fs.writeFileSync(lookalikePath, "models: []\n", { mode: 0o400 });
    holder.processArgs = [
      "/test/model-router",
      "proxy",
      "--router-config",
      oldSnapshotPath,
      "--port",
      "4000",
    ];
    const nextSnapshot = snapshotAt(activeSnapshotPath, stateDir);
    const prepared = preparedAt(activeSnapshotPath, stateDir);
    const startRouter = vi.fn(async () => {
      expect(holder.stopped).toEqual([[RECORDED_ROUTER_PID, expect.any(Number)]]);
      expect(fs.existsSync(oldSnapshotPath)).toBe(true);
      return 9876;
    });

    await reconcileModelRouter({
      snapshotPool: () => nextSnapshot,
      prepareRouter: () => prepared,
      startRouter,
    });

    expect(startRouter).toHaveBeenCalledOnce();
    expect(fs.existsSync(oldSnapshotPath)).toBe(false);
    expect(fs.existsSync(activeSnapshotPath)).toBe(true);
    expect(fs.existsSync(unrelatedSnapshotPath)).toBe(true);
    expect(fs.existsSync(lookalikePath)).toBe(true);
  });

  it("does not delete a replaced inode at the stopped router snapshot path", async () => {
    configureHealthyReplacement();
    const { stateDir, paths } = createSnapshotFiles("a", "b");
    const [oldSnapshotPath, activeSnapshotPath] = paths;
    const detachedPath = path.join(stateDir, "detached-old-snapshot.yaml");
    holder.processArgs = [
      "/test/model-router",
      "proxy",
      `--router-config=${oldSnapshotPath}`,
      "--port=4000",
    ];

    await reconcileModelRouter({
      snapshotPool: () => snapshotAt(activeSnapshotPath, stateDir),
      prepareRouter: () => preparedAt(activeSnapshotPath, stateDir),
      startRouter: async () => {
        fs.renameSync(oldSnapshotPath, detachedPath);
        fs.writeFileSync(oldSnapshotPath, "replacement inode\n", { mode: 0o400 });
        return 9876;
      },
    });

    expect(fs.readFileSync(oldSnapshotPath, "utf8")).toBe("replacement inode\n");
    expect(fs.existsSync(detachedPath)).toBe(true);
  });

  it("removes a newly created snapshot when replacement validation fails before startup", async () => {
    configureHealthyReplacement();
    holder.processLookup = { status: "found", pid: RECORDED_ROUTER_PID };
    const { stateDir, paths } = createSnapshotFiles("a", "b");
    const [oldSnapshotPath, failedSnapshotPath] = paths;
    holder.processArgs = [
      "/test/model-router",
      "proxy",
      "--router-config",
      oldSnapshotPath,
      "--port=4000",
    ];
    const failedSnapshot = snapshotAt(failedSnapshotPath, stateDir);
    const startRouter = vi.fn(async () => 9876);

    await expect(
      reconcileModelRouter({
        snapshotPool: () => failedSnapshot,
        prepareRouter: () => {
          throw new Error("proxy-config rejected replacement");
        },
        startRouter,
        poolSnapshotForProcess: () => null,
      }),
    ).rejects.toThrow(/Cannot validate replacement.*proxy-config rejected replacement/);

    expect(fs.existsSync(failedSnapshotPath)).toBe(false);
    expect(fs.existsSync(oldSnapshotPath)).toBe(true);
    expect(holder.stopped).toEqual([]);
    expect(startRouter).not.toHaveBeenCalled();
  });

  it.each([
    {
      reason: "no live router is found",
      lookup: { status: "absent" as const },
      liveCandidate: false,
      retained: false,
    },
    {
      reason: "the candidate still appears live",
      lookup: { status: "found" as const, pid: 9876 },
      liveCandidate: true,
      retained: true,
    },
    {
      reason: "process inventory is unavailable",
      lookup: { status: "unavailable" as const },
      liveCandidate: false,
      retained: true,
    },
  ])(
    "handles a failed-start snapshot safely when $reason",
    async ({ lookup, liveCandidate, retained }) => {
      configureHealthyReplacement();
      holder.processLookup = lookup;
      holder.stop = async () => undefined;
      const { stateDir, paths } = createSnapshotFiles("b");
      const [failedSnapshotPath] = paths;
      holder.processArgs = liveCandidate
        ? [
            "/test/model-router",
            "proxy",
            `--router-config=${failedSnapshotPath}`,
            "--port=4000",
          ]
        : null;
      vi.mocked(inspectModelRouterProcessForPort).mockClear();

      await expect(
        reconcileModelRouter({
          snapshotPool: () => snapshotAt(failedSnapshotPath, stateDir),
          prepareRouter: () => preparedAt(failedSnapshotPath, stateDir),
          startRouter: async () => Promise.reject(new Error("replacement exited")),
          poolSnapshotForProcess: () => null,
        }),
      ).rejects.toThrow(/replacement failed to start.*replacement exited/);

      expect(fs.existsSync(failedSnapshotPath)).toBe(retained);
      expect(inspectModelRouterProcessForPort).toHaveBeenCalledOnce();
    },
  );

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
