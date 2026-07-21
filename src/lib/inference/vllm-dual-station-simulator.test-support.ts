// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  DUAL_STATION_VLLM_RUNTIME,
  NEMOCLAW_DGX_STATION_PEER_ENV,
  probeDualStationVllmCapability,
  type StationClusterProbeDeps,
  type StationHostProbe,
  type StationProbeCommandResult,
  type StationRailConnectivityRequest,
} from "./vllm-station-cluster";
import {
  DUAL_STATION_VLLM_API_KEY_FINGERPRINT_LABEL,
  DUAL_STATION_VLLM_CLUSTER_LABEL,
  DUAL_STATION_VLLM_ENDPOINT_LABEL,
  DUAL_STATION_VLLM_GPU_LABEL,
  DUAL_STATION_VLLM_GPU_SMOKE_LABEL,
  DUAL_STATION_VLLM_HEAD_CONTAINER_NAME,
  DUAL_STATION_VLLM_LAUNCH_CONTRACT_LABEL,
  DUAL_STATION_VLLM_LAUNCH_SCHEMA_LABEL,
  DUAL_STATION_VLLM_MANAGED_LABEL,
  DUAL_STATION_VLLM_ROLE_LABEL,
  DUAL_STATION_VLLM_TRANSACTION_LABEL,
  DUAL_STATION_VLLM_WORKER_CONTAINER_NAME,
  type DualStationDockerOptions,
  type DualStationVllmLifecycleDeps,
} from "./vllm-station-cluster-lifecycle";
import { NEMOCLAW_DGX_STATION_SSH_BINDING_ENV } from "./vllm-station-ssh-binding";
import {
  createDualStationSshBindingFixture,
  type DualStationSshBindingFixture,
} from "./vllm-station-ssh-binding.test-support";

export const DUAL_STATION_SIMULATOR_API_KEY = "a".repeat(64);
export const DUAL_STATION_SIMULATOR_LOCAL_GPU = "GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
export const DUAL_STATION_SIMULATOR_PEER_GPU = "GPU-11111111-2222-3333-4444-555555555555";

const PEER_TARGET = "nvidia@station-b";
const BINDING_TOKEN = "simulated-qualified-binding";
const activeSshFixtures = new Set<DualStationSshBindingFixture>();

function snapshotPath(home: string): string {
  return [
    home,
    ".cache/huggingface/hub",
    `models--${DUAL_STATION_VLLM_RUNTIME.modelId.replace("/", "--")}`,
    "snapshots",
    DUAL_STATION_VLLM_RUNTIME.modelRevision,
  ].join("/");
}

function stationRail(
  rdmaDevice: string,
  netdev: string,
  pciAddress: string,
  macAddress: string,
  address: string,
) {
  return {
    rdmaDevice,
    port: 1,
    netdev,
    macAddress,
    uverbsDevice: `/dev/infiniband/uverbs${rdmaDevice.endsWith("0") ? "0" : "1"}`,
    pciAddress,
    pciName: `${pciAddress} Ethernet controller: NVIDIA ConnectX-8 SuperNIC`,
    state: "4: ACTIVE",
    linkLayer: "Ethernet",
    speedMbps: 400_000,
    mtu: 9000,
    ipv4Addresses: [{ address, prefixLength: 30 }],
    roceV2Ipv4Gids: [{ index: 3, address }],
  };
}

function stationHost(side: "local" | "peer"): StationHostProbe {
  const local = side === "local";
  const home = local ? "/home/local" : "/home/peer";
  return {
    schemaVersion: 1,
    hostname: local ? "station-a" : "station-b",
    productName: "NVIDIA DGX Station GB300",
    architecture: "aarch64",
    home,
    uid: local ? 1000 : 1001,
    gid: local ? 1000 : 1001,
    gpus: [
      {
        index: 0,
        name: "NVIDIA GB300 Grace Blackwell Superchip",
        uuid: local ? DUAL_STATION_SIMULATOR_LOCAL_GPU : DUAL_STATION_SIMULATOR_PEER_GPU,
      },
    ],
    docker: { reachable: true, nvidiaRuntime: true },
    rsyncAvailable: true,
    nvidiaPeermemLoaded: true,
    rails: local
      ? [
          stationRail("mlx5_0", "cx8a0", "0001:03:00.0", "02:00:00:aa:00:00", "192.168.240.1"),
          stationRail("mlx5_1", "cx8a1", "0001:03:00.1", "02:00:00:aa:00:01", "192.168.240.5"),
        ]
      : [
          // Inventory is intentionally reversed; the production planner must match by subnet.
          stationRail("mlx5_1", "cx8b1", "0002:03:00.1", "02:00:00:bb:00:01", "192.168.240.6"),
          stationRail("mlx5_0", "cx8b0", "0002:03:00.0", "02:00:00:bb:00:00", "192.168.240.2"),
        ],
    modelSnapshot: {
      modelId: DUAL_STATION_VLLM_RUNTIME.modelId,
      revision: DUAL_STATION_VLLM_RUNTIME.modelRevision,
      path: snapshotPath(home),
      directoryExists: true,
      complete: true,
      shardCount: 113,
      reason: "",
    },
  };
}

