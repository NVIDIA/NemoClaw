// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NO_PREPARATION_REF } from "./adapter-registry.js";
import {
  assertManagedClusterVllmExecutorConfig,
  buildManagedClusterVllmRunArgs,
  createManagedClusterVllmExecutor,
  inspectManagedClusterVllmNodesSync,
  type ManagedClusterVllmExecutorRuntimeDeps,
} from "./managed-cluster-executor.js";
import {
  fixtureManagedClusterPlan,
  fixtureManagedClusterSelection,
  STOPPED_FOREIGN_CONTAINER_FIXTURES,
} from "./managed-cluster-fixture.test-support.js";
import {
  MANAGED_CLUSTER_API_KEY_FINGERPRINT_LABEL,
  MANAGED_CLUSTER_TRANSACTION_LABEL,
  materializeManagedClusterVllmPlan,
  type ManagedClusterVllmPlan,
  type ManagedClusterVllmRole,
  type ManagedClusterVllmRolePlan,
} from "./managed-cluster-materialize.js";
import {
  createManagedVllmSshBindingFixture,
  type ManagedVllmSshBindingFixture,
} from "./managed-cluster-ssh-binding.test-support.js";

const API_KEY = "a".repeat(64);
const FINGERPRINT = "b".repeat(64);
const TRANSACTION_ID = "c".repeat(32);
const HEAD_ID = "1".repeat(64);
const FOREIGN_ID = "2".repeat(64);
const WORKER_ID = "3".repeat(64);
const LOCAL_CACHE_ROOT = "/home/nvidia/.cache/huggingface";
const PEER_CACHE_ROOT = "/home/spark/.cache/huggingface";

type DockerCaptureOptions = NonNullable<
  Parameters<ManagedClusterVllmExecutorRuntimeDeps["dockerCapture"]>[1]
>;

function bindPlan(
  fixture: ManagedVllmSshBindingFixture,
  plan = fixtureManagedClusterPlan(),
): ManagedClusterVllmPlan {
  return {
    ...plan,
    roles: [
      plan.roles[0],
      {
        ...plan.roles[1],
        execution: {
          kind: "ssh",
          expectedTarget: fixture.binding.peerTarget,
          bindingHandle: fixture.token,
        },
      },
    ],
  };
}

function launchLabels(rolePlan: ManagedClusterVllmRolePlan): Record<string, string> {
  return {
    ...rolePlan.baseLabels,
    [MANAGED_CLUSTER_API_KEY_FINGERPRINT_LABEL]: FINGERPRINT,
    [MANAGED_CLUSTER_TRANSACTION_LABEL]: TRANSACTION_ID,
  };
}

function inspectionRow(input: {
  id: string;
  name: string;
  image: string;
  running: boolean;
  labels: Readonly<Record<string, string>>;
}): string {
  return JSON.stringify([input.id, `/${input.name}`, input.image, input.running, input.labels]);
}

function successfulDockerResult(stdout = "") {
  return {
    pid: 123,
    output: [null, stdout, ""],
    stdout,
    stderr: "",
    status: 0,
    signal: null,
    error: undefined,
  };
}

function runtimeOverrides(
  overrides: Partial<ManagedClusterVllmExecutorRuntimeDeps> = {},
): Partial<ManagedClusterVllmExecutorRuntimeDeps> {
  return {
    dockerCapture: vi.fn(() => ""),
    dockerForceRm: vi.fn(() => successfulDockerResult()),
    dockerRunDetached: vi.fn(() => successfulDockerResult()),
    captureListeners: vi.fn(() => ""),
    createTransactionId: vi.fn(() => TRANSACTION_ID),
    now: vi.fn(() => 0),
    sleep: vi.fn(async () => undefined),
    withLifecycleLock: vi.fn(async (operation) => await operation()),
    ...overrides,
  };
}

type DockerCaptureHandler = (args: readonly string[], options?: DockerCaptureOptions) => string;

function fixedDockerCapture(value: string): DockerCaptureHandler {
  return () => value;
}

function unexpectedDockerCapture(args: readonly string[]): never {
  throw new Error(`unexpected Docker argv: ${args.join(" ")}`);
}

