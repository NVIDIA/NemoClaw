// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type SpawnSyncOptionsWithStringEncoding, spawnSync } from "node:child_process";
import net from "node:net";
import path from "node:path";

import { buildSubprocessEnv } from "../subprocess-env";
import { isDgxStationGb300Product } from "./dgx-station-identity";
import { buildVllmSshTransportEnv } from "./vllm-docker-env";
import {
  DUAL_STATION_VLLM_GPU_MEMORY_UTILIZATION,
  STATION_PAIR_OPTIONAL_ORCHESTRATION,
  vllmModelForOrchestration,
  vllmStationPairForOrchestration,
} from "./vllm-models";
import {
  type DualStationSshBinding,
  dualStationPinnedSshArgs,
  loadDualStationSshBindingHandoff,
  NEMOCLAW_DGX_STATION_SSH_BINDING_ENV,
} from "./vllm-station-ssh-binding";

export const NEMOCLAW_DGX_STATION_PEER_ENV = "NEMOCLAW_DGX_STATION_PEER";

const HOST_PROBE_SCHEMA_VERSION = 1;
const CONNECTIVITY_PROBE_SCHEMA_VERSION = 1;
const COMMAND_TIMEOUT_MS = 20_000;
const MAX_PROBE_OUTPUT_BYTES = 1024 * 1024;
const PREFERRED_ROCE_GID_INDEX = 3;
const EXPECTED_ULTRA_WEIGHT_SHARDS = 113;
const DIRECT_RAIL_PREFIX_LENGTH = 30;
const STATION_RUNTIME_PROBE_IMAGE =
  "docker.io/library/ubuntu@sha256:7f622ca8766bccb22f04242ecb6f19f770b2f08827dc4b8c707de5e78a6da7ab";
const DUAL_STATION_LOCAL_DOCKER_OVERRIDE_ENV_NAMES = [
  "DOCKER_API_VERSION",
  "DOCKER_CERT_PATH",
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "DOCKER_HOST",
  "DOCKER_TLS",
  "DOCKER_TLS_VERIFY",
] as const;
const CANONICAL_SSH_HOST_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const CANONICAL_SSH_USERNAME_PATTERN = /^[A-Za-z_][A-Za-z0-9._-]*$/;

const ultraModel = vllmModelForOrchestration(
  STATION_PAIR_OPTIONAL_ORCHESTRATION,
  "station",
  "arm64",
);
if (!ultraModel?.revision) {
  throw new Error("The Station-pair model must have an immutable Hugging Face revision");
}
const stationPair = vllmStationPairForOrchestration(
  ultraModel,
  STATION_PAIR_OPTIONAL_ORCHESTRATION,
  "station",
  "arm64",
);
if (!stationPair) {
  throw new Error("The Station-pair orchestration must have a typed runtime configuration");
}

export const DUAL_STATION_VLLM_RUNTIME = Object.freeze({
  image: stationPair.image,
  imageDownloadSizeBytes: stationPair.imageDownloadSizeBytes,
  modelId: ultraModel.id,
  modelRevision: ultraModel.revision,
  servedModelId: stationPair.servedName,
  tensorParallelSize: stationPair.tensorParallelSize,
  pipelineParallelSize: stationPair.pipelineParallelSize,
  nodeCount: stationPair.nodeCount,
  loadTimeoutSeconds: stationPair.loadTimeoutSeconds,
  gpuMemoryUtilization: DUAL_STATION_VLLM_GPU_MEMORY_UTILIZATION,
});

export interface StationGpuProbe {
  index: number;
  name: string;
  uuid: string;
  totalMemoryMiB: number;
  freeMemoryMiB: number;
}

export interface StationIpv4AddressProbe {
  address: string;
  prefixLength: number;
}

export interface StationRoceGidProbe {
  index: number;
  address: string;
}

export interface StationRailProbe {
  rdmaDevice: string;
  port: number;
  netdev: string;
  macAddress: string;
  uverbsDevice: string;
  pciAddress: string;
  pciName: string;
  state: string;
  linkLayer: string;
  speedMbps: number;
  mtu: number;
  ipv4Addresses: StationIpv4AddressProbe[];
  roceV2Ipv4Gids: StationRoceGidProbe[];
}

export interface StationModelSnapshotProbe {
  modelId: string;
  revision: string;
  path: string;
  directoryExists: boolean;
  complete: boolean;
  shardCount: number;
  reason: string;
}

export interface StationHostProbe {
  schemaVersion: 1;
  hostname: string;
  productName: string;
  architecture: string;
  home: string;
  uid: number;
  gid: number;
  gpus: StationGpuProbe[];
  docker: {
    reachable: boolean;
    nvidiaRuntime: boolean;
  };
  rsyncAvailable: boolean;
  rails: StationRailProbe[];
  modelSnapshot: StationModelSnapshotProbe;
}

export interface StationRailConnectivityRequest {
  netdev: string;
  sourceAddress: string;
  peerAddress: string;
  expectedPeerMac: string;
}

export interface StationRailConnectivityProbe {
  netdev: string;
  sourceAddress: string;
  peerAddress: string;
  routeDevice: string;
  routeSource: string;
  routeGateway: string | null;
  routeScope: string;
  peerMac: string;
  peerNeighborState: string;
  jumboPing: boolean;
}

export interface StationProbeCommandResult {
  status: number | null;
  stdout: string;
  stderr?: string;
  error?: string;
}

export interface StationClusterProbeDeps {
  loadPeerSshBinding(token: string, expectedPeerTarget: string): DualStationSshBinding;
  probePeerSshConfig(binding: DualStationSshBinding): StationProbeCommandResult;
  probeLocalHost(): StationProbeCommandResult;
  probePeerHost(binding: DualStationSshBinding): StationProbeCommandResult;
  probeLocalConnectivity(
    requests: readonly StationRailConnectivityRequest[],
  ): StationProbeCommandResult;
  probePeerConnectivity(
    binding: DualStationSshBinding,
    requests: readonly StationRailConnectivityRequest[],
  ): StationProbeCommandResult;
}

export type StationClusterFailureCode =
  | "invalid-peer"
  | "local-probe-failed"
  | "peer-probe-failed"
  | "local-not-station"
  | "peer-not-station"
  | "local-gpu-unavailable"
  | "peer-gpu-unavailable"
  | "local-docker-unavailable"
  | "peer-docker-unavailable"
  | "peer-ssh-config-unsafe"
  | "local-model-staging-unavailable"
  | "peer-model-staging-unavailable"
  | "local-fabric-unavailable"
  | "peer-fabric-unavailable"
  | "fabric-mismatch"
  | "gid-mismatch"
  | "peer-model-cache-unavailable"
  | "local-connectivity-failed"
  | "peer-connectivity-failed"
  | "probe-error";

export interface DualStationPlanNode {
  hostname: string;
  home: string;
  uid: number;
  gid: number;
  gpu: StationGpuProbe;
}

export interface DualStationPlanRailEndpoint {
  rdmaDevice: string;
  netdev: string;
  macAddress: string;
  uverbsDevice: string;
  pciAddress: string;
  address: string;
}

export interface DualStationPlanRail {
  index: number;
  subnet: string;
  local: DualStationPlanRailEndpoint;
  peer: DualStationPlanRailEndpoint;
}

export interface DualStationVllmPlan {
  peerSshBinding: DualStationSshBinding;
  runtime: typeof DUAL_STATION_VLLM_RUNTIME;
  local: DualStationPlanNode;
  peer: DualStationPlanNode;
  rails: DualStationPlanRail[];
  masterAddress: string;
  roceGidIndex: number;
}