function command(stdout: unknown): StationProbeCommandResult {
  return {
    status: 0,
    stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout),
  };
}

function strictSshConfig(fixture: DualStationSshBindingFixture): string {
  const binding = fixture.binding;
  return [
    `hostname ${binding.resolvedHost}`,
    `user ${binding.sshUser}`,
    `port ${String(binding.port)}`,
    `hostkeyalias ${binding.lookupHost}`,
    `userknownhostsfile ${binding.knownHostsFile}`,
    "globalknownhostsfile /dev/null",
    "batchmode yes",
    "stricthostkeychecking true",
    "permitlocalcommand no",
    "forwardagent no",
    "forwardx11 no",
    "forwardx11trusted no",
    "tunnel false",
    "updatehostkeys no",
    "controlmaster false",
    "controlpersist no",
    "sendenv LANG",
    "sendenv LC_*",
  ].join("\n");
}

function connectivity(requests: readonly StationRailConnectivityRequest[]) {
  return command({
    schemaVersion: 1,
    checks: requests.map((request) => ({
      ...request,
      routeDevice: request.netdev,
      routeSource: request.sourceAddress,
      routeGateway: null,
      routeScope: "link",
      peerMac: request.expectedPeerMac,
      peerNeighborState: "REACHABLE",
      jumboPing: true,
    })),
  });
}

function probeDeps(fixture: DualStationSshBindingFixture): StationClusterProbeDeps {
  return {
    loadPeerSshBinding: (token, expectedPeerTarget) => {
      if (token !== BINDING_TOKEN) throw new Error("unexpected simulated SSH binding token");
      if (expectedPeerTarget !== PEER_TARGET) throw new Error("unexpected simulated peer target");
      return fixture.binding;
    },
    probePeerSshConfig: () => command(strictSshConfig(fixture)),
    probeLocalHost: () => command(stationHost("local")),
    probePeerHost: () => command(stationHost("peer")),
    probeLocalConnectivity: connectivity,
    probePeerConnectivity: (_binding, requests) => connectivity(requests),
  };
}

export function createDualStationSimulationPlan() {
  const fixture = createDualStationSshBindingFixture(PEER_TARGET);
  activeSshFixtures.add(fixture);
  const capability = probeDualStationVllmCapability({
    env: {
      [NEMOCLAW_DGX_STATION_PEER_ENV]: PEER_TARGET,
      [NEMOCLAW_DGX_STATION_SSH_BINDING_ENV]: BINDING_TOKEN,
    },
    deps: probeDeps(fixture),
  });
  if (capability.kind !== "ready") throw new Error("synthetic topology did not qualify");
  return capability.plan;
}

export function cleanupDualStationSimulationFixtures(): void {
  for (const fixture of activeSshFixtures) fixture.cleanup();
  activeSshFixtures.clear();
}

type SimulatedContainer = {
  id: string;
  target: "local" | "peer";
  name: string;
  state: "running" | "exited";
  image: string;
  labels: Record<string, string>;
  visibleGpu: string | null;
  command: string;
  environment: NodeJS.ProcessEnv;
};

export type DualStationSimulatorMutation = {
  kind: "run" | "rm";
  target: "local" | "peer";
  nameOrId: string;
  args?: readonly string[];
  options?: DualStationDockerOptions;
};

function dockerValues(args: readonly string[], flag: string): string[] {
  return args.flatMap((arg, index) =>
    arg === flag && index < args.length - 1 ? [args[index + 1]] : [],
  );
}

