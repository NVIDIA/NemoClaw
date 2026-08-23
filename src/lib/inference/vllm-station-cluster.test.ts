// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type SpawnSyncOptionsWithStringEncoding, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildRemoteVllmDockerEnv } from "./vllm-docker-env";
import {
  createStationClusterProbeDeps,
  DUAL_STATION_VLLM_RUNTIME,
  NEMOCLAW_DGX_STATION_PEER_ENV,
  parseStationHostProbe,
  probeDualStationVllmCapability,
  type StationClusterProbeDeps,
  type StationHostProbe,
  type StationProbeCommandResult,
  type StationRailConnectivityRequest,
  validatePeerTarget,
} from "./vllm-station-cluster";
import {
  type DualStationSshBinding,
  loadDualStationSshBindingHandoff,
  NEMOCLAW_DGX_STATION_SSH_BINDING_ENV,
} from "./vllm-station-ssh-binding";
import {
  createDualStationSshBindingFixture,
  retargetDualStationSshBindingFixture,
  type DualStationSshBindingFixture,
} from "./vllm-station-ssh-binding.test-support";
import { resolveStationFixturePython } from "./vllm-station-fixture.test-support";

const LOCAL_HOME = "/home/local";
const PEER_HOME = "/home/nvidia";
const STATION_ACCEPTANCE_IMAGE =
  "docker.io/library/ubuntu@sha256:7f622ca8766bccb22f04242ecb6f19f770b2f08827dc4b8c707de5e78a6da7ab";

function strictDockerSshConfig(binding: DualStationSshBinding): string {
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

let sshFixture: DualStationSshBindingFixture;

beforeEach(() => {
  sshFixture = createDualStationSshBindingFixture();
});

afterEach(() => {
  vi.unstubAllEnvs();
  sshFixture.cleanup();
});

function snapshotPath(home: string): string {
  return [
    home,
    ".cache/huggingface/hub",
    `models--${DUAL_STATION_VLLM_RUNTIME.modelId.replace("/", "--")}`,
    "snapshots",
    DUAL_STATION_VLLM_RUNTIME.modelRevision,
  ].join("/");
}

function rail(
  rdmaDevice: string,
  netdev: string,
  pciAddress: string,
  address: string,
  gidIndexes: number[] = [3, 5],
) {
  const hostOctet = netdev.includes("a") ? "aa" : "bb";
  const railOctet = netdev.endsWith("0") ? "00" : "01";
  return {
    rdmaDevice,
    port: 1,
    netdev,
    macAddress: `02:00:00:${hostOctet}:00:${railOctet}`,
    uverbsDevice: `/dev/infiniband/uverbs${rdmaDevice.endsWith("0") ? "0" : "1"}`,
    pciAddress,
    pciName: `${pciAddress} Ethernet controller: NVIDIA ConnectX-8 SuperNIC`,
    state: "4: ACTIVE",
    linkLayer: "Ethernet",
    speedMbps: 400_000,
    mtu: 9000,
    ipv4Addresses: [{ address, prefixLength: 30 }],
    roceV2Ipv4Gids: gidIndexes.map((index) => ({ index, address })),
  };
}

function setRailAddress(
  item: ReturnType<typeof rail>,
  address: string,
  prefixLength: number,
): void {
  item.ipv4Addresses = [{ address, prefixLength }];
  item.roceV2Ipv4Gids = item.roceV2Ipv4Gids.map((gid) => ({ ...gid, address }));
}

function hostFixture(side: "local" | "peer"): StationHostProbe {
  const isLocal = side === "local";
  const home = isLocal ? LOCAL_HOME : PEER_HOME;
  return {
    schemaVersion: 1,
    hostname: isLocal ? "station-a" : "station-b",
    productName: "NVIDIA DGX Station GB300",
    architecture: "aarch64",
    home,
    uid: isLocal ? 1000 : 1001,
    gid: isLocal ? 1000 : 1001,
    gpus: isLocal
      ? [
          {
            index: 0,
            name: "NVIDIA GB300",
            uuid: "GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            totalMemoryMiB: 100_000,
            freeMemoryMiB: 95_000,
          },
        ]
      : [
          {
            index: 0,
            name: "NVIDIA RTX PRO 6000",
            uuid: "GPU-11111111-2222-3333-4444-555555555555",
            totalMemoryMiB: 100_000,
            freeMemoryMiB: 95_000,
          },
          {
            index: 1,
            name: "NVIDIA GB300 Grace Blackwell Superchip",
            uuid: "GPU-99999999-8888-7777-6666-555555555555",
            totalMemoryMiB: 100_000,
            freeMemoryMiB: 95_000,
          },
        ],
    docker: { reachable: true, nvidiaRuntime: true },
    rsyncAvailable: true,
    rails: isLocal
      ? [
          rail("mlx5_0", "cx8a0", "0001:03:00.0", "192.168.240.1"),
          rail("mlx5_1", "cx8a1", "0001:03:00.1", "192.168.240.5"),
        ]
      : [
          // Deliberately reverse inventory order; matching is by subnet.
          rail("mlx5_1", "cx8b1", "0002:03:00.1", "192.168.240.6"),
          rail("mlx5_0", "cx8b0", "0002:03:00.0", "192.168.240.2"),
        ],
    modelSnapshot: {
      modelId: DUAL_STATION_VLLM_RUNTIME.modelId,
      revision: DUAL_STATION_VLLM_RUNTIME.modelRevision,
      path: snapshotPath(home),
      directoryExists: !isLocal,
      complete: !isLocal,
      shardCount: isLocal ? 0 : 113,
      reason: isLocal ? "not staged yet" : "",
    },
  };
}

function command(stdout: unknown, status = 0): StationProbeCommandResult {
  return { status, stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout) };
}