export type StationClusterCapability =
  | { kind: "not-configured" }
  | { kind: "unavailable"; code: StationClusterFailureCode; reason: string }
  | {
      kind: "ready";
      plan: DualStationVllmPlan;
      peerModelSnapshot: "ready" | "staging-required";
    };

type PlanFailure = Extract<StationClusterCapability, { kind: "unavailable" }>;

type MatchedRail = {
  localRail: StationRailProbe;
  peerRail: StationRailProbe;
  localAddress: StationIpv4AddressProbe;
  peerAddress: StationIpv4AddressProbe;
  subnet: string;
};

type StaticPlan = {
  plan: DualStationVllmPlan;
  peerModelSnapshot: "ready" | "staging-required";
  localConnectivity: StationRailConnectivityRequest[];
  peerConnectivity: StationRailConnectivityRequest[];
};

type StationProbeSpawn = (
  file: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => StationProbeCommandResult;

const HOST_PROBE_SCRIPT = String.raw`
import csv
import ipaddress
import json
import os
from pathlib import Path
import platform
import re
import shutil
import socket
import stat
import subprocess

MODEL_ID = ${JSON.stringify(DUAL_STATION_VLLM_RUNTIME.modelId)}
MODEL_REVISION = ${JSON.stringify(DUAL_STATION_VLLM_RUNTIME.modelRevision)}
MODEL_CACHE_NAME = "models--" + MODEL_ID.replace("/", "--")

def read_text(path):
    try:
        return Path(path).read_text(encoding="utf-8").rstrip("\x00").strip()
    except (OSError, UnicodeError):
        return ""

def run(argv, timeout=5):
    try:
        result = subprocess.run(
            argv,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout,
            check=False,
        )
        return result.returncode, result.stdout.strip()
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired):
        return 127, ""

def product_name():
    for candidate in (
        "/sys/class/dmi/id/product_name",
        "/sys/devices/virtual/dmi/id/product_name",
        "/sys/firmware/devicetree/base/model",
    ):
        value = read_text(candidate)
        if value:
            return value
    return ""

def gpu_inventory():
    rc, output = run([
        "nvidia-smi",
        "--query-gpu=index,name,uuid,memory.total,memory.free",
        "--format=csv,noheader,nounits",
    ])
    if rc != 0:
        return []
    result = []
    for row in csv.reader(output.splitlines()):
        if len(row) != 5:
            continue
        try:
            index = int(row[0].strip())
            total_memory_mib = int(row[3].strip())
            free_memory_mib = int(row[4].strip())
        except ValueError:
            continue
        if total_memory_mib <= 0 or free_memory_mib < 0 or free_memory_mib > total_memory_mib:
            continue
        result.append({
            "index": index,
            "name": row[1].strip(),
            "uuid": row[2].strip(),
            "totalMemoryMiB": total_memory_mib,
            "freeMemoryMiB": free_memory_mib,
        })
    return result

def docker_state():
    rc, _ = run(["docker", "info", "--format", "{{.ServerVersion}}"])
    if rc != 0:
        return {"reachable": False, "nvidiaRuntime": False}
    runtime_rc, runtime_output = run([
        "docker", "run", "--rm", "--pull=never", "--network", "none",
        "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--pids-limit", "64", "--memory", "512m", "--cpus", "1",
        "--gpus", "all", "${STATION_RUNTIME_PROBE_IMAGE}",
        "nvidia-smi", "--query-gpu=uuid", "--format=csv,noheader",
    ], timeout=15)
    return {
        "reachable": True,
        "nvidiaRuntime": runtime_rc == 0 and any(
            line.strip().startswith("GPU-")
            for line in runtime_output.splitlines()
        ),
    }

def ipv4_addresses(netdev):
    rc, output = run(["ip", "-j", "-4", "address", "show", "dev", netdev])
    if rc != 0:
        return []
    try:
        links = json.loads(output)
    except json.JSONDecodeError:
        return []
    result = []
    for link in links if isinstance(links, list) else []:
        for address in link.get("addr_info", []):
            if address.get("family") != "inet" or address.get("scope") == "host":
                continue
            local = address.get("local")
            prefix = address.get("prefixlen")
            if isinstance(local, str) and isinstance(prefix, int):
                result.append({"address": local, "prefixLength": prefix})
    return result

def roce_v2_ipv4_gids(rdma_device, port, netdev):
    base = Path("/sys/class/infiniband") / rdma_device / "ports" / str(port)
    types_dir = base / "gid_attrs" / "types"
    result = []
    try:
        indexes = sorted(types_dir.iterdir(), key=lambda item: int(item.name))
    except (OSError, ValueError):
        return result
    for entry in indexes:
        try:
            index = int(entry.name)
        except ValueError:
            continue
        if read_text(entry).lower() != "roce v2":
            continue
        observed_netdev = read_text(base / "gid_attrs" / "ndevs" / str(index))
        if observed_netdev and observed_netdev != netdev:
            continue
        raw_gid = read_text(base / "gids" / str(index))
        try:
            mapped = ipaddress.IPv6Address(raw_gid).ipv4_mapped
        except ipaddress.AddressValueError:
            mapped = None
        if mapped is not None:
            result.append({"index": index, "address": str(mapped)})
    return result

def uverbs_device(rdma_device):
    verbs_dir = Path("/sys/class/infiniband") / rdma_device / "device" / "infiniband_verbs"
    try:
        names = sorted({
            entry.name
            for entry in verbs_dir.iterdir()
            if re.fullmatch(r"uverbs[0-9]+", entry.name)
        })
    except OSError:
        return ""
    if len(names) != 1:
        return ""
    device = Path("/dev/infiniband") / names[0]
    try:
        if not stat.S_ISCHR(device.stat().st_mode):
            return ""
    except OSError:
        return ""
    return str(device)

def rail_inventory():
    rc, output = run(["ibdev2netdev"])
    if rc != 0:
        return []
    rails = []
    pattern = re.compile(r"^(\S+)\s+port\s+(\d+)\s+==>\s+(\S+)\s+\(([^)]*)\)")
    for line in output.splitlines():
        match = pattern.match(line.strip())
        if not match:
            continue
        rdma_device, raw_port, netdev, _reported_state = match.groups()
        port = int(raw_port)
        device_path = Path("/sys/class/net") / netdev / "device"
        try:
            pci_address = device_path.resolve(strict=True).name
        except OSError:
            pci_address = ""
        rc_lspci, pci_name = run(["lspci", "-D", "-s", pci_address]) if pci_address else (127, "")
        if rc_lspci != 0:
            pci_name = ""
        try:
            speed_mbps = int(read_text(Path("/sys/class/net") / netdev / "speed"))
        except ValueError:
            speed_mbps = -1
        try:
            mtu = int(read_text(Path("/sys/class/net") / netdev / "mtu"))
        except ValueError:
            mtu = -1
        ib_port = Path("/sys/class/infiniband") / rdma_device / "ports" / str(port)
        rails.append({
            "rdmaDevice": rdma_device,
            "port": port,
            "netdev": netdev,
            "macAddress": read_text(Path("/sys/class/net") / netdev / "address").lower(),
            "uverbsDevice": uverbs_device(rdma_device),
            "pciAddress": pci_address,
            "pciName": pci_name,
            "state": read_text(ib_port / "state"),
            "linkLayer": read_text(ib_port / "link_layer"),
            "speedMbps": speed_mbps,
            "mtu": mtu,
            "ipv4Addresses": ipv4_addresses(netdev),
            "roceV2Ipv4Gids": roce_v2_ipv4_gids(rdma_device, port, netdev),
        })
    return rails

def snapshot_state():
    home = Path.home()
    snapshot = home / ".cache" / "huggingface" / "hub" / MODEL_CACHE_NAME / "snapshots" / MODEL_REVISION
    reasons = []
    shard_count = 0
    index_path = snapshot / "model.safetensors.index.json"
    if not snapshot.is_dir():
        reasons.append("snapshot directory is missing")
    if not (snapshot / "config.json").is_file():
        reasons.append("config.json is missing")
    tokenizer_present = any(
        (snapshot / name).is_file()
        for name in ("tokenizer.json", "tokenizer.model", "vocab.json")
    )
    if not tokenizer_present:
        reasons.append("tokenizer assets are missing")
    try:
        index = json.loads(index_path.read_text(encoding="utf-8"))
        weight_map = index.get("weight_map", {})
        metadata = index.get("metadata", {})
        shards = sorted(set(weight_map.values())) if isinstance(weight_map, dict) else []
        if not shards or not all(isinstance(item, str) for item in shards):
            reasons.append("weight index is empty or malformed")
            shards = []
        if len(shards) != ${String(113)}:
            reasons.append("weight index does not list the pinned shard count")
        expected_total_size = metadata.get("total_size") if isinstance(metadata, dict) else None
        if not isinstance(expected_total_size, int) or expected_total_size <= 0:
            reasons.append("weight index total_size is missing or malformed")
        shard_count = len(shards)
        observed_tensor_size = 0
        for shard in shards:
            shard_path = Path(shard)
            if (
                shard_path.is_absolute()
                or shard_path.name != shard
                or shard in (".", "..")
                or shard_path.suffix != ".safetensors"
            ):
                reasons.append("weight index contains an unsafe shard path")
                break
            candidate = snapshot / shard_path
            try:
                if not candidate.is_file() or candidate.stat().st_size <= 0:
                    reasons.append("one or more weight shards are missing")
                    break
                with candidate.open("rb") as handle:
                    raw_header_size = handle.read(8)
                    if len(raw_header_size) != 8:
                        raise ValueError("short safetensors header")
                    header_size = int.from_bytes(raw_header_size, "little")
                    if header_size <= 0 or header_size > 128 * 1024 * 1024:
                        raise ValueError("invalid safetensors header size")
                    header = json.loads(handle.read(header_size))
                tensor_ranges = []
                for tensor_name, tensor in header.items():
                    if tensor_name == "__metadata__":
                        continue
                    offsets = tensor.get("data_offsets") if isinstance(tensor, dict) else None
                    if (
                        not isinstance(offsets, list)
                        or len(offsets) != 2
                        or not all(isinstance(offset, int) for offset in offsets)
                        or offsets[0] < 0
                        or offsets[1] < offsets[0]
                    ):
                        raise ValueError("invalid safetensors data offsets")
                    tensor_ranges.append(offsets)
                if not tensor_ranges:
                    raise ValueError("empty safetensors shard")
                payload_size = max(offsets[1] for offsets in tensor_ranges)
                if candidate.stat().st_size != 8 + header_size + payload_size:
                    raise ValueError("truncated safetensors shard")
                observed_tensor_size += sum(offsets[1] - offsets[0] for offsets in tensor_ranges)
            except (OSError, UnicodeError, ValueError, json.JSONDecodeError):
                reasons.append("one or more weight shards are unreadable or malformed")
                break
        if isinstance(expected_total_size, int) and observed_tensor_size != expected_total_size:
            reasons.append("weight shard sizes do not match the pinned index")
    except (OSError, UnicodeError, json.JSONDecodeError):
        reasons.append("model.safetensors.index.json is missing or malformed")
    return {
        "modelId": MODEL_ID,
        "revision": MODEL_REVISION,
        "path": str(snapshot),
        "directoryExists": snapshot.is_dir(),
        "complete": not reasons,
        "shardCount": shard_count,
        "reason": "; ".join(dict.fromkeys(reasons)),
    }

payload = {
    "schemaVersion": ${String(HOST_PROBE_SCHEMA_VERSION)},
    "hostname": socket.gethostname(),
    "productName": product_name(),
    "architecture": platform.machine(),
    "home": str(Path.home()),
    "uid": os.getuid(),
    "gid": os.getgid(),
    "gpus": gpu_inventory(),
    "docker": docker_state(),
    "rsyncAvailable": shutil.which("rsync") is not None,
    "rails": rail_inventory(),
    "modelSnapshot": snapshot_state(),
}
print(json.dumps(payload, separators=(",", ":")))
`;

const CONNECTIVITY_PROBE_SCRIPT = String.raw`
import ipaddress
import json
import subprocess
import sys

def run(argv, timeout=5):
    try:
        result = subprocess.run(
            argv,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout,
            check=False,
        )
        return result.returncode, result.stdout.strip()
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired):
        return 127, ""

if len(sys.argv[1:]) != 6:
    raise SystemExit("expected two netdev/source/peer triples")

checks = []
for offset in (0, 3):
    netdev, source, peer = sys.argv[1 + offset:4 + offset]
    route_device = ""
    route_source = ""
    route_gateway = None
    route_scope = ""
    peer_mac = ""
    peer_neighbor_state = ""
    rc, output = run(["ip", "-j", "route", "get", peer, "from", source, "oif", netdev])
    if rc == 0:
        try:
            routes = json.loads(output)
            route = routes[0] if isinstance(routes, list) and routes else {}
            route_device = route.get("dev", "") if isinstance(route, dict) else ""
            route_source = (
                route.get("prefsrc") or route.get("src") or route.get("from", "")
                if isinstance(route, dict)
                else ""
            )
            route_gateway = route.get("gateway") if isinstance(route, dict) else None
        except json.JSONDecodeError:
            pass
    network = str(ipaddress.ip_network(source + "/${String(DIRECT_RAIL_PREFIX_LENGTH)}", strict=False))
    link_rc, link_output = run(["ip", "-j", "route", "show", "exact", network, "dev", netdev])
    if link_rc == 0:
        try:
            link_routes = json.loads(link_output)
            link_route = link_routes[0] if isinstance(link_routes, list) and link_routes else {}
            if (
                isinstance(link_route, dict)
                and link_route.get("dst") == network
                and link_route.get("dev", netdev) == netdev
                and link_route.get("gateway") is None
            ):
                route_scope = link_route.get("scope", "")
        except json.JSONDecodeError:
            pass
    ping_rc, _ = run([
        "ping", "-4", "-M", "do", "-s", "8972", "-c", "1", "-W", "2",
        "-I", source, peer,
    ])
    neighbor_rc, neighbor_output = run(["ip", "-j", "neighbor", "show", "to", peer, "dev", netdev])
    if neighbor_rc == 0:
        try:
            neighbors = json.loads(neighbor_output)
            neighbor = neighbors[0] if isinstance(neighbors, list) and neighbors else {}
            if (
                isinstance(neighbor, dict)
                and neighbor.get("dst") == peer
                and neighbor.get("dev", netdev) == netdev
            ):
                peer_mac = str(neighbor.get("lladdr", "")).lower()
                raw_state = neighbor.get("state", "")
                peer_neighbor_state = ",".join(raw_state) if isinstance(raw_state, list) else str(raw_state)
        except json.JSONDecodeError:
            pass
    checks.append({
        "netdev": netdev,
        "sourceAddress": source,
        "peerAddress": peer,
        "routeDevice": route_device,
        "routeSource": route_source,
        "routeGateway": route_gateway,
        "routeScope": route_scope,
        "peerMac": peer_mac,
        "peerNeighborState": peer_neighbor_state,
        "jumboPing": ping_rc == 0,
    })

print(json.dumps({
    "schemaVersion": ${String(CONNECTIVITY_PROBE_SCHEMA_VERSION)},
    "checks": checks,
}, separators=(",", ":")))
`;

function defaultSpawn(
  file: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
): StationProbeCommandResult {
  const result = spawnSync(file, [...args], options);
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error?.message,
  };
}

