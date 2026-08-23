// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  PretrustedSshTarget,
  StationDiscoveryHost,
} from "../../scripts/lib/dgx-station-peer.mts";
import { stationKnownHostsDigest } from "../../src/lib/inference/vllm-station-ssh-binding.ts";

export const REVISION = "a".repeat(40);
export const HELPER_SHA256 = "b".repeat(64);
export const HOST_KEY_DATA = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
export const HOST_KEY_DIGEST = stationKnownHostsDigest(`10.10.0.2 ssh-ed25519 ${HOST_KEY_DATA}\n`);
export const HOST_KEY_FINGERPRINT = `SHA256:${"A".repeat(43)}`;

export function stationHost(side: "local" | "peer"): StationDiscoveryHost {
  const local = side === "local";
  return {
    schemaVersion: 1,
    hostname: local ? "station-a" : "station-b",
    productName: "NVIDIA DGX Station GB300",
    architecture: "aarch64",
    gpus: [
      {
        index: 0,
        name: "NVIDIA GB300",
        uuid: local ? "GPU-LOCAL-0001" : "GPU-PEER-0002",
      },
    ],
    rails: [
      {
        netdev: "enp1s0f0np0",
        macAddress: local ? "02:00:00:00:00:01" : "02:00:00:00:00:02",
        pciAddress: "0000:01:00.0",
        pciName: "NVIDIA ConnectX-8 Ethernet Controller",
        state: "4: ACTIVE",
        linkLayer: "Ethernet",
        speedMbps: 400_000,
        mtu: 9000,
        ipv4Addresses: [{ address: local ? "10.10.0.1" : "10.10.0.2", prefixLength: 30 }],
      },
      {
        netdev: "enp2s0f0np0",
        macAddress: local ? "02:00:00:00:00:05" : "02:00:00:00:00:06",
        pciAddress: "0000:02:00.0",
        pciName: "NVIDIA ConnectX-8 Ethernet Controller",
        state: "4: ACTIVE",
        linkLayer: "Ethernet",
        speedMbps: 400_000,
        mtu: 9000,
        ipv4Addresses: [{ address: local ? "10.10.0.5" : "10.10.0.6", prefixLength: 30 }],
      },
    ],
  };
}

export function stationConnectivity(side: "local" | "peer"): string {
  const source = stationHost(side);
  const destination = stationHost(side === "local" ? "peer" : "local");
  return JSON.stringify({
    schemaVersion: 1,
    checks: source.rails.map((rail, index) => ({
      netdev: rail.netdev,
      sourceAddress: rail.ipv4Addresses[0].address,
      peerAddress: destination.rails[index].ipv4Addresses[0].address,
      routeDevice: rail.netdev,
      routeSource: rail.ipv4Addresses[0].address,
      routeGateway: null,
      routeScope: "link",
      peerMac: destination.rails[index].macAddress,
      peerNeighborState: "REACHABLE",
      jumboPing: true,
    })),
  });
}

export function sshBinding(target = "10.10.0.2", keyData = HOST_KEY_DATA): PretrustedSshTarget {
  const knownHostsLine = `${target.slice(target.lastIndexOf("@") + 1)} ssh-ed25519 ${keyData}`;
  return {
    requestedTarget: target,
    sshTarget: target,
    resolvedHost: target.slice(target.lastIndexOf("@") + 1),
    sshUser: "ubuntu",
    port: 22,
    lookupHost: target.slice(target.lastIndexOf("@") + 1),
    hostKeyDigest: stationKnownHostsDigest(`${knownHostsLine}\n`),
    keyFingerprints: [HOST_KEY_FINGERPRINT],
    knownHostsLines: [knownHostsLine],
  };
}

export function preparationOptions() {
  return { revision: REVISION, helperSha256: HELPER_SHA256 };
}