function connectivityResponse(
  requests: readonly StationRailConnectivityRequest[],
  alter: (check: Record<string, unknown>, index: number) => void = () => undefined,
): StationProbeCommandResult {
  const checks = requests.map((request, index) => {
    const check: Record<string, unknown> = {
      ...request,
      routeDevice: request.netdev,
      routeSource: request.sourceAddress,
      routeGateway: null,
      routeScope: "link",
      peerMac: request.expectedPeerMac,
      peerNeighborState: "REACHABLE",
      jumboPing: true,
    };
    alter(check, index);
    return check;
  });
  return command({ schemaVersion: 1, checks });
}

type FixtureDeps = StationClusterProbeDeps & {
  calls: {
    sshConfig: ReturnType<typeof vi.fn>;
    localHost: ReturnType<typeof vi.fn>;
    peerHost: ReturnType<typeof vi.fn>;
    localConnectivity: ReturnType<typeof vi.fn>;
    peerConnectivity: ReturnType<typeof vi.fn>;
  };
};

function fixtureDeps(
  local = hostFixture("local"),
  peer = hostFixture("peer"),
  options: {
    localConnectivityAlter?: (check: Record<string, unknown>, index: number) => void;
    peerConnectivityAlter?: (check: Record<string, unknown>, index: number) => void;
  } = {},
): FixtureDeps {
  const localHost = vi.fn(() => command(local));
  const peerHost = vi.fn(() => command(peer));
  const sshConfig = vi.fn((binding: DualStationSshBinding) =>
    command(strictDockerSshConfig(binding)),
  );
  const localConnectivity = vi.fn((requests: readonly StationRailConnectivityRequest[]) =>
    connectivityResponse(requests, options.localConnectivityAlter),
  );
  const peerConnectivity = vi.fn(
    (_binding: DualStationSshBinding, requests: readonly StationRailConnectivityRequest[]) =>
      connectivityResponse(requests, options.peerConnectivityAlter),
  );
  return {
    loadPeerSshBinding: loadDualStationSshBindingHandoff,
    probePeerSshConfig: sshConfig,
    probeLocalHost: localHost,
    probePeerHost: peerHost,
    probeLocalConnectivity: localConnectivity,
    probePeerConnectivity: peerConnectivity,
    calls: { sshConfig, localHost, peerHost, localConnectivity, peerConnectivity },
  };
}

function runWith(deps: StationClusterProbeDeps, target = "nvidia@station-b") {
  sshFixture = retargetDualStationSshBindingFixture(
    sshFixture,
    target,
    validatePeerTarget(target).ok,
  );
  return probeDualStationVllmCapability({
    env: {
      [NEMOCLAW_DGX_STATION_PEER_ENV]: target,
      [NEMOCLAW_DGX_STATION_SSH_BINDING_ENV]: sshFixture.token,
    },
    deps,
  });
}