function commandOptions(input: string): SpawnSyncOptionsWithStringEncoding {
  return {
    encoding: "utf8",
    input,
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: MAX_PROBE_OUTPUT_BYTES,
    killSignal: "SIGKILL",
    windowsHide: true,
    env: buildSubprocessEnv({ LC_ALL: "C" }),
  };
}

function localProbeCommandOptions(input: string): SpawnSyncOptionsWithStringEncoding {
  const options = commandOptions(input);
  for (const name of DUAL_STATION_LOCAL_DOCKER_OVERRIDE_ENV_NAMES) delete options.env?.[name];
  if (options.env) options.env.DOCKER_CONTEXT = "default";
  return options;
}

function sshCommandOptions(input: string): SpawnSyncOptionsWithStringEncoding {
  return {
    ...commandOptions(input),
    env: buildVllmSshTransportEnv({ LC_ALL: "C" }),
  };
}

function strictSshArgs(binding: DualStationSshBinding, remoteCommand: string): string[] {
  return [...dualStationPinnedSshArgs(binding), "--", binding.peerTarget, remoteCommand];
}

function connectivityArgv(requests: readonly StationRailConnectivityRequest[]): string[] {
  if (requests.length !== 2) {
    throw new Error("dual-Station connectivity requires exactly two rail requests");
  }
  const args: string[] = [];
  for (const request of requests) {
    if (!isSafeDeviceName(request.netdev)) throw new Error("unsafe connectivity netdev");
    if (!isIpv4(request.sourceAddress) || !isIpv4(request.peerAddress)) {
      throw new Error("invalid connectivity address");
    }
    normalizeMacAddress(request.expectedPeerMac, "connectivity peer MAC");
    args.push(request.netdev, request.sourceAddress, request.peerAddress);
  }
  return args;
}