function routeDockerCapture(
  args: readonly string[],
  options: DockerCaptureOptions | undefined,
  handlers: {
    readonly quiet: DockerCaptureHandler;
    readonly inspect: DockerCaptureHandler;
    readonly exec: DockerCaptureHandler;
    readonly fallback: DockerCaptureHandler;
  },
): string {
  const handler = args.includes("--quiet")
    ? handlers.quiet
    : args.includes("inspect")
      ? handlers.inspect
      : args[0] === "exec"
        ? handlers.exec
        : handlers.fallback;
  return handler(args, options);
}

describe("managed-cluster vLLM executor", () => {
  let bindingFixture: ManagedVllmSshBindingFixture;
  let plan: ManagedClusterVllmPlan;

  beforeEach(() => {
    bindingFixture = createManagedVllmSshBindingFixture("spark-worker.local");
    plan = bindPlan(bindingFixture);
  });

  afterEach(() => {
    bindingFixture.cleanup();
    vi.restoreAllMocks();
  });

  it("builds the YAML-backed role launch without a restart policy or bearer value", () => {
    const head = plan.roles[0];
    const args = buildManagedClusterVllmRunArgs(head, LOCAL_CACHE_ROOT, launchLabels(head));
    const command = args.at(-1)!;

    expect(args).toEqual(
      expect.arrayContaining([
        "--pull=never",
        "--init",
        "--network",
        head.runtime.networkMode,
        "--ipc",
        head.runtime.ipcMode,
        "--shm-size",
        String(head.runtime.sharedMemoryBytes),
        "--gpus",
        head.runtime.gpuRequest,
        "--device",
        head.runtime.devices[0],
        "--ulimit",
        `memlock=${String(head.runtime.ulimits.memlock)}`,
        `stack=${String(head.runtime.ulimits.stack)}`,
        "--tmpfs",
        ...head.runtime.temporaryFilesystems.map(
          (filesystem) =>
            `${filesystem.target}:${[
              ...filesystem.options,
              `size=${String(filesystem.sizeBytes)}`,
              `mode=${filesystem.mode}`,
            ].join(",")}`,
        ),
        "--volume",
        `${LOCAL_CACHE_ROOT}/hub:${head.runtime.modelCache.target}/hub:ro`,
        "--env",
        "VLLM_API_KEY",
        head.image,
      ]),
    );
    expect(args).not.toContain("--restart");
    expect(args).not.toContain(`${LOCAL_CACHE_ROOT}:${head.runtime.modelCache.target}`);
    expect(JSON.stringify(args)).not.toContain(API_KEY);
    expect(command).toContain("install -m 0644 --");
    expect(head.preparation.ref).not.toBe(NO_PREPARATION_REF);
    const boundedPreparation = head.preparation as Exclude<
      typeof head.preparation,
      { ref: typeof NO_PREPARATION_REF }
    >;
    expect(command).toContain(boundedPreparation.snapshotCopy.targetPath);
    expect(command).toContain(boundedPreparation.snapshotCopy.digest);
    expect(command).toContain("snapshot copy source digest mismatch");
    expect(command.indexOf("snapshot copy source digest mismatch")).toBeLessThan(
      command.indexOf("install -m 0644 --"),
    );
    expect(command).toContain("preparation source text did not match exactly once");
    expect(command).not.toContain("--api-key");
    expect(command).not.toContain("$VLLM_API_KEY");
    expect(command).toContain("'--host' '192.168.100.10'");
    expect(command).toContain(`exec '${head.command.executable}'`);
  });

  it("dispatches the no-op preparation and YAML-backed executable without patch steps", () => {
    const head: ManagedClusterVllmRolePlan = {
      ...plan.roles[0],
      preparation: {
        ref: NO_PREPARATION_REF,
        phase: "container-before-exec",
        modelId: plan.model.id,
        modelRevision: plan.model.revision,
        modelDownloadSizeBytes: plan.roles[0].preparation.modelDownloadSizeBytes,
      },
      command: {
        executable: "/opt/vllm/bin/vllm",
        arguments: ["serve", "synthetic/model"],
      },
    };

    const command = buildManagedClusterVllmRunArgs(head, LOCAL_CACHE_ROOT, launchLabels(head)).at(
      -1,
    )!;

    expect(command).toContain("exec '/opt/vllm/bin/vllm' 'serve' 'synthetic/model'");
    expect(command).not.toContain("install -m");
    expect(command).not.toContain("python3 -c");
  });

  it("keeps the worker launch headless and free of the bearer environment key", () => {
    const worker = plan.roles[1];
    const args = buildManagedClusterVllmRunArgs(worker, PEER_CACHE_ROOT, launchLabels(worker));

    expect(args).not.toContain("VLLM_API_KEY");
    expect(args.at(-1)).toContain("'--headless'");
    expect(args.at(-1)).toContain("'--host' '192.168.100.11'");
    expect(args.at(-1)).not.toContain("--api-key");
    expect(args.at(-1)).not.toContain("$VLLM_API_KEY");
  });

  it("rejects a changed binding handoff before any Docker operation", () => {
    const changedPlan = {
      ...plan,
      roles: [
        plan.roles[0],
        {
          ...plan.roles[1],
          execution: {
            kind: "ssh" as const,
            expectedTarget: bindingFixture.binding.peerTarget,
            bindingHandle: "changed",
          },
        },
      ],
    };

    expect(() =>
      createManagedClusterVllmExecutor(
        {
          plan: changedPlan,
          nodes: [
            { nodeId: plan.roles[0].nodeId, modelCacheRoot: LOCAL_CACHE_ROOT },
            {
              nodeId: plan.roles[1].nodeId,
              modelCacheRoot: PEER_CACHE_ROOT,
              sshBinding: bindingFixture.binding,
            },
          ],
        },
        runtimeOverrides(),
      ),
    ).toThrow(/executor target .* is invalid/);
  });

  it("revalidates catalog-derived commands and exposes the same synchronous inspector", () => {
    const config = {
      plan,
      nodes: [
        { nodeId: plan.roles[0].nodeId, modelCacheRoot: LOCAL_CACHE_ROOT },
        {
          nodeId: plan.roles[1].nodeId,
          modelCacheRoot: PEER_CACHE_ROOT,
          sshBinding: bindingFixture.binding,
        },
      ],
    };
    expect(inspectManagedClusterVllmNodesSync(config, runtimeOverrides())).toEqual({
      nodes: [
        { nodeId: plan.roles[0].nodeId, snapshot: { containers: [], listeningPorts: [] } },
        { nodeId: plan.roles[1].nodeId, snapshot: { containers: [], listeningPorts: [] } },
      ],
    });

    const changedPlan: ManagedClusterVllmPlan = {
      ...plan,
      roles: [
        {
          ...plan.roles[0],
          command: {
            ...plan.roles[0].command,
            arguments: [...plan.roles[0].command.arguments, "--changed"],
          },
        },
        plan.roles[1],
      ],
    };
    expect(() => assertManagedClusterVllmExecutorConfig({ ...config, plan: changedPlan })).toThrow(
      /catalog-derived adapter contract/,
    );
  });

  it("revalidates a deployment-owned API port against the materialized command", () => {
    plan = bindPlan(
      bindingFixture,
      materializeManagedClusterVllmPlan(fixtureManagedClusterSelection(), { apiPort: 19_000 }),
    );
    const config = {
      plan,
      nodes: [
        { nodeId: plan.roles[0].nodeId, modelCacheRoot: LOCAL_CACHE_ROOT },
        {
          nodeId: plan.roles[1].nodeId,
          modelCacheRoot: PEER_CACHE_ROOT,
          sshBinding: bindingFixture.binding,
        },
      ],
    };

    expect(() => assertManagedClusterVllmExecutorConfig(config)).not.toThrow();
    expect(plan.roles[0].command.arguments).toEqual(
      expect.arrayContaining(["--port", "19000"]),
    );
  });

  it("validates selected definition digests without pinning the aggregate catalog", () => {
    const config = {
      plan,
      nodes: [
        { nodeId: plan.roles[0].nodeId, modelCacheRoot: LOCAL_CACHE_ROOT },
        {
          nodeId: plan.roles[1].nodeId,
          modelCacheRoot: PEER_CACHE_ROOT,
          sshBinding: bindingFixture.binding,
        },
      ],
    };
    const catalogExpandedElsewhere: ManagedClusterVllmPlan = {
      ...plan,
      catalogDigest: `sha256:${"e".repeat(64)}`,
    };

    expect(() =>
      assertManagedClusterVllmExecutorConfig({
        ...config,
        plan: catalogExpandedElsewhere,
      }),
    ).not.toThrow();
    expect(() =>
      assertManagedClusterVllmExecutorConfig({
        ...config,
        plan: { ...plan, recipeDigest: `sha256:${"f".repeat(64)}` },
      }),
    ).toThrow(/selected definition digests/u);
  });

  it("inspects every container plus host listeners and marks only the exact live role healthy", async () => {
    const headLabels = launchLabels(plan.roles[0]);
    const foreignLabels = { "example.foreign": "true" };
    const dockerCapture = vi.fn((args: readonly string[], options?: DockerCaptureOptions) =>
      routeDockerCapture(args, options, {
        quiet: fixedDockerCapture(`${HEAD_ID}\n${FOREIGN_ID}\n`),
        inspect: fixedDockerCapture(
          [
            inspectionRow({
              id: HEAD_ID,
              name: plan.roles[0].containerName,
              image: plan.roles[0].image,
              running: true,
              labels: headLabels,
            }),
            inspectionRow({
              id: FOREIGN_ID,
              name: "unrelated-service",
              image: "example.invalid/foreign:latest",
              running: true,
              labels: foreignLabels,
            }),
          ].join("\n"),
        ),
        exec: fixedDockerCapture("ready"),
        fallback: unexpectedDockerCapture,
      }),
    );
    const captureListeners = vi.fn(
      () =>
        `LISTEN 0 4096 0.0.0.0:${String(plan.apiPort)} 0.0.0.0:*\nLISTEN 0 128 [::]:${String(plan.masterPort)} [::]:*\n`,
    );
    const executor = createManagedClusterVllmExecutor(
      {
        plan,
        nodes: [
          { nodeId: plan.roles[0].nodeId, modelCacheRoot: LOCAL_CACHE_ROOT },
          {
            nodeId: plan.roles[1].nodeId,
            modelCacheRoot: PEER_CACHE_ROOT,
            sshBinding: bindingFixture.binding,
          },
        ],
      },
      runtimeOverrides({ dockerCapture, captureListeners }),
    );

    const snapshot = await executor.inspectNode(plan.roles[0]);

    expect(snapshot.listeningPorts).toEqual([plan.apiPort, plan.masterPort].sort((a, b) => a - b));
    expect(snapshot.containers).toHaveLength(2);
    expect(snapshot.containers[0]).toMatchObject({
      id: HEAD_ID,
      healthy: true,
    });
    expect(snapshot.containers[1]).toMatchObject({
      id: FOREIGN_ID,
      healthy: false,
    });
    expect(dockerCapture).toHaveBeenCalledWith(
      expect.arrayContaining(["container", "inspect", HEAD_ID, FOREIGN_ID]),
      expect.any(Object),
    );
  });

  it("fails closed when listener inspection is malformed", async () => {
    const executor = createManagedClusterVllmExecutor(
      {
        plan,
        nodes: [
          { nodeId: plan.roles[0].nodeId, modelCacheRoot: LOCAL_CACHE_ROOT },
          {
            nodeId: plan.roles[1].nodeId,
            modelCacheRoot: PEER_CACHE_ROOT,
            sshBinding: bindingFixture.binding,
          },
        ],
      },
      runtimeOverrides({ captureListeners: vi.fn(() => "not-an-ss-row") }),
    );

    await expect(executor.inspectNode(plan.roles[0])).rejects.toThrow(/listener inspection/);
  });

  it("does not declare the worker-first boundary once a head setup appears", async () => {
    const dockerCapture = vi.fn((args: readonly string[], options?: DockerCaptureOptions) => {
      const roleIndex = options?.env?.DOCKER_HOST ? 1 : 0;
      const rolePlan = plan.roles[roleIndex]!;
      const id = roleIndex === 1 ? WORKER_ID : HEAD_ID;
      return routeDockerCapture(args, options, {
        quiet: fixedDockerCapture(id),
        inspect: fixedDockerCapture(
          inspectionRow({
            id,
            name: rolePlan.containerName,
            image: rolePlan.image,
            running: true,
            labels: launchLabels(rolePlan),
          }),
        ),
        exec: fixedDockerCapture("ready"),
        fallback: unexpectedDockerCapture,
      });
    });
    let tick = 0;
    const executor = createManagedClusterVllmExecutor(
      {
        plan,
        nodes: [
          { nodeId: plan.roles[0].nodeId, modelCacheRoot: LOCAL_CACHE_ROOT },
          {
            nodeId: plan.roles[1].nodeId,
            modelCacheRoot: PEER_CACHE_ROOT,
            sshBinding: bindingFixture.binding,
          },
        ],
      },
      runtimeOverrides({
        dockerCapture,
        now: vi.fn(() => (tick += 1_000)),
      }),
    );

    await expect(
      executor.waitForWorkerDistributedReady({
        rolePlan: plan.roles[1],
        containerId: WORKER_ID,
        expectedLabels: launchLabels(plan.roles[1]),
        timeoutMs: 1,
      }),
    ).resolves.toBe(false);
  });

  it.each(
    STOPPED_FOREIGN_CONTAINER_FIXTURES,
  )("keeps the worker-first boundary closed for a stopped foreign $signal", async (foreign) => {
    const dockerCapture = vi.fn((args: readonly string[], options?: DockerCaptureOptions) => {
      const role = options?.env?.DOCKER_HOST ? "worker" : "head";
      const id = role === "worker" ? WORKER_ID : FOREIGN_ID;
      return routeDockerCapture(args, options, {
        quiet: fixedDockerCapture(id),
        inspect: fixedDockerCapture(
          role === "worker"
            ? inspectionRow({
                id,
                name: plan.roles[1].containerName,
                image: plan.roles[1].image,
                running: true,
                labels: launchLabels(plan.roles[1]),
              })
            : inspectionRow({
                id,
                name: foreign.name,
                image: foreign.image,
                running: false,
                labels: foreign.labels,
              }),
        ),
        exec: fixedDockerCapture("ready"),
        fallback: unexpectedDockerCapture,
      });
    });
    let tick = 0;
    const executor = createManagedClusterVllmExecutor(
      {
        plan,
        nodes: [
          { nodeId: plan.roles[0].nodeId, modelCacheRoot: LOCAL_CACHE_ROOT },
          {
            nodeId: plan.roles[1].nodeId,
            modelCacheRoot: PEER_CACHE_ROOT,
            sshBinding: bindingFixture.binding,
          },
        ],
      },
      runtimeOverrides({
        dockerCapture,
        now: vi.fn(() => (tick += 1_000)),
      }),
    );

    await expect(
      executor.waitForWorkerDistributedReady({
        rolePlan: plan.roles[1],
        containerId: WORKER_ID,
        expectedLabels: launchLabels(plan.roles[1]),
        timeoutMs: 1,
      }),
    ).resolves.toBe(false);
  });

  it("starts one exact head with the bearer only in the Docker subprocess environment", async () => {
    const labels = launchLabels(plan.roles[0]);
    const dockerCapture = vi.fn((args: readonly string[], options?: DockerCaptureOptions) =>
      routeDockerCapture(args, options, {
        quiet: fixedDockerCapture(HEAD_ID),
        inspect: fixedDockerCapture(
          inspectionRow({
            id: HEAD_ID,
            name: plan.roles[0].containerName,
            image: plan.roles[0].image,
            running: true,
            labels,
          }),
        ),
        exec: fixedDockerCapture("ready"),
        fallback: unexpectedDockerCapture,
      }),
    );
    const dockerRunDetached = vi.fn<ManagedClusterVllmExecutorRuntimeDeps["dockerRunDetached"]>(
      () => successfulDockerResult(`${HEAD_ID}\n`),
    );
    const executor = createManagedClusterVllmExecutor(
      {
        plan,
        nodes: [
          { nodeId: plan.roles[0].nodeId, modelCacheRoot: LOCAL_CACHE_ROOT },
          {
            nodeId: plan.roles[1].nodeId,
            modelCacheRoot: PEER_CACHE_ROOT,
            sshBinding: bindingFixture.binding,
          },
        ],
      },
      runtimeOverrides({ dockerCapture, dockerRunDetached }),
    );

    const result = await executor.startContainer({
      rolePlan: plan.roles[0],
      labels,
      preparation: plan.roles[0].preparation,
      bearerApiKey: API_KEY,
    });

    expect(result).toEqual({ ok: true, containerId: HEAD_ID });
    const [argv, options] = dockerRunDetached.mock.calls[0]!;
    expect(JSON.stringify(argv)).not.toContain(API_KEY);
    expect(JSON.stringify(argv)).not.toContain("--api-key");
    expect(JSON.stringify(argv)).not.toContain("$VLLM_API_KEY");
    expect(argv).toContain("VLLM_API_KEY");
    expect(options?.env?.VLLM_API_KEY).toBe(API_KEY);
    expect(options?.suppressOutput).toBe(true);
    expect(JSON.stringify(labels)).not.toContain(API_KEY);
  });

  it("injects staging targets but leaves cleanup construction usable without staging", async () => {
    const stageNode = vi.fn(async () => ({ ok: true }));
    const withStage = createManagedClusterVllmExecutor(
      {
        plan,
        nodes: [
          { nodeId: plan.roles[0].nodeId, modelCacheRoot: LOCAL_CACHE_ROOT },
          {
            nodeId: plan.roles[1].nodeId,
            modelCacheRoot: PEER_CACHE_ROOT,
            sshBinding: bindingFixture.binding,
          },
        ],
        stageNode,
      },
      runtimeOverrides(),
    );
    const withoutStage = createManagedClusterVllmExecutor(
      {
        plan,
        nodes: [
          { nodeId: plan.roles[0].nodeId, modelCacheRoot: LOCAL_CACHE_ROOT },
          {
            nodeId: plan.roles[1].nodeId,
            modelCacheRoot: PEER_CACHE_ROOT,
            sshBinding: bindingFixture.binding,
          },
        ],
      },
      runtimeOverrides(),
    );

    expect(
      await withStage.stageNode({
        rolePlan: plan.roles[1],
        preparation: plan.roles[1].preparation,
      }),
    ).toEqual({ ok: true });
    expect(stageNode).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        nodeId: plan.roles[1].nodeId,
        modelCacheRoot: PEER_CACHE_ROOT,
        sshBinding: bindingFixture.binding,
      }),
    );
    await expect(
      withoutStage.stageNode({
        rolePlan: plan.roles[0],
        preparation: plan.roles[0].preparation,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining("not configured"),
    });
  });

  it("removes only the revalidated exact container ID", async () => {
    const labels = launchLabels(plan.roles[0]);
    const dockerCapture = vi.fn((args: readonly string[], options?: DockerCaptureOptions) =>
      routeDockerCapture(args, options, {
        quiet: fixedDockerCapture(HEAD_ID),
        inspect: fixedDockerCapture(
          inspectionRow({
            id: HEAD_ID,
            name: plan.roles[0].containerName,
            image: plan.roles[0].image,
            running: false,
            labels,
          }),
        ),
        exec: fixedDockerCapture(""),
        fallback: fixedDockerCapture(""),
      }),
    );
    const dockerForceRm = vi.fn(() => successfulDockerResult());
    const executor = createManagedClusterVllmExecutor(
      {
        plan,
        nodes: [
          { nodeId: plan.roles[0].nodeId, modelCacheRoot: LOCAL_CACHE_ROOT },
          {
            nodeId: plan.roles[1].nodeId,
            modelCacheRoot: PEER_CACHE_ROOT,
            sshBinding: bindingFixture.binding,
          },
        ],
      },
      runtimeOverrides({ dockerCapture, dockerForceRm }),
    );

    await expect(executor.removeContainer(plan.roles[0], HEAD_ID)).resolves.toEqual({ ok: true });
    expect(dockerForceRm).toHaveBeenCalledWith(HEAD_ID, expect.any(Object));
    expect(dockerForceRm).not.toHaveBeenCalledWith(plan.roles[0].containerName, expect.anything());
  });

  it("performs bounded authenticated model and chat probes without putting the key in argv", async () => {
    const cleanup = vi.fn();
    const createBearerAuthConfig = vi.fn(() => ({
      args: ["--config", "/tmp/nemoclaw-probe/auth.conf"],
      trustedConfigFiles: ["/tmp/nemoclaw-probe/auth.conf"],
      cleanup,
    }));
    const runCurlProbe = vi
      .fn()
      .mockReturnValueOnce({
        ok: true,
        httpStatus: 200,
        curlStatus: 0,
        body: JSON.stringify({ data: [{ id: plan.model.servedName }] }),
        stderr: "",
        message: "",
      })
      .mockReturnValueOnce({
        ok: true,
        httpStatus: 200,
        curlStatus: 0,
        body: JSON.stringify({
          model: plan.model.servedName,
          choices: [{ message: {} }],
        }),
        stderr: "",
        message: "",
      });
    const executor = createManagedClusterVllmExecutor(
      {
        plan,
        nodes: [
          { nodeId: plan.roles[0].nodeId, modelCacheRoot: LOCAL_CACHE_ROOT },
          {
            nodeId: plan.roles[1].nodeId,
            modelCacheRoot: PEER_CACHE_ROOT,
            sshBinding: bindingFixture.binding,
          },
        ],
      },
      runtimeOverrides({ createBearerAuthConfig, runCurlProbe }),
    );
    const request = {
      baseUrl: plan.roles[0].endpoint!,
      apiKey: API_KEY,
      expectedModel: plan.model.servedName,
      timeoutMs: 10_000,
    };

    await expect(executor.probeModels(request)).resolves.toBe(true);
    await expect(executor.probeChat(request)).resolves.toBe(true);
    await expect(
      executor.probeModels({
        ...request,
        baseUrl: `http://attacker.invalid:${String(plan.apiPort)}`,
      }),
    ).resolves.toBe(false);
    runCurlProbe.mock.calls.forEach(([argv, options]) => {
      expect(JSON.stringify(argv)).not.toContain(API_KEY);
      expect(argv).toContain("--config");
      expect(options.pinnedAddresses).toEqual([]);
      expect(options.timeoutMs).toBeLessThanOrEqual(35_000);
    });
    expect(createBearerAuthConfig).toHaveBeenCalledWith(API_KEY, expect.any(Object));
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(runCurlProbe).toHaveBeenCalledTimes(2);
  });

  it("rejects API probes after a caller-owned plan changes", async () => {
    const mutablePlan = structuredClone(plan);
    const runCurlProbe = vi.fn();
    const executor = createManagedClusterVllmExecutor(
      {
        plan: mutablePlan,
        nodes: [
          { nodeId: mutablePlan.roles[0].nodeId, modelCacheRoot: LOCAL_CACHE_ROOT },
          {
            nodeId: mutablePlan.roles[1].nodeId,
            modelCacheRoot: PEER_CACHE_ROOT,
            sshBinding: bindingFixture.binding,
          },
        ],
      },
      runtimeOverrides({ runCurlProbe }),
    );
    const request = {
      baseUrl: mutablePlan.roles[0].endpoint!,
      apiKey: API_KEY,
      expectedModel: mutablePlan.model.servedName,
      timeoutMs: 10_000,
    };
    (mutablePlan.readiness as { expectedModel: string }).expectedModel = "mutated-model";

    await expect(executor.probeModels(request)).rejects.toThrow("changed materialized plan");
    await expect(executor.probeChat(request)).rejects.toThrow("changed materialized plan");
    expect(runCurlProbe).not.toHaveBeenCalled();
  });

  it("generates 32-hex transactions and serializes through the shared lifecycle lock", async () => {
    let lockCalls = 0;
    const withLifecycleLock = async <T>(operation: () => Promise<T>): Promise<T> => {
      lockCalls += 1;
      return await operation();
    };
    const executor = createManagedClusterVllmExecutor(
      {
        plan,
        nodes: [
          { nodeId: plan.roles[0].nodeId, modelCacheRoot: LOCAL_CACHE_ROOT },
          {
            nodeId: plan.roles[1].nodeId,
            modelCacheRoot: PEER_CACHE_ROOT,
            sshBinding: bindingFixture.binding,
          },
        ],
      },
      runtimeOverrides({
        createTransactionId: () => "d".repeat(32),
        withLifecycleLock,
      }),
    );

    expect(executor.createTransactionId()).toMatch(/^[a-f0-9]{32}$/);
    await expect(executor.withLifecycleLock(plan, async () => "done")).resolves.toBe("done");
    expect(lockCalls).toBe(1);
  });
});