export function createDualStationLifecycleSimulator() {
  const containers = new Map<string, SimulatedContainer>();
  const mutations: DualStationSimulatorMutation[] = [];
  const healthDuringManagedLaunch: number[] = [];
  let idCounter = 0;
  let nonceCounter = 0;
  let transactionCounter = 0;
  let registeredWorkerId: string | null = null;

  const targetFor = (options?: DualStationDockerOptions): "local" | "peer" =>
    options?.env?.SIMULATED_DOCKER_TARGET === "peer" ? "peer" : "local";
  const keyFor = (target: "local" | "peer", name: string) => `${target}:${name}`;
  const nextId = () => (++idCounter).toString(16).padStart(64, "0");
  const getById = (id: string) => [...containers.values()].find((item) => item.id === id);
  const managedPair = () => ({
    head: containers.get(keyFor("local", DUAL_STATION_VLLM_HEAD_CONTAINER_NAME)),
    worker: containers.get(keyFor("peer", DUAL_STATION_VLLM_WORKER_CONTAINER_NAME)),
  });
  const managedReady = () => {
    const { head, worker } = managedPair();
    return (
      head?.state === "running" && worker?.state === "running" && registeredWorkerId === worker.id
    );
  };

  const deps = {
    buildLocalDockerEnv: () => ({
      SIMULATED_DOCKER_TARGET: "local",
      VLLM_API_KEY: "ambient-secret-must-be-stripped",
    }),
    buildRemoteDockerEnv: () => ({
      SIMULATED_DOCKER_TARGET: "peer",
      VLLM_API_KEY: "ambient-secret-must-be-stripped",
    }),
    createProbeNonce: () => (++nonceCounter).toString(16).padStart(32, "0"),
    createTransactionId: () => (++transactionCounter).toString(16).padStart(32, "0"),
    effectiveControllerUid: () => stationHost("local").uid,
    readControllerUid: () => stationHost("local").uid,
    waitBeforeReconcile: async () => undefined,
    withLifecycleLock: async <T>(operation: () => Promise<T> | T): Promise<T> => await operation(),
    loadApiKey: () => DUAL_STATION_SIMULATOR_API_KEY,
    localInterfaceAddresses: () => ["192.168.240.1"],
    dockerCapture: (args: readonly string[], options?: DualStationDockerOptions): string => {
      const target = targetFor(options);
      if (args[0] === "image") return `sha256:${"f".repeat(64)}\n`;
      if (args[0] === "wait") return getById(args[1]) ? "0\n" : "1\n";
      if (args[0] === "logs") return `${getById(args[1])?.visibleGpu ?? ""}\n`;

      const nameFilter = dockerValues(args, "--filter")[0] ?? "";
      const name = nameFilter.replace(/^name=\^\//u, "").replace(/\$$/u, "");
      const item = containers.get(keyFor(target, name));
      if (!item) return "";
      const format = dockerValues(args, "--format")[0] ?? "";
      if (format.includes(DUAL_STATION_VLLM_GPU_SMOKE_LABEL)) {
        return [
          item.id,
          item.name,
          item.image,
          item.labels[DUAL_STATION_VLLM_GPU_SMOKE_LABEL] ?? "",
          item.labels[DUAL_STATION_VLLM_ROLE_LABEL] ?? "",
        ].join("\t");
      }
      return [
        item.id,
        item.name,
        item.state,
        item.image,
        item.labels[DUAL_STATION_VLLM_MANAGED_LABEL] ?? "",
        item.labels[DUAL_STATION_VLLM_ROLE_LABEL] ?? "",
        item.labels[DUAL_STATION_VLLM_ENDPOINT_LABEL] ?? "",
        item.labels[DUAL_STATION_VLLM_CLUSTER_LABEL] ?? "",
        item.labels[DUAL_STATION_VLLM_GPU_LABEL] ?? "",
        item.labels[DUAL_STATION_VLLM_LAUNCH_SCHEMA_LABEL] ?? "",
        item.labels[DUAL_STATION_VLLM_LAUNCH_CONTRACT_LABEL] ?? "",
        item.labels[DUAL_STATION_VLLM_API_KEY_FINGERPRINT_LABEL] ?? "",
        item.labels[DUAL_STATION_VLLM_TRANSACTION_LABEL] ?? "",
      ].join("\t");
    },
    dockerRunDetached: (args: readonly string[], options?: DualStationDockerOptions) => {
      const target = targetFor(options);
      const name = dockerValues(args, "--name")[0];
      const labels = Object.fromEntries(
        dockerValues(args, "--label").map((entry) => {
          const separator = entry.indexOf("=");
          return [entry.slice(0, separator), entry.slice(separator + 1)];
        }),
      );
      const visibleGpu = (dockerValues(args, "--gpus")[0] ?? "").replace(/^device=/u, "") || null;
      const item: SimulatedContainer = {
        id: nextId(),
        target,
        name,
        state: name.startsWith("nemoclaw-vllm-gpu-smoke-") ? "exited" : "running",
        image: DUAL_STATION_VLLM_RUNTIME.image,
        labels,
        visibleGpu,
        command: args.at(-1) ?? "",
        environment: { ...options?.env },
      };
      containers.set(keyFor(target, name), item);
      mutations.push({
        kind: "run",
        target,
        nameOrId: name,
        args: [...args],
        options,
      });
      if (
        name === DUAL_STATION_VLLM_WORKER_CONTAINER_NAME ||
        name === DUAL_STATION_VLLM_HEAD_CONTAINER_NAME
      ) {
        healthDuringManagedLaunch.push(managedReady() ? 200 : 503);
      }
      return { status: 0, stdout: `${item.id}\n` };
    },
    dockerForceRm: (containerId: string, options?: DualStationDockerOptions) => {
      const target = targetFor(options);
      const item = getById(containerId);
      if (!item || item.target !== target) return { status: 1 };
      if (registeredWorkerId === item.id) registeredWorkerId = null;
      containers.delete(keyFor(item.target, item.name));
      mutations.push({ kind: "rm", target, nameOrId: containerId, options });
      return { status: 0 };
    },
  } satisfies DualStationVllmLifecycleDeps;

  function serviceRequest(path: string, authorization?: string) {
    // This is an in-memory API contract simulator, not inference or a network/RDMA test.
    if (path === "/health") return { status: managedReady() ? 200 : 503, body: null };
    const { head } = managedPair();
    if (
      !head?.environment.VLLM_API_KEY ||
      authorization !== `Bearer ${head.environment.VLLM_API_KEY}`
    )
      return { status: 401, body: { error: "unauthorized" } };
    if (!managedReady()) return { status: 503, body: { error: "worker unavailable" } };
    if (path === "/v1/models") {
      return {
        status: 200,
        body: { data: [{ id: DUAL_STATION_VLLM_RUNTIME.servedModelId }] },
      };
    }
    if (path === "/v1/chat/completions") {
      return {
        status: 200,
        body: {
          choices: [{ message: { role: "assistant", content: "SIMULATED_OK" } }],
        },
      };
    }
    return { status: 404, body: null };
  }

  function registerWorker(): void {
    const { head, worker } = managedPair();
    if (head?.state !== "running" || worker?.state !== "running") {
      throw new Error("both simulated roles must be running before registration");
    }
    if (
      !worker.command.includes("ray start --address=192.168.240.1:6379") ||
      !worker.command.includes("--node-ip-address=192.168.240.2") ||
      worker.command.includes("vllm serve") ||
      !head.command.includes("ray start --head --node-ip-address=192.168.240.1 --port=6379") ||
      !head.command.includes("--distributed-executor-backend ray") ||
      worker.labels[DUAL_STATION_VLLM_TRANSACTION_LABEL] !==
        head.labels[DUAL_STATION_VLLM_TRANSACTION_LABEL]
    ) {
      throw new Error("simulated worker launch contract cannot register with the head");
    }
    registeredWorkerId = worker.id;
  }

  function loseWorker(): void {
    const worker = containers.get(keyFor("peer", DUAL_STATION_VLLM_WORKER_CONTAINER_NAME));
    if (!worker) throw new Error("simulated worker was not running");
    worker.state = "exited";
    registeredWorkerId = null;
  }

  return {
    containers,
    deps,
    healthDuringManagedLaunch,
    loseWorker,
    mutations,
    registerWorker,
    serviceRequest,
  };
}

export function dualStationManagedRuns(mutations: readonly DualStationSimulatorMutation[]) {
  return mutations.filter(
    (mutation) =>
      mutation.kind === "run" &&
      (mutation.nameOrId === DUAL_STATION_VLLM_WORKER_CONTAINER_NAME ||
        mutation.nameOrId === DUAL_STATION_VLLM_HEAD_CONTAINER_NAME),
  );
}

export function dualStationSimulatorLabels(
  mutation: DualStationSimulatorMutation,
): Record<string, string> {
  return Object.fromEntries(
    dockerValues(mutation.args ?? [], "--label").map((entry) => {
      const separator = entry.indexOf("=");
      return [entry.slice(0, separator), entry.slice(separator + 1)];
    }),
  );
}