/**
 * Construct the real read-only probe boundary. The optional spawn injection is
 * intentionally lower-level than StationClusterProbeDeps so tests can assert
 * the exact SSH trust flags and fixed-stdin behavior without making a network
 * connection.
 */
export function createStationClusterProbeDeps(
  spawn: StationProbeSpawn = defaultSpawn,
): StationClusterProbeDeps {
  return {
    loadPeerSshBinding: loadDualStationSshBindingHandoff,
    probePeerSshConfig: (binding) => {
      return spawn(
        "ssh",
        ["-G", ...dualStationPinnedSshArgs(binding), "--", binding.peerTarget],
        sshCommandOptions(""),
      );
    },
    probeLocalHost: () => spawn("python3", ["-"], localProbeCommandOptions(HOST_PROBE_SCRIPT)),
    probePeerHost: (binding) => {
      return spawn(
        "ssh",
        strictSshArgs(binding, "python3 -"),
        sshCommandOptions(HOST_PROBE_SCRIPT),
      );
    },
    probeLocalConnectivity: (requests) => {
      const args = connectivityArgv(requests);
      return spawn("python3", ["-", ...args], localProbeCommandOptions(CONNECTIVITY_PROBE_SCRIPT));
    },
    probePeerConnectivity: (binding, requests) => {
      const args = connectivityArgv(requests);
      const remoteCommand = ["python3", "-", ...args].join(" ");
      return spawn(
        "ssh",
        strictSshArgs(binding, remoteCommand),
        sshCommandOptions(CONNECTIVITY_PROBE_SCRIPT),
      );
    },
  };
}

const defaultStationClusterProbeDeps = createStationClusterProbeDeps();

type PeerValidation = { ok: true; target: string } | { ok: false; reason: string };