describe("probeDualStationVllmCapability", () => {
  it.each([
    undefined,
    "",
    "   ",
  ])("does no work when the explicit peer is absent or blank (%s)", (value) => {
    const deps = fixtureDeps();
    const env = value === undefined ? {} : { [NEMOCLAW_DGX_STATION_PEER_ENV]: value };

    expect(probeDualStationVllmCapability({ env, deps })).toEqual({ kind: "not-configured" });
    expect(deps.calls.sshConfig).not.toHaveBeenCalled();
    expect(deps.calls.localHost).not.toHaveBeenCalled();
    expect(deps.calls.peerHost).not.toHaveBeenCalled();
    expect(deps.calls.localConnectivity).not.toHaveBeenCalled();
    expect(deps.calls.peerConnectivity).not.toHaveBeenCalled();
  });

  it.each([
    "ssh://station-b",
    "-oProxyCommand=bad",
    "station-a,station-b",
    "station-b:2222",
    "user name@station-b",
    "station-b;id",
    "station-b$(id)",
    "user@station-b@other",
    " station-b",
    "station-b\nother",
    "Station-B",
    "station_b",
    "station..b",
    "station-b.",
    "1user@station-b",
  ])("rejects a non-single-host peer value without executing: %s", (target) => {
    const deps = fixtureDeps();

    expect(runWith(deps, target)).toMatchObject({ kind: "unavailable", code: "invalid-peer" });
    expect(deps.calls.sshConfig).not.toHaveBeenCalled();
    expect(deps.calls.localHost).not.toHaveBeenCalled();
    expect(deps.calls.peerHost).not.toHaveBeenCalled();
  });

  it("requires the installer-qualified SSH binding before any peer probe", () => {
    const deps = fixtureDeps();

    expect(
      probeDualStationVllmCapability({
        env: { [NEMOCLAW_DGX_STATION_PEER_ENV]: "nvidia@station-b" },
        deps,
      }),
    ).toMatchObject({ kind: "unavailable", code: "peer-ssh-config-unsafe" });
    expect(deps.calls.sshConfig).not.toHaveBeenCalled();
    expect(deps.calls.localHost).not.toHaveBeenCalled();
    expect(deps.calls.peerHost).not.toHaveBeenCalled();
  });

  it("rejects a changed qualified host-key pin before any peer probe", () => {
    const deps = fixtureDeps();
    fs.appendFileSync(sshFixture.binding.knownHostsFile, "changed\n");

    expect(runWith(deps)).toMatchObject({
      kind: "unavailable",
      code: "peer-ssh-config-unsafe",
    });
    expect(deps.calls.sshConfig).not.toHaveBeenCalled();
    expect(deps.calls.localHost).not.toHaveBeenCalled();
    expect(deps.calls.peerHost).not.toHaveBeenCalled();
  });

  it("rejects Docker-over-SSH when the effective operator config weakens peer trust", () => {
    const deps = fixtureDeps();
    deps.probePeerSshConfig = (binding) =>
      command(
        strictDockerSshConfig(binding).replace(
          "stricthostkeychecking true",
          "stricthostkeychecking false",
        ),
      );

    expect(runWith(deps)).toMatchObject({
      kind: "unavailable",
      code: "peer-ssh-config-unsafe",
    });
    expect(deps.calls.localHost).not.toHaveBeenCalled();
    expect(deps.calls.peerHost).not.toHaveBeenCalled();
  });

  it("rejects an SSH config that can SendEnv arbitrary NemoClaw secrets", () => {
    const deps = fixtureDeps();
    deps.probePeerSshConfig = (binding) => command(`${strictDockerSshConfig(binding)}\nsendenv *`);

    expect(runWith(deps)).toMatchObject({
      kind: "unavailable",
      code: "peer-ssh-config-unsafe",
    });
    expect(deps.calls.localHost).not.toHaveBeenCalled();
  });

  it.each([
    ["named Docker context", { DOCKER_CONTEXT: "remote-builder" }],
    ["remote Docker host", { DOCKER_HOST: "ssh://builder.example" }],
  ])("rejects an ambient %s before mixing it with local hardware", (_label, dockerEnv) => {
    const deps = fixtureDeps();

    expect(
      probeDualStationVllmCapability({
        env: {
          [NEMOCLAW_DGX_STATION_PEER_ENV]: "nvidia@station-b",
          [NEMOCLAW_DGX_STATION_SSH_BINDING_ENV]: sshFixture.token,
          ...dockerEnv,
        },
        deps,
      }),
    ).toMatchObject({ kind: "unavailable", code: "local-docker-unavailable" });
    expect(deps.calls.sshConfig).not.toHaveBeenCalled();
    expect(deps.calls.localHost).not.toHaveBeenCalled();
  });

  it.each([
    ["context selected by Station host preparation", { DOCKER_CONTEXT: "default" }],
    ["socket detected by the NemoClaw runner", { DOCKER_HOST: "unix:///run/docker.sock" }],
    [
      "socket alias detected by the NemoClaw runner",
      { DOCKER_HOST: "unix:///var/run/docker.sock" },
    ],
  ])("accepts the local default Docker %s", (_label, dockerEnv) => {
    const deps = fixtureDeps();

    expect(
      probeDualStationVllmCapability({
        env: {
          [NEMOCLAW_DGX_STATION_PEER_ENV]: "nvidia@station-b",
          [NEMOCLAW_DGX_STATION_SSH_BINDING_ENV]: sshFixture.token,
          ...dockerEnv,
        },
        deps,
      }),
    ).toMatchObject({ kind: "ready" });
    expect(deps.calls.sshConfig).toHaveBeenCalledOnce();
    expect(deps.calls.localHost).toHaveBeenCalledOnce();
  });

  it.each([
    "station-b",
    "nvidia@station-b",
    "_svc@192.168.50.20",
  ])("returns the qualified binding for %s", (target) => {
    const result = runWith(fixtureDeps(), target);
    expect(result).toMatchObject({
      kind: "ready",
      peerModelSnapshot: "ready",
      plan: { peerSshBinding: { peerTarget: target } },
    });
    expect(result.kind).toBe("ready");
    const ready = result as Extract<typeof result, { kind: "ready" }>;
    expect(buildRemoteVllmDockerEnv(ready.plan.peerSshBinding, {}).DOCKER_HOST).toBe(
      `ssh://${ready.plan.peerSshBinding.sshUser}@${ready.plan.peerSshBinding.resolvedHost}`,
    );
  });

  it("returns a deterministic two-rail Ray PP2 plan and permits one auxiliary non-GB300 GPU", () => {
    const deps = fixtureDeps();

    const result = runWith(deps);

    expect(result).toMatchObject({
      kind: "ready",
      plan: {
        peerSshBinding: {
          peerTarget: "nvidia@station-b",
          resolvedHost: "192.168.50.20",
          sshUser: "nvidia",
        },
        runtime: {
          image:
            "vllm/vllm-openai@sha256:2cc49b81319f7a66a33dd8bd63a7bfddae079122b33ce51989b6828a1f038c37",
          modelRevision: "183968f87ae4cedce3039313cac1fd43d112c578",
          servedModelId: "nemotron-ultra",
          tensorParallelSize: 1,
          pipelineParallelSize: 2,
          nodeCount: 2,
        },
        local: {
          home: LOCAL_HOME,
          uid: 1000,
          gid: 1000,
          gpu: { index: 0, name: "NVIDIA GB300" },
        },
        peer: {
          home: PEER_HOME,
          uid: 1001,
          gid: 1001,
          gpu: { index: 1, name: "NVIDIA GB300 Grace Blackwell Superchip" },
        },
        masterAddress: "192.168.240.1",
        roceGidIndex: 3,
        rails: [
          {
            subnet: "192.168.240.0/30",
            local: {
              rdmaDevice: "mlx5_0",
              netdev: "cx8a0",
              uverbsDevice: "/dev/infiniband/uverbs0",
              address: "192.168.240.1",
            },
            peer: {
              rdmaDevice: "mlx5_0",
              netdev: "cx8b0",
              uverbsDevice: "/dev/infiniband/uverbs0",
              address: "192.168.240.2",
            },
          },
          {
            subnet: "192.168.240.4/30",
            local: {
              rdmaDevice: "mlx5_1",
              netdev: "cx8a1",
              uverbsDevice: "/dev/infiniband/uverbs1",
              address: "192.168.240.5",
            },
            peer: {
              rdmaDevice: "mlx5_1",
              netdev: "cx8b1",
              uverbsDevice: "/dev/infiniband/uverbs1",
              address: "192.168.240.6",
            },
          },
        ],
      },
    });
    expect(deps.calls.peerHost).toHaveBeenCalledWith(sshFixture.binding);
    expect(deps.calls.localConnectivity).toHaveBeenCalledWith([
      {
        netdev: "cx8a0",
        sourceAddress: "192.168.240.1",
        peerAddress: "192.168.240.2",
        expectedPeerMac: "02:00:00:bb:00:00",
      },
      {
        netdev: "cx8a1",
        sourceAddress: "192.168.240.5",
        peerAddress: "192.168.240.6",
        expectedPeerMac: "02:00:00:bb:00:01",
      },
    ]);
    expect(deps.calls.peerConnectivity).toHaveBeenCalledWith(sshFixture.binding, [
      {
        netdev: "cx8b0",
        sourceAddress: "192.168.240.2",
        peerAddress: "192.168.240.1",
        expectedPeerMac: "02:00:00:aa:00:00",
      },
      {
        netdev: "cx8b1",
        sourceAddress: "192.168.240.6",
        peerAddress: "192.168.240.5",
        expectedPeerMac: "02:00:00:aa:00:01",
      },
    ]);
  });

  it("uses the lowest common RoCEv2 IPv4 GID when preferred index 3 is unavailable", () => {
    const local = hostFixture("local");
    const peer = hostFixture("peer");
    [...local.rails, ...peer.rails].forEach((item) => {
      item.roceV2Ipv4Gids = item.roceV2Ipv4Gids.map((gid) => ({ ...gid, index: 5 }));
    });

    expect(runWith(fixtureDeps(local, peer))).toMatchObject({
      kind: "ready",
      plan: { roceGidIndex: 5 },
    });
  });

  it.each([
    "DGX-Station",
    "P3830",
    "NVIDIA Station GB300",
  ])("accepts an existing Station firmware product identifier: %s", (productName) => {
    const peer = hostFixture("peer");
    peer.productName = productName;

    expect(runWith(fixtureDeps(hostFixture("local"), peer))).toMatchObject({
      kind: "ready",
      peerModelSnapshot: "ready",
    });
  });

  it.each([
    {
      name: "non-Station peer",
      code: "peer-not-station",
      mutate: (host: StationHostProbe) => {
        host.productName = "Generic Linux Workstation";
      },
    },
    {
      name: "more than one peer GB300",
      code: "peer-gpu-unavailable",
      mutate: (host: StationHostProbe) => {
        host.gpus.push({
          index: 2,
          name: "NVIDIA GB300",
          uuid: "GPU-aaaa-bbbb-cccc-dddd",
          totalMemoryMiB: 100_000,
          freeMemoryMiB: 95_000,
        });
      },
    },
    {
      name: "missing peer NVIDIA runtime",
      code: "peer-docker-unavailable",
      mutate: (host: StationHostProbe) => {
        host.docker.nvidiaRuntime = false;
      },
    },
    {
      name: "slow peer rail",
      code: "peer-fabric-unavailable",
      mutate: (host: StationHostProbe) => {
        host.rails[0].speedMbps = 200_000;
      },
    },
    {
      name: "non-jumbo peer rail",
      code: "peer-fabric-unavailable",
      mutate: (host: StationHostProbe) => {
        host.rails[1].mtu = 1500;
      },
    },
    {
      name: "unsupported peer RDMA port",
      code: "peer-fabric-unavailable",
      mutate: (host: StationHostProbe) => {
        host.rails[0].port = 2;
      },
    },
    {
      name: "missing peer uverbs character device",
      code: "peer-fabric-unavailable",
      mutate: (host: StationHostProbe) => {
        host.rails[0].uverbsDevice = "";
      },
    },
    {
      name: "duplicate peer uverbs mapping",
      code: "peer-fabric-unavailable",
      mutate: (host: StationHostProbe) => {
        host.rails[1].uverbsDevice = host.rails[0].uverbsDevice;
      },
    },
    {
      name: "incomplete peer snapshot",
      code: "peer-model-cache-unavailable",
      mutate: (host: StationHostProbe) => {
        host.modelSnapshot.complete = false;
      },
    },
    {
      name: "wrong peer snapshot revision",
      code: "peer-model-cache-unavailable",
      mutate: (host: StationHostProbe) => {
        host.modelSnapshot.revision = "f".repeat(40);
      },
    },
    {
      name: "truncated peer snapshot manifest",
      code: "peer-model-cache-unavailable",
      mutate: (host: StationHostProbe) => {
        host.modelSnapshot.shardCount = 1;
      },
    },
  ])("fails closed for $name", ({ code, mutate }) => {
    const peer = hostFixture("peer");
    mutate(peer);

    expect(runWith(fixtureDeps(hostFixture("local"), peer))).toMatchObject({
      kind: "unavailable",
      code,
    });
  });

  it("qualifies a missing peer snapshot when exact staging prerequisites exist", () => {
    const peer = hostFixture("peer");
    peer.modelSnapshot.directoryExists = false;
    peer.modelSnapshot.complete = false;
    peer.modelSnapshot.shardCount = 0;
    peer.modelSnapshot.reason = "snapshot directory is missing";

    expect(runWith(fixtureDeps(hostFixture("local"), peer))).toMatchObject({
      kind: "ready",
      peerModelSnapshot: "staging-required",
    });
  });

  it.each([
    { side: "local", code: "local-model-staging-unavailable" },
    { side: "peer", code: "peer-model-staging-unavailable" },
  ])("requires rsync on the $side host before qualifying a missing snapshot", ({ side, code }) => {
    const local = hostFixture("local");
    const peer = hostFixture("peer");
    peer.modelSnapshot.directoryExists = false;
    peer.modelSnapshot.complete = false;
    peer.modelSnapshot.shardCount = 0;
    peer.modelSnapshot.reason = "snapshot directory is missing";
    (side === "local" ? local : peer).rsyncAvailable = false;

    expect(runWith(fixtureDeps(local, peer))).toMatchObject({ kind: "unavailable", code });
  });

  it("rejects rails that do not form two distinct shared direct subnets", () => {
    const peer = hostFixture("peer");
    peer.rails[0].ipv4Addresses = [{ address: "10.20.30.2", prefixLength: 30 }];
    peer.rails[0].roceV2Ipv4Gids = [{ index: 3, address: "10.20.30.2" }];

    expect(runWith(fixtureDeps(hostFixture("local"), peer))).toMatchObject({
      kind: "unavailable",
      code: "fabric-mismatch",
    });
  });

  it("rejects two otherwise matching switched /24 rail networks", () => {
    const local = hostFixture("local");
    const peer = hostFixture("peer");
    setRailAddress(local.rails[0], "192.168.100.1", 24);
    setRailAddress(local.rails[1], "192.168.101.1", 24);
    setRailAddress(peer.rails.find((item) => item.rdmaDevice === "mlx5_0")!, "192.168.100.2", 24);
    setRailAddress(peer.rails.find((item) => item.rdmaDevice === "mlx5_1")!, "192.168.101.2", 24);

    expect(runWith(fixtureDeps(local, peer))).toMatchObject({
      kind: "unavailable",
      code: "fabric-mismatch",
    });
  });

  it("rejects public addresses even when they form matching /30 rail networks", () => {
    const local = hostFixture("local");
    const peer = hostFixture("peer");
    setRailAddress(local.rails[0], "203.0.113.1", 30);
    setRailAddress(local.rails[1], "198.51.100.5", 30);
    setRailAddress(peer.rails.find((item) => item.rdmaDevice === "mlx5_0")!, "203.0.113.2", 30);
    setRailAddress(peer.rails.find((item) => item.rdmaDevice === "mlx5_1")!, "198.51.100.6", 30);

    expect(runWith(fixtureDeps(local, peer))).toMatchObject({
      kind: "unavailable",
      code: "fabric-mismatch",
    });
  });

  it("rejects asymmetric RoCEv2 IPv4 GID indexes", () => {
    const peer = hostFixture("peer");
    peer.rails[0].roceV2Ipv4Gids = peer.rails[0].roceV2Ipv4Gids.map((gid) => ({
      ...gid,
      index: 7,
    }));

    expect(runWith(fixtureDeps(hostFixture("local"), peer))).toMatchObject({
      kind: "unavailable",
      code: "gid-mismatch",
    });
  });

  it("rejects an SSH target that resolves back to the local Station identity", () => {
    const local = hostFixture("local");
    const peer = hostFixture("peer");
    peer.gpus[1].uuid = local.gpus[0].uuid;

    expect(runWith(fixtureDeps(local, peer))).toMatchObject({
      kind: "unavailable",
      code: "fabric-mismatch",
    });
  });

  it("allows distinct factory-imaged Stations that report the same hostname", () => {
    const local = hostFixture("local");
    const peer = hostFixture("peer");
    peer.hostname = local.hostname;

    expect(runWith(fixtureDeps(local, peer))).toMatchObject({ kind: "ready" });
  });

  it("rejects a local route that traverses a gateway", () => {
    const deps = fixtureDeps(hostFixture("local"), hostFixture("peer"), {
      localConnectivityAlter: (check, index) => {
        check.routeGateway = index === 0 ? "192.168.240.254" : check.routeGateway;
      },
    });

    expect(runWith(deps)).toMatchObject({
      kind: "unavailable",
      code: "local-connectivity-failed",
    });
    expect(deps.calls.peerConnectivity).not.toHaveBeenCalled();
  });

  it("rejects a peer rail that cannot pass an MTU-9000 ping", () => {
    const deps = fixtureDeps(hostFixture("local"), hostFixture("peer"), {
      peerConnectivityAlter: (check, index) => {
        check.jumboPing = index === 1 ? false : check.jumboPing;
      },
    });

    expect(runWith(deps)).toMatchObject({
      kind: "unavailable",
      code: "peer-connectivity-failed",
    });
  });

  it("rejects a route without a scope-link connected-prefix proof", () => {
    const deps = fixtureDeps(hostFixture("local"), hostFixture("peer"), {
      localConnectivityAlter: (check, index) => {
        check.routeScope = index === 0 ? "global" : check.routeScope;
      },
    });

    expect(runWith(deps)).toMatchObject({
      kind: "unavailable",
      code: "local-connectivity-failed",
    });
  });

  it("rejects a neighbor MAC that does not identify the matched peer rail", () => {
    const deps = fixtureDeps(hostFixture("local"), hostFixture("peer"), {
      peerConnectivityAlter: (check, index) => {
        check.peerMac = index === 0 ? "02:00:00:cc:00:00" : check.peerMac;
      },
    });

    expect(runWith(deps)).toMatchObject({
      kind: "unavailable",
      code: "peer-connectivity-failed",
    });
  });

  it("fails closed on command failure or malformed host JSON", () => {
    const localFailure = fixtureDeps();
    localFailure.probeLocalHost = () => command("", 1);
    expect(runWith(localFailure)).toMatchObject({
      kind: "unavailable",
      code: "local-probe-failed",
    });

    const peerMalformed = fixtureDeps();
    peerMalformed.probePeerHost = () => command("not-json");
    expect(runWith(peerMalformed)).toMatchObject({
      kind: "unavailable",
      code: "peer-probe-failed",
    });
  });
});