export function validatePeerTarget(raw: string): PeerValidation {
  if (raw.length === 0 || raw !== raw.trim()) {
    return { ok: false, reason: `${NEMOCLAW_DGX_STATION_PEER_ENV} must not contain whitespace` };
  }
  if (raw.length > 286) {
    return { ok: false, reason: `${NEMOCLAW_DGX_STATION_PEER_ENV} is too long` };
  }
  if (/[/,:;`'"\\$(){}[\]<>|&!?*\s\u0000-\u001f\u007f]/.test(raw)) {
    return {
      ok: false,
      reason: `${NEMOCLAW_DGX_STATION_PEER_ENV} must name one SSH host or user@host`,
    };
  }
  const parts = raw.split("@");
  if (parts.length > 2) {
    return {
      ok: false,
      reason: `${NEMOCLAW_DGX_STATION_PEER_ENV} must name one SSH host or user@host`,
    };
  }
  const username = parts.length === 2 ? parts[0] : "";
  const hostname = parts.at(-1) ?? "";
  const validHostname = net.isIP(hostname) === 4 || CANONICAL_SSH_HOST_PATTERN.test(hostname);
  if (
    !validHostname ||
    (username.length > 0 && !CANONICAL_SSH_USERNAME_PATTERN.test(username)) ||
    (parts.length === 2 && username.length === 0)
  ) {
    return {
      ok: false,
      reason: `${NEMOCLAW_DGX_STATION_PEER_ENV} must name one canonical SSH host or user@host`,
    };
  }
  return { ok: true, target: raw };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requireString(value: unknown, label: string, maxLength = 1024): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${label} must be a non-empty printable string`);
  }
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function requireInteger(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${label} must be an integer between ${String(min)} and ${String(max)}`);
  }
  return value as number;
}

function requireArray(value: unknown, label: string, maxLength: number): unknown[] {
  if (!Array.isArray(value) || value.length > maxLength) {
    throw new Error(`${label} must be an array with at most ${String(maxLength)} entries`);
  }
  return value;
}

function isSafeDeviceName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(value);
}

function isIpv4(value: string): boolean {
  return net.isIP(value) === 4;
}

function normalizeMacAddress(value: unknown, label: string, allowEmpty = false): string {
  if (allowEmpty && value === "") return "";
  const mac = requireString(value, label, 17).toLowerCase();
  if (!/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac)) {
    throw new Error(`${label} must be a canonical MAC address`);
  }
  return mac;
}

function parseUverbsDevice(value: unknown, label: string): string {
  if (value === "") return "";
  const device = requireString(value, label, 64);
  if (!/^\/dev\/infiniband\/uverbs[0-9]+$/.test(device)) {
    throw new Error(`${label} must be a safe /dev/infiniband/uverbs* character-device path`);
  }
  return device;
}

function parseGpu(value: unknown, label: string): StationGpuProbe {
  const record = requireRecord(value, label);
  const name = requireString(record.name, `${label}.name`, 256);
  const uuid = requireString(record.uuid, `${label}.uuid`, 128);
  if (!/^GPU-[A-Za-z0-9-]+$/.test(uuid)) throw new Error(`${label}.uuid is invalid`);
  const totalMemoryMiB = requireInteger(
    record.totalMemoryMiB,
    `${label}.totalMemoryMiB`,
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const freeMemoryMiB = requireInteger(
    record.freeMemoryMiB,
    `${label}.freeMemoryMiB`,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  if (freeMemoryMiB > totalMemoryMiB) {
    throw new Error(`${label}.freeMemoryMiB exceeds total memory`);
  }
  return {
    index: requireInteger(record.index, `${label}.index`, 0, 1024),
    name,
    uuid,
    totalMemoryMiB,
    freeMemoryMiB,
  };
}

function parseIpv4Address(value: unknown, label: string): StationIpv4AddressProbe {
  const record = requireRecord(value, label);
  const address = requireString(record.address, `${label}.address`, 15);
  if (!isIpv4(address)) throw new Error(`${label}.address must be IPv4`);
  return {
    address,
    prefixLength: requireInteger(record.prefixLength, `${label}.prefixLength`, 1, 32),
  };
}

function parseGid(value: unknown, label: string): StationRoceGidProbe {
  const record = requireRecord(value, label);
  const address = requireString(record.address, `${label}.address`, 15);
  if (!isIpv4(address)) throw new Error(`${label}.address must be IPv4`);
  return {
    index: requireInteger(record.index, `${label}.index`, 0, 4095),
    address,
  };
}

function parseRail(value: unknown, label: string): StationRailProbe {
  const record = requireRecord(value, label);
  const rdmaDevice = requireString(record.rdmaDevice, `${label}.rdmaDevice`, 64);
  const netdev = requireString(record.netdev, `${label}.netdev`, 64);
  if (!isSafeDeviceName(rdmaDevice) || !isSafeDeviceName(netdev)) {
    throw new Error(`${label} contains an unsafe device name`);
  }
  const pciAddress = requireString(record.pciAddress, `${label}.pciAddress`, 32);
  if (!/^[0-9A-Fa-f]{4}:[0-9A-Fa-f]{2}:[0-9A-Fa-f]{2}\.[0-7]$/.test(pciAddress)) {
    throw new Error(`${label}.pciAddress is invalid`);
  }
  return {
    rdmaDevice,
    port: requireInteger(record.port, `${label}.port`, 1, 255),
    netdev,
    macAddress: normalizeMacAddress(record.macAddress, `${label}.macAddress`),
    uverbsDevice: parseUverbsDevice(record.uverbsDevice, `${label}.uverbsDevice`),
    pciAddress,
    pciName: requireString(record.pciName, `${label}.pciName`, 512),
    state: requireString(record.state, `${label}.state`, 128),
    linkLayer: requireString(record.linkLayer, `${label}.linkLayer`, 128),
    speedMbps: requireInteger(record.speedMbps, `${label}.speedMbps`, -1, 1_000_000),
    mtu: requireInteger(record.mtu, `${label}.mtu`, -1, 1_000_000),
    ipv4Addresses: requireArray(record.ipv4Addresses, `${label}.ipv4Addresses`, 16).map(
      (entry, index) => parseIpv4Address(entry, `${label}.ipv4Addresses[${String(index)}]`),
    ),
    roceV2Ipv4Gids: requireArray(record.roceV2Ipv4Gids, `${label}.roceV2Ipv4Gids`, 128).map(
      (entry, index) => parseGid(entry, `${label}.roceV2Ipv4Gids[${String(index)}]`),
    ),
  };
}

function parseSnapshot(value: unknown, label: string): StationModelSnapshotProbe {
  const record = requireRecord(value, label);
  const snapshotPath = requireString(record.path, `${label}.path`, 4096);
  if (
    !path.posix.isAbsolute(snapshotPath) ||
    path.posix.normalize(snapshotPath) !== snapshotPath ||
    snapshotPath.includes(":")
  ) {
    throw new Error(`${label}.path must be a normalized absolute POSIX path`);
  }
  return {
    modelId: requireString(record.modelId, `${label}.modelId`, 512),
    revision: requireString(record.revision, `${label}.revision`, 128),
    path: snapshotPath,
    directoryExists: requireBoolean(record.directoryExists, `${label}.directoryExists`),
    complete: requireBoolean(record.complete, `${label}.complete`),
    shardCount: requireInteger(record.shardCount, `${label}.shardCount`, 0, 100_000),
    reason: typeof record.reason === "string" ? record.reason.slice(0, 1024) : "",
  };
}

export function parseStationHostProbe(stdout: string): StationHostProbe {
  if (Buffer.byteLength(stdout, "utf8") > MAX_PROBE_OUTPUT_BYTES) {
    throw new Error("host probe output is too large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("host probe did not return valid JSON");
  }
  const record = requireRecord(parsed, "host probe");
  if (record.schemaVersion !== HOST_PROBE_SCHEMA_VERSION) {
    throw new Error("host probe schema version is unsupported");
  }
  const home = requireString(record.home, "host probe.home", 4096);
  if (!path.posix.isAbsolute(home) || path.posix.normalize(home) !== home || home.includes(":")) {
    throw new Error("host probe.home must be a normalized absolute POSIX path");
  }
  const docker = requireRecord(record.docker, "host probe.docker");
  return {
    schemaVersion: 1,
    hostname: requireString(record.hostname, "host probe.hostname", 256),
    productName: requireString(record.productName, "host probe.productName", 512),
    architecture: requireString(record.architecture, "host probe.architecture", 64),
    home,
    uid: requireInteger(record.uid, "host probe.uid", 1, 2_147_483_647),
    gid: requireInteger(record.gid, "host probe.gid", 1, 2_147_483_647),
    gpus: requireArray(record.gpus, "host probe.gpus", 64).map((entry, index) =>
      parseGpu(entry, `host probe.gpus[${String(index)}]`),
    ),
    docker: {
      reachable: requireBoolean(docker.reachable, "host probe.docker.reachable"),
      nvidiaRuntime: requireBoolean(docker.nvidiaRuntime, "host probe.docker.nvidiaRuntime"),
    },
    rsyncAvailable: requireBoolean(record.rsyncAvailable, "host probe.rsyncAvailable"),
    rails: requireArray(record.rails, "host probe.rails", 32).map((entry, index) =>
      parseRail(entry, `host probe.rails[${String(index)}]`),
    ),
    modelSnapshot: parseSnapshot(record.modelSnapshot, "host probe.modelSnapshot"),
  };
}

function parseConnectivityProbe(stdout: string): StationRailConnectivityProbe[] {
  if (Buffer.byteLength(stdout, "utf8") > MAX_PROBE_OUTPUT_BYTES) {
    throw new Error("connectivity probe output is too large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("connectivity probe did not return valid JSON");
  }
  const record = requireRecord(parsed, "connectivity probe");
  if (record.schemaVersion !== CONNECTIVITY_PROBE_SCHEMA_VERSION) {
    throw new Error("connectivity probe schema version is unsupported");
  }
  return requireArray(record.checks, "connectivity probe.checks", 2).map((value, index) => {
    const label = `connectivity probe.checks[${String(index)}]`;
    const check = requireRecord(value, label);
    const netdev = requireString(check.netdev, `${label}.netdev`, 64);
    const sourceAddress = requireString(check.sourceAddress, `${label}.sourceAddress`, 15);
    const peerAddress = requireString(check.peerAddress, `${label}.peerAddress`, 15);
    const routeDevice =
      check.routeDevice === "" ? "" : requireString(check.routeDevice, `${label}.routeDevice`, 64);
    const routeSource =
      check.routeSource === "" ? "" : requireString(check.routeSource, `${label}.routeSource`, 15);
    const routeScope =
      check.routeScope === "" ? "" : requireString(check.routeScope, `${label}.routeScope`, 32);
    const peerNeighborState =
      check.peerNeighborState === ""
        ? ""
        : requireString(check.peerNeighborState, `${label}.peerNeighborState`, 128);
    if (
      !isSafeDeviceName(netdev) ||
      !isIpv4(sourceAddress) ||
      !isIpv4(peerAddress) ||
      (routeDevice !== "" && !isSafeDeviceName(routeDevice)) ||
      (routeSource !== "" && !isIpv4(routeSource))
    ) {
      throw new Error(`${label} contains invalid route data`);
    }
    let routeGateway: string | null = null;
    if (check.routeGateway !== null && check.routeGateway !== undefined) {
      routeGateway = requireString(check.routeGateway, `${label}.routeGateway`, 15);
      if (!isIpv4(routeGateway)) throw new Error(`${label}.routeGateway must be IPv4`);
    }
    return {
      netdev,
      sourceAddress,
      peerAddress,
      routeDevice,
      routeSource,
      routeGateway,
      routeScope,
      peerMac: normalizeMacAddress(check.peerMac, `${label}.peerMac`, true),
      peerNeighborState,
      jumboPing: requireBoolean(check.jumboPing, `${label}.jumboPing`),
    };
  });
}

function commandSucceeded(result: StationProbeCommandResult): boolean {
  return result.status === 0 && !result.error && result.stdout.trim().length > 0;
}

function unavailable(code: StationClusterFailureCode, reason: string): PlanFailure {
  return { kind: "unavailable", code, reason };
}

function dockerSshConfigIsStrict(
  result: StationProbeCommandResult,
  binding: DualStationSshBinding,
): boolean {
  if (!commandSucceeded(result)) return false;
  const values = new Map<string, string[]>();
  for (const rawLine of result.stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const separator = line.search(/\s/);
    if (separator <= 0) return false;
    const key = line.slice(0, separator).toLowerCase();
    const value = line.slice(separator).trim();
    values.set(key, [...(values.get(key) ?? []), value]);
  }
  const exactly = (key: string, allowed: readonly string[]): boolean => {
    const observed = (values.get(key) ?? []).map((value) => value.toLowerCase());
    return observed.length === 1 && allowed.includes(observed[0]);
  };
  const exactlyValue = (key: string, expected: string): boolean => {
    const observed = values.get(key) ?? [];
    return observed.length === 1 && observed[0] === expected;
  };
  const absentOrNone = (key: string): boolean => {
    const observed = (values.get(key) ?? []).map((value) => value.toLowerCase());
    return observed.length === 0 || (observed.length === 1 && observed[0] === "none");
  };
  const sendEnv = (values.get("sendenv") ?? []).map((value) => value.toLowerCase());
  return (
    exactlyValue("hostname", binding.resolvedHost) &&
    exactlyValue("user", binding.sshUser) &&
    exactlyValue("port", String(binding.port)) &&
    exactlyValue("hostkeyalias", binding.lookupHost) &&
    exactlyValue("userknownhostsfile", binding.knownHostsFile) &&
    exactlyValue("globalknownhostsfile", "/dev/null") &&
    exactly("batchmode", ["yes"]) &&
    exactly("stricthostkeychecking", ["yes", "true"]) &&
    exactly("permitlocalcommand", ["no"]) &&
    exactly("forwardagent", ["no"]) &&
    exactly("forwardx11", ["no"]) &&
    exactly("forwardx11trusted", ["no"]) &&
    exactly("tunnel", ["false", "no"]) &&
    exactly("updatehostkeys", ["false", "no"]) &&
    exactly("controlmaster", ["false", "no"]) &&
    exactly("controlpersist", ["no", "0"]) &&
    absentOrNone("controlpath") &&
    absentOrNone("remotecommand") &&
    absentOrNone("proxycommand") &&
    absentOrNone("proxyjump") &&
    absentOrNone("localcommand") &&
    !values.has("localforward") &&
    !values.has("remoteforward") &&
    !values.has("dynamicforward") &&
    absentOrNone("knownhostscommand") &&
    !values.has("setenv") &&
    sendEnv.every((value) => value === "lang" || value === "lc_*")
  );
}

function selectGb300(host: StationHostProbe): StationGpuProbe | null {
  const matches = host.gpus.filter((gpu) => /\bGB300\b/i.test(gpu.name));
  return matches.length === 1 ? matches[0] : null;
}

function qualifiedRails(host: StationHostProbe): StationRailProbe[] | null {
  const cx8Rails = host.rails.filter((rail) => /ConnectX[- ]?8|\bCX-?8\b/i.test(rail.pciName));
  if (cx8Rails.length !== 2) return null;
  const uniqueRdma = new Set(cx8Rails.map((rail) => rail.rdmaDevice));
  const uniqueNetdev = new Set(cx8Rails.map((rail) => rail.netdev));
  const uniquePci = new Set(cx8Rails.map((rail) => rail.pciAddress));
  const uniqueMac = new Set(cx8Rails.map((rail) => rail.macAddress));
  const uniqueUverbs = new Set(cx8Rails.map((rail) => rail.uverbsDevice));
  if (
    uniqueRdma.size !== 2 ||
    uniqueNetdev.size !== 2 ||
    uniquePci.size !== 2 ||
    uniqueMac.size !== 2 ||
    uniqueUverbs.size !== 2 ||
    uniqueUverbs.has("")
  ) {
    return null;
  }
  for (const rail of cx8Rails) {
    const firstMacOctet = Number.parseInt(rail.macAddress.slice(0, 2), 16);
    if (
      rail.macAddress === "00:00:00:00:00:00" ||
      (firstMacOctet & 1) !== 0 ||
      rail.port !== 1 ||
      !/\bACTIVE\b/i.test(rail.state) ||
      rail.linkLayer.toLowerCase() !== "ethernet" ||
      rail.speedMbps !== 400_000 ||
      rail.mtu !== 9000 ||
      rail.ipv4Addresses.length === 0 ||
      rail.roceV2Ipv4Gids.length === 0
    ) {
      return null;
    }
  }
  return cx8Rails;
}

function ipv4ToNumber(address: string): number {
  return address
    .split(".")
    .map(Number)
    .reduce((value, octet) => value * 256 + octet, 0);
}

function numberToIpv4(value: number): string {
  return [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join(".");
}

function subnetKey(address: StationIpv4AddressProbe): string {
  const hostBits = 32 - address.prefixLength;
  const divisor = 2 ** hostBits;
  const network = Math.floor(ipv4ToNumber(address.address) / divisor) * divisor;
  return `${numberToIpv4(network)}/${String(address.prefixLength)}`;
}

function isPrivateFabricIpv4(address: string): boolean {
  const value = ipv4ToNumber(address);
  return (
    (value >= ipv4ToNumber("10.0.0.0") && value <= ipv4ToNumber("10.255.255.255")) ||
    (value >= ipv4ToNumber("172.16.0.0") && value <= ipv4ToNumber("172.31.255.255")) ||
    (value >= ipv4ToNumber("192.168.0.0") && value <= ipv4ToNumber("192.168.255.255"))
  );
}

function sharedAddressPairs(
  localRail: StationRailProbe,
  peerRail: StationRailProbe,
): Array<{
  localAddress: StationIpv4AddressProbe;
  peerAddress: StationIpv4AddressProbe;
  subnet: string;
}> {
  const matches: Array<{
    localAddress: StationIpv4AddressProbe;
    peerAddress: StationIpv4AddressProbe;
    subnet: string;
  }> = [];
  for (const localAddress of localRail.ipv4Addresses) {
    for (const peerAddress of peerRail.ipv4Addresses) {
      const localSubnet = subnetKey(localAddress);
      if (
        localAddress.address !== peerAddress.address &&
        localAddress.prefixLength === DIRECT_RAIL_PREFIX_LENGTH &&
        peerAddress.prefixLength === DIRECT_RAIL_PREFIX_LENGTH &&
        isPrivateFabricIpv4(localAddress.address) &&
        isPrivateFabricIpv4(peerAddress.address) &&
        localSubnet === subnetKey(peerAddress)
      ) {
        matches.push({ localAddress, peerAddress, subnet: localSubnet });
      }
    }
  }
  return matches;
}

function matchRails(
  localRails: readonly StationRailProbe[],
  peerRails: readonly StationRailProbe[],
): MatchedRail[] | null {
  const permutations = [
    [0, 1],
    [1, 0],
  ] as const;
  const candidates: MatchedRail[][] = [];
  for (const permutation of permutations) {
    const candidate: MatchedRail[] = [];
    let valid = true;
    for (let index = 0; index < 2; index += 1) {
      const localRail = localRails[index];
      const peerRail = peerRails[permutation[index]];
      const addressMatches = sharedAddressPairs(localRail, peerRail);
      if (addressMatches.length !== 1) {
        valid = false;
        break;
      }
      candidate.push({ localRail, peerRail, ...addressMatches[0] });
    }
    if (valid && new Set(candidate.map((match) => match.subnet)).size === 2) {
      candidates.push(candidate);
    }
  }
  if (candidates.length !== 1) return null;
  return candidates[0].sort((left, right) =>
    left.localRail.rdmaDevice.localeCompare(right.localRail.rdmaDevice, undefined, {
      numeric: true,
    }),
  );
}

function gidsForMatchedAddress(rail: StationRailProbe, address: string): Set<number> {
  return new Set(
    rail.roceV2Ipv4Gids.filter((gid) => gid.address === address).map((gid) => gid.index),
  );
}

function commonGidIndex(matches: readonly MatchedRail[]): number | null {
  const sets = matches.flatMap((match) => [
    gidsForMatchedAddress(match.localRail, match.localAddress.address),
    gidsForMatchedAddress(match.peerRail, match.peerAddress.address),
  ]);
  if (sets.some((set) => set.size === 0)) return null;
  const common = [...sets[0]].filter((index) => sets.slice(1).every((set) => set.has(index)));
  if (common.includes(PREFERRED_ROCE_GID_INDEX)) return PREFERRED_ROCE_GID_INDEX;
  return common.sort((left, right) => left - right)[0] ?? null;
}

function expectedPeerSnapshotPath(peer: StationHostProbe): string {
  return path.posix.join(
    peer.home,
    ".cache",
    "huggingface",
    "hub",
    `models--${DUAL_STATION_VLLM_RUNTIME.modelId.replace("/", "--")}`,
    "snapshots",
    DUAL_STATION_VLLM_RUNTIME.modelRevision,
  );
}

function buildStaticPlan(
  peerSshBinding: DualStationSshBinding,
  local: StationHostProbe,
  peer: StationHostProbe,
): StaticPlan | PlanFailure {
  if (
    !isDgxStationGb300Product(local.productName) ||
    !/^(?:aarch64|arm64)$/i.test(local.architecture)
  ) {
    return unavailable("local-not-station", "local host is not a verified arm64 DGX Station");
  }
  if (
    !isDgxStationGb300Product(peer.productName) ||
    !/^(?:aarch64|arm64)$/i.test(peer.architecture)
  ) {
    return unavailable("peer-not-station", "configured peer is not a verified arm64 DGX Station");
  }

  const localGpu = selectGb300(local);
  if (!localGpu) {
    return unavailable("local-gpu-unavailable", "local host must expose exactly one GB300 GPU");
  }
  const peerGpu = selectGb300(peer);
  if (!peerGpu) {
    return unavailable("peer-gpu-unavailable", "configured peer must expose exactly one GB300 GPU");
  }
  if (localGpu.uuid === peerGpu.uuid) {
    return unavailable(
      "fabric-mismatch",
      "configured peer resolved to the local Station instead of a distinct host",
    );
  }
  if (!local.docker.reachable || !local.docker.nvidiaRuntime) {
    return unavailable(
      "local-docker-unavailable",
      "local Docker daemon and NVIDIA runtime could not both be verified",
    );
  }
  if (!peer.docker.reachable || !peer.docker.nvidiaRuntime) {
    return unavailable(
      "peer-docker-unavailable",
      "peer Docker daemon and NVIDIA runtime could not both be verified",
    );
  }
  const localRails = qualifiedRails(local);
  if (!localRails) {
    return unavailable(
      "local-fabric-unavailable",
      "local host does not have two active Ethernet 400G MTU-9000 CX8 RDMA rails",
    );
  }
  const peerRails = qualifiedRails(peer);
  if (!peerRails) {
    return unavailable(
      "peer-fabric-unavailable",
      "peer does not have two active Ethernet 400G MTU-9000 CX8 RDMA rails",
    );
  }

  const snapshot = peer.modelSnapshot;
  if (
    snapshot.modelId !== DUAL_STATION_VLLM_RUNTIME.modelId ||
    snapshot.revision !== DUAL_STATION_VLLM_RUNTIME.modelRevision ||
    snapshot.path !== expectedPeerSnapshotPath(peer)
  ) {
    return unavailable(
      "peer-model-cache-unavailable",
      "peer reported an unexpected Nemotron Ultra snapshot identity or path",
    );
  }
  const peerSnapshotReady =
    snapshot.directoryExists &&
    snapshot.complete &&
    snapshot.shardCount === EXPECTED_ULTRA_WEIGHT_SHARDS;
  if (!peerSnapshotReady && snapshot.directoryExists) {
    return unavailable(
      "peer-model-cache-unavailable",
      "peer has an incomplete pinned Nemotron Ultra snapshot; refusing to overwrite it",
    );
  }
  if (!peerSnapshotReady && !local.rsyncAvailable) {
    return unavailable(
      "local-model-staging-unavailable",
      "local rsync is required to stage the pinned Nemotron Ultra snapshot",
    );
  }
  if (!peerSnapshotReady && !peer.rsyncAvailable) {
    return unavailable(
      "peer-model-staging-unavailable",
      "peer rsync is required to stage the pinned Nemotron Ultra snapshot",
    );
  }

  const matches = matchRails(localRails, peerRails);
  if (!matches) {
    return unavailable(
      "fabric-mismatch",
      "the two hosts do not expose one unambiguous pair of distinct private /30 CX8 subnets",
    );
  }
  const gidIndex = commonGidIndex(matches);
  if (gidIndex === null) {
    return unavailable(
      "gid-mismatch",
      "the four matched rail endpoints do not share a RoCEv2 IPv4 GID index",
    );
  }

  const rails = matches.map(
    (match, index): DualStationPlanRail => ({
      index,
      subnet: match.subnet,
      local: {
        rdmaDevice: match.localRail.rdmaDevice,
        netdev: match.localRail.netdev,
        macAddress: match.localRail.macAddress,
        uverbsDevice: match.localRail.uverbsDevice,
        pciAddress: match.localRail.pciAddress,
        address: match.localAddress.address,
      },
      peer: {
        rdmaDevice: match.peerRail.rdmaDevice,
        netdev: match.peerRail.netdev,
        macAddress: match.peerRail.macAddress,
        uverbsDevice: match.peerRail.uverbsDevice,
        pciAddress: match.peerRail.pciAddress,
        address: match.peerAddress.address,
      },
    }),
  );

  return {
    plan: {
      peerSshBinding,
      runtime: DUAL_STATION_VLLM_RUNTIME,
      local: {
        hostname: local.hostname,
        home: local.home,
        uid: local.uid,
        gid: local.gid,
        gpu: localGpu,
      },
      peer: {
        hostname: peer.hostname,
        home: peer.home,
        uid: peer.uid,
        gid: peer.gid,
        gpu: peerGpu,
      },
      rails,
      masterAddress: rails[0].local.address,
      roceGidIndex: gidIndex,
    },
    peerModelSnapshot: peerSnapshotReady ? "ready" : "staging-required",
    localConnectivity: rails.map((rail) => ({
      netdev: rail.local.netdev,
      sourceAddress: rail.local.address,
      peerAddress: rail.peer.address,
      expectedPeerMac: rail.peer.macAddress,
    })),
    peerConnectivity: rails.map((rail) => ({
      netdev: rail.peer.netdev,
      sourceAddress: rail.peer.address,
      peerAddress: rail.local.address,
      expectedPeerMac: rail.local.macAddress,
    })),
  };
}

function connectivityMatches(
  requests: readonly StationRailConnectivityRequest[],
  observed: readonly StationRailConnectivityProbe[],
): boolean {
  if (observed.length !== requests.length) return false;
  const byKey = new Map(
    observed.map((check) => [`${check.netdev}|${check.sourceAddress}|${check.peerAddress}`, check]),
  );
  if (byKey.size !== observed.length) return false;
  return requests.every((request) => {
    const check = byKey.get(`${request.netdev}|${request.sourceAddress}|${request.peerAddress}`);
    return Boolean(
      check &&
        check.routeDevice === request.netdev &&
        check.routeSource === request.sourceAddress &&
        check.routeGateway === null &&
        check.routeScope.toLowerCase() === "link" &&
        check.peerMac === request.expectedPeerMac &&
        /^(?:REACHABLE|STALE|DELAY|PROBE|PERMANENT|NOARP)(?:,(?:REACHABLE|STALE|DELAY|PROBE|PERMANENT|NOARP))*$/i.test(
          check.peerNeighborState,
        ) &&
        check.jumboPing,
    );
  });
}

function parseHostCommand(
  result: StationProbeCommandResult,
  code: "local-probe-failed" | "peer-probe-failed",
): StationHostProbe | PlanFailure {
  if (!commandSucceeded(result)) {
    return unavailable(
      code,
      code === "local-probe-failed" ? "local host probe failed" : "peer host probe failed",
    );
  }
  try {
    return parseStationHostProbe(result.stdout.trim());
  } catch {
    return unavailable(
      code,
      code === "local-probe-failed"
        ? "local host probe returned invalid data"
        : "peer host probe returned invalid data",
    );
  }
}

export interface ProbeDualStationVllmOptions {
  env?: NodeJS.ProcessEnv;
  deps?: StationClusterProbeDeps;
}

/**
 * Read-only, fail-closed capability probe for the explicit two-Station path.
 *
 * An unset/blank NEMOCLAW_DGX_STATION_PEER returns before touching deps. A
 * configured peer is contacted only through the installer-qualified binding;
 * the probe never discovers hosts, changes known_hosts, prompts, or mutates
 * either machine.
 */
export function probeDualStationVllmCapability(
  options: ProbeDualStationVllmOptions = {},
): StationClusterCapability {
  const env = options.env ?? process.env;
  const rawPeer = env[NEMOCLAW_DGX_STATION_PEER_ENV];
  if (rawPeer === undefined || rawPeer === "" || rawPeer.trim() === "") {
    return { kind: "not-configured" };
  }
  const peerValidation = validatePeerTarget(rawPeer);
  if (!peerValidation.ok) return unavailable("invalid-peer", peerValidation.reason);
  const rawBinding = env[NEMOCLAW_DGX_STATION_SSH_BINDING_ENV];
  if (rawBinding === undefined || rawBinding === "" || rawBinding.trim() === "") {
    return unavailable(
      "peer-ssh-config-unsafe",
      `${NEMOCLAW_DGX_STATION_SSH_BINDING_ENV} must identify the installer-qualified peer`,
    );
  }
  const localDockerOverride = DUAL_STATION_LOCAL_DOCKER_OVERRIDE_ENV_NAMES.find((name) => {
    const value = String(env[name] ?? "").trim();
    const isLocalDefaultSelection =
      (name === "DOCKER_CONTEXT" && value === "default") ||
      (name === "DOCKER_HOST" &&
        (value === "unix:///run/docker.sock" || value === "unix:///var/run/docker.sock"));
    return value !== "" && !isLocalDefaultSelection;
  });
  if (localDockerOverride) {
    return unavailable(
      "local-docker-unavailable",
      `${localDockerOverride} must be unset so dual-Station setup can bind the physical local Docker daemon`,
    );
  }

  const deps = options.deps ?? defaultStationClusterProbeDeps;
  let peerSshBinding: DualStationSshBinding;
  try {
    peerSshBinding = deps.loadPeerSshBinding(rawBinding, peerValidation.target);
  } catch {
    return unavailable(
      "peer-ssh-config-unsafe",
      "installer-qualified Station SSH binding is invalid or changed",
    );
  }
  if (peerSshBinding.peerTarget !== peerValidation.target) {
    return unavailable(
      "peer-ssh-config-unsafe",
      "qualified Station SSH binding does not match the configured peer",
    );
  }
  try {
    const sshConfig = deps.probePeerSshConfig(peerSshBinding);
    if (!dockerSshConfigIsStrict(sshConfig, peerSshBinding)) {
      return unavailable(
        "peer-ssh-config-unsafe",
        "configured peer SSH options are not safe for Docker transport; require BatchMode=yes, StrictHostKeyChecking=yes, no forwarding/proxy/local commands, and no connection sharing",
      );
    }
    const localResult = parseHostCommand(deps.probeLocalHost(), "local-probe-failed");
    if ("kind" in localResult) return localResult;
    const peerResult = parseHostCommand(deps.probePeerHost(peerSshBinding), "peer-probe-failed");
    if ("kind" in peerResult) return peerResult;

    const staticPlan = buildStaticPlan(peerSshBinding, localResult, peerResult);
    if ("kind" in staticPlan) return staticPlan;

    const localConnectivityResult = deps.probeLocalConnectivity(staticPlan.localConnectivity);
    if (!commandSucceeded(localConnectivityResult)) {
      return unavailable(
        "local-connectivity-failed",
        "local dual-rail route and jumbo-frame probe failed",
      );
    }
    let localConnectivity: StationRailConnectivityProbe[];
    try {
      localConnectivity = parseConnectivityProbe(localConnectivityResult.stdout.trim());
    } catch {
      return unavailable(
        "local-connectivity-failed",
        "local dual-rail route probe returned invalid data",
      );
    }
    if (!connectivityMatches(staticPlan.localConnectivity, localConnectivity)) {
      return unavailable(
        "local-connectivity-failed",
        "local routes are not direct on both matched rails or jumbo ping failed",
      );
    }

    const peerConnectivityResult = deps.probePeerConnectivity(
      peerSshBinding,
      staticPlan.peerConnectivity,
    );
    if (!commandSucceeded(peerConnectivityResult)) {
      return unavailable(
        "peer-connectivity-failed",
        "peer dual-rail route and jumbo-frame probe failed",
      );
    }
    let peerConnectivity: StationRailConnectivityProbe[];
    try {
      peerConnectivity = parseConnectivityProbe(peerConnectivityResult.stdout.trim());
    } catch {
      return unavailable(
        "peer-connectivity-failed",
        "peer dual-rail route probe returned invalid data",
      );
    }
    if (!connectivityMatches(staticPlan.peerConnectivity, peerConnectivity)) {
      return unavailable(
        "peer-connectivity-failed",
        "peer routes are not direct on both matched rails or jumbo ping failed",
      );
    }

    return {
      kind: "ready",
      plan: staticPlan.plan,
      peerModelSnapshot: staticPlan.peerModelSnapshot,
    };
  } catch {
    return unavailable("probe-error", "dual-Station capability probe failed closed");
  }
}