describe("probe command boundary", () => {
  it("audits the exact effective SSH config used later by Docker transport", () => {
    const spawn = vi.fn(
      (
        _file: string,
        _args: readonly string[],
        _options: SpawnSyncOptionsWithStringEncoding,
      ): StationProbeCommandResult => command(strictDockerSshConfig(sshFixture.binding)),
    );
    const deps = createStationClusterProbeDeps(spawn);

    deps.probePeerSshConfig(sshFixture.binding);

    const [file, args, options] = spawn.mock.calls[0];
    expect(file).toBe("ssh");
    expect(args).toEqual(
      expect.arrayContaining([
        "-G",
        "BatchMode=yes",
        `UserKnownHostsFile=${sshFixture.binding.knownHostsFile}`,
        `HostKeyAlias=${sshFixture.binding.lookupHost}`,
        `Hostname=${sshFixture.binding.resolvedHost}`,
        "User=nvidia",
        "Port=22",
        "--",
        "nvidia@station-b",
      ]),
    );
    expect(options.input).toBe("");
    expect(options.timeout).toBe(20_000);
  });

  it("uses a fixed stdin script and strict pretrusted SSH without discovery or prompting", () => {
    const spawn = vi.fn(
      (
        _file: string,
        _args: readonly string[],
        _options: SpawnSyncOptionsWithStringEncoding,
      ): StationProbeCommandResult => command({}),
    );
    const deps = createStationClusterProbeDeps(spawn);

    deps.probePeerHost(sshFixture.binding);

    const [file, args, options] = spawn.mock.calls[0];
    expect(file).toBe("ssh");
    expect(args).toEqual(
      expect.arrayContaining([
        "BatchMode=yes",
        "StrictHostKeyChecking=yes",
        "NumberOfPasswordPrompts=0",
        "ConnectTimeout=5",
        "ClearAllForwardings=yes",
        "--",
        "nvidia@station-b",
        "python3 -",
      ]),
    );
    expect(args.join(" ")).not.toMatch(/keyscan|accept-new|StrictHostKeyChecking=no/);
    expect(options.input).toEqual(expect.stringContaining('docker", "info'));
    expect(options.input).toEqual(expect.stringContaining('"docker", "run", "--rm"'));
    expect(options.input).toEqual(expect.stringContaining('"--pull=never"'));
    expect(options.input).toEqual(expect.stringContaining('"--gpus", "all"'));
    expect(options.input).toEqual(expect.stringContaining(STATION_ACCEPTANCE_IMAGE));
    expect(options.input).toEqual(expect.stringContaining("/sys/firmware/devicetree/base/model"));
    expect(options.timeout).toBe(20_000);
    expect(options.maxBuffer).toBe(1024 * 1024);
  });

  it("executes the host probe and reports malformed weights plus missing staging tools", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-probe-fixture-"));
    const home = path.join(root, "home");
    const bin = path.join(root, "bin");
    const snapshot = snapshotPath(home);
    fs.mkdirSync(snapshot, { mode: 0o700, recursive: true });
    fs.mkdirSync(bin, { mode: 0o700 });
    fs.writeFileSync(path.join(snapshot, "config.json"), "{}");
    fs.writeFileSync(path.join(snapshot, "tokenizer.json"), "{}");
    const shards = Array.from(
      { length: 113 },
      (_, index) => `model-${String(index + 1).padStart(5, "0")}-of-00113.safetensors`,
    );
    fs.writeFileSync(
      path.join(snapshot, "model.safetensors.index.json"),
      JSON.stringify({
        metadata: { total_size: 1 },
        weight_map: Object.fromEntries(
          shards.map((shard, index) => [`model.layers.${String(index)}.weight`, shard]),
        ),
      }),
    );
    fs.writeFileSync(path.join(snapshot, shards[0]), "malformed");

    let probeScript = "";
    const recordingSpawn = vi.fn(
      (
        _file: string,
        _args: readonly string[],
        options: SpawnSyncOptionsWithStringEncoding,
      ): StationProbeCommandResult => {
        probeScript = typeof options.input === "string" ? options.input : "";
        return command({});
      },
    );
    createStationClusterProbeDeps(recordingSpawn).probeLocalHost();
    const python = resolveStationFixturePython();

    try {
      const executed = spawnSync(python, ["-"], {
        encoding: "utf8",
        env: { ...process.env, HOME: home, PATH: bin },
        input: probeScript,
        timeout: 20_000,
      });
      expect(executed.status, executed.stderr).toBe(0);
      const observed = JSON.parse(executed.stdout) as StationHostProbe;
      expect(observed.modelSnapshot).toMatchObject({
        complete: false,
        shardCount: 113,
        reason: expect.stringContaining("weight shards are unreadable or malformed"),
      });
      expect(observed.rsyncAvailable).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("executes the host probe against the digest-pinned no-pull GPU runtime contract", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-runtime-fixture-"));
    const home = path.join(root, "home");
    const bin = path.join(root, "bin");
    fs.mkdirSync(home, { mode: 0o700 });
    fs.mkdirSync(bin, { mode: 0o700 });

    let probeScript = "";
    const recordingSpawn = vi.fn(
      (
        _file: string,
        _args: readonly string[],
        options: SpawnSyncOptionsWithStringEncoding,
      ): StationProbeCommandResult => {
        probeScript = typeof options.input === "string" ? options.input : "";
        return command({});
      },
    );
    createStationClusterProbeDeps(recordingSpawn).probeLocalHost();
    const python = resolveStationFixturePython();
    const fixturePrelude = String.raw`
import subprocess

class FixtureResult:
    def __init__(self, returncode, stdout=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = ""

def fixture_run(argv, **_kwargs):
    if argv and argv[0] == "nvidia-smi":
        return FixtureResult(0, "0, NVIDIA GB300, GPU-11111111-2222-3333-4444-555555555555")
    if argv[:2] == ["docker", "info"]:
        return FixtureResult(0, "29.2.1")
    if argv[:2] == ["docker", "run"]:
        return FixtureResult(0, "GPU-11111111-2222-3333-4444-555555555555")
    return FixtureResult(127)

subprocess.run = fixture_run
`;

    try {
      const executed = spawnSync(python, ["-"], {
        encoding: "utf8",
        env: { ...process.env, HOME: home, PATH: bin },
        input: `${fixturePrelude}\n${probeScript}`,
        timeout: 20_000,
      });
      expect(executed.status, executed.stderr).toBe(0);
      const observed = JSON.parse(executed.stdout) as StationHostProbe;
      expect(observed.docker).toEqual({ reachable: true, nvidiaRuntime: true });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("executes the host probe and refuses a non-character uverbs device", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-verbs-fixture-"));
    const home = path.join(root, "home");
    const bin = path.join(root, "bin");
    fs.mkdirSync(home, { mode: 0o700 });
    fs.mkdirSync(bin, { mode: 0o700 });

    let probeScript = "";
    const recordingSpawn = vi.fn(
      (
        _file: string,
        _args: readonly string[],
        options: SpawnSyncOptionsWithStringEncoding,
      ): StationProbeCommandResult => {
        probeScript = typeof options.input === "string" ? options.input : "";
        return command({});
      },
    );
    createStationClusterProbeDeps(recordingSpawn).probeLocalHost();
    const python = resolveStationFixturePython();
    const fixturePrelude = String.raw`
import pathlib
import stat as fixture_stat
import subprocess

class FixtureResult:
    def __init__(self, returncode, stdout=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = ""

original_iterdir = pathlib.Path.iterdir
original_stat = pathlib.Path.stat

def fixture_iterdir(candidate):
    if str(candidate) == "/sys/class/infiniband/mlx5_0/device/infiniband_verbs":
        return iter([candidate / "uverbs0"])
    return original_iterdir(candidate)

def fixture_path_stat(candidate, *args, **kwargs):
    if str(candidate) == "/dev/infiniband/uverbs0":
        return type("FixtureStat", (), {"st_mode": fixture_stat.S_IFREG | 0o600})()
    return original_stat(candidate, *args, **kwargs)

def fixture_run(argv, **_kwargs):
    if argv and argv[0] == "ibdev2netdev":
        return FixtureResult(0, "mlx5_0 port 1 ==> cx8p0 (Up)")
    return FixtureResult(127)

pathlib.Path.iterdir = fixture_iterdir
pathlib.Path.stat = fixture_path_stat
subprocess.run = fixture_run
`;

    try {
      const executed = spawnSync(python, ["-"], {
        encoding: "utf8",
        env: { ...process.env, HOME: home, PATH: bin },
        input: `${fixturePrelude}\n${probeScript}`,
        timeout: 20_000,
      });
      expect(executed.status, executed.stderr).toBe(0);
      const observed = JSON.parse(executed.stdout) as StationHostProbe;
      expect(observed.rails).toHaveLength(1);
      expect(observed.rails[0]).toMatchObject({
        rdmaDevice: "mlx5_0",
        netdev: "cx8p0",
        uverbsDevice: "",
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("removes OPENSHELL secrets from the direct SSH probe environment", () => {
    vi.stubEnv("OPENSHELL_GATEWAY_AUTH_TOKEN", "must-not-cross-ssh");
    const spawn = vi.fn(
      (
        _file: string,
        _args: readonly string[],
        _options: SpawnSyncOptionsWithStringEncoding,
      ): StationProbeCommandResult => command({}),
    );
    const deps = createStationClusterProbeDeps(spawn);

    deps.probePeerHost(sshFixture.binding);

    const [, , options] = spawn.mock.calls[0];
    expect(options.env?.OPENSHELL_GATEWAY_AUTH_TOKEN).toBeUndefined();
    expect(options.env?.PATH).toBeTruthy();
  });

  it("pins the local hardware probe to Docker's physical default context", () => {
    const spawn = vi.fn(
      (
        _file: string,
        _args: readonly string[],
        _options: SpawnSyncOptionsWithStringEncoding,
      ): StationProbeCommandResult => command({}),
    );
    const deps = createStationClusterProbeDeps(spawn);

    deps.probeLocalHost();

    const [file, , options] = spawn.mock.calls[0];
    expect(file).toBe("python3");
    expect(options.env?.DOCKER_CONTEXT).toBe("default");
    expect(options.env?.DOCKER_HOST).toBeUndefined();
    expect(options.env?.DOCKER_CONFIG).toBeUndefined();
    expect(options.input).toEqual(expect.stringContaining('"gid": os.getgid()'));
  });

  it("passes only validated discovered rail values to the fixed peer connectivity script", () => {
    const spawn = vi.fn(
      (
        _file: string,
        _args: readonly string[],
        _options: SpawnSyncOptionsWithStringEncoding,
      ): StationProbeCommandResult => command({}),
    );
    const deps = createStationClusterProbeDeps(spawn);
    const requests = [
      {
        netdev: "cx8b0",
        sourceAddress: "192.168.240.2",
        peerAddress: "192.168.240.1",
        expectedPeerMac: "02:00:00:aa:00:00",
      },
      {
        netdev: "cx8b1",
        sourceAddress: "192.168.240.6",
        peerAddress: "192.168.240.5",
        expectedPeerMac: "02:00:00:aa:00:01",
      },
    ];

    deps.probePeerConnectivity(sshFixture.binding, requests);

    const [, args, options] = spawn.mock.calls[0];
    expect(args.at(-1)).toBe(
      "python3 - cx8b0 192.168.240.2 192.168.240.1 cx8b1 192.168.240.6 192.168.240.5",
    );
    expect(options.input).toEqual(expect.stringContaining('"ping", "-4", "-M", "do"'));
    expect(options.input).toEqual(
      expect.stringContaining('"route", "get", peer, "from", source, "oif", netdev'),
    );
    expect(options.input).toEqual(
      expect.stringContaining('"route", "show", "exact", network, "dev", netdev'),
    );
    expect(options.input).toEqual(
      expect.stringContaining('"neighbor", "show", "to", peer, "dev", netdev'),
    );
    expect(options.input).toEqual(expect.stringContaining('"-I", source, peer'));
  });

  it("executes the connectivity probe against the route JSON emitted on Station", () => {
    const requests = [
      {
        netdev: "cx8r0",
        sourceAddress: "192.168.240.1",
        peerAddress: "192.168.240.2",
        expectedPeerMac: "ac:3a:e2:de:3a:23",
      },
      {
        netdev: "cx8r1",
        sourceAddress: "192.168.240.5",
        peerAddress: "192.168.240.6",
        expectedPeerMac: "ac:3a:e2:de:3a:24",
      },
    ];
    let probeScript = "";
    let probeArgs: readonly string[] = [];
    const recordingSpawn = vi.fn(
      (
        _file: string,
        args: readonly string[],
        options: SpawnSyncOptionsWithStringEncoding,
      ): StationProbeCommandResult => {
        probeArgs = args;
        probeScript = typeof options.input === "string" ? options.input : "";
        return command({});
      },
    );
    createStationClusterProbeDeps(recordingSpawn).probeLocalConnectivity(requests);
    const fixturePrelude = String.raw`
import json
import subprocess

class FixtureResult:
    def __init__(self, returncode, stdout=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = ""

def fixture_run(argv, **_kwargs):
    if argv[:4] == ["ip", "-j", "route", "get"]:
        peer, source, netdev = argv[4], argv[6], argv[8]
        return FixtureResult(0, json.dumps([{
            "dst": peer,
            "from": source,
            "dev": netdev,
            "flags": [],
            "uid": 1000,
            "cache": [],
        }]))
    if argv[:5] == ["ip", "-j", "route", "show", "exact"]:
        network = argv[5]
        return FixtureResult(0, json.dumps([{
            "dst": network,
            "protocol": "kernel",
            "scope": "link",
            "prefsrc": "192.168.240.1",
            "metric": 100,
            "flags": [],
        }]))
    if argv and argv[0] == "ping":
        return FixtureResult(0)
    if argv[:3] == ["ip", "-j", "neighbor"]:
        peer, netdev = argv[5], argv[7]
        mac = {
            "192.168.240.2": "ac:3a:e2:de:3a:23",
            "192.168.240.6": "ac:3a:e2:de:3a:24",
        }[peer]
        return FixtureResult(0, json.dumps([{
            "dst": peer,
            "lladdr": mac,
            "state": ["REACHABLE"],
        }]))
    return FixtureResult(127)

subprocess.run = fixture_run
`;
    const executed = spawnSync(resolveStationFixturePython(), probeArgs, {
      encoding: "utf8",
      input: `${fixturePrelude}\n${probeScript}`,
      timeout: 20_000,
    });

    expect(executed.status, executed.stderr).toBe(0);
    const observed = JSON.parse(executed.stdout) as {
      checks: Array<Record<string, unknown>>;
    };
    expect(observed.checks).toEqual([
      expect.objectContaining({
        netdev: "cx8r0",
        routeDevice: "cx8r0",
        routeSource: "192.168.240.1",
        routeScope: "link",
        jumboPing: true,
      }),
      expect.objectContaining({
        netdev: "cx8r1",
        routeDevice: "cx8r1",
        routeSource: "192.168.240.5",
        routeScope: "link",
        jumboPing: true,
      }),
    ]);
  });
});

describe("parseStationHostProbe", () => {
  it("rejects unsupported schemas and unsafe device names", () => {
    const unsupported = { ...hostFixture("local"), schemaVersion: 2 };
    expect(() => parseStationHostProbe(JSON.stringify(unsupported))).toThrow(/schema version/);

    const unsafe = hostFixture("local");
    unsafe.rails[0].netdev = "cx8;touch /tmp/pwned";
    expect(() => parseStationHostProbe(JSON.stringify(unsafe))).toThrow(/unsafe device name/);

    const unsafeUverbs = hostFixture("local");
    unsafeUverbs.rails[0].uverbsDevice = "/dev/infiniband/../mem";
    expect(() => parseStationHostProbe(JSON.stringify(unsafeUverbs))).toThrow(/uverbs/);
  });

  it("rejects root or invalid runtime cache-owner identities", () => {
    const root = hostFixture("local");
    root.uid = 0;
    expect(() => parseStationHostProbe(JSON.stringify(root))).toThrow(/host probe\.uid/);

    const rootGroup = hostFixture("peer");
    rootGroup.gid = 0;
    expect(() => parseStationHostProbe(JSON.stringify(rootGroup))).toThrow(/host probe\.gid/);
  });
});
