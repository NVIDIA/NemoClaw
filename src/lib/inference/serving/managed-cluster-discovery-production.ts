// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type SpawnSyncOptionsWithStringEncoding, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import type { BuildIdentity } from "../../core/version.js";
import { getBuildIdentity } from "../../core/version.js";
import { assessHost } from "../../onboard/preflight.js";
import { createHostReadinessReport } from "../../readiness/host.js";
import { collectPlatformIdentity } from "../../readiness/platform-qualification.js";
import type { SystemReadinessReport } from "../../readiness/types.js";
import { managedVllmStateDir } from "../vllm-api-key.js";
import { buildLocalManagedVllmDockerEnv, buildVllmSshTransportEnv } from "../vllm-docker-env.js";
import type {
  ManagedClusterCommandResult,
  ManagedClusterConnectivityFailure,
  ManagedClusterConnectivityRequest,
  ManagedClusterDiscoveryDeps,
  ManagedClusterHostObservation,
  ManagedClusterPinnedPeerTransport,
  ManagedClusterReadOnlyHostTransport,
} from "./managed-cluster-discovery.js";
import { MANAGED_CLUSTER_MANAGED_SERVING_STATE_FILE } from "./managed-cluster-runtime-receipt-path.js";
import {
  clearManagedVllmSshBinding,
  encodeManagedVllmSshBindingHandoff,
  managedVllmKnownHostsDigest,
  managedVllmSshBindingDirectory,
  type QualifiedManagedVllmSshIdentity,
  strictManagedVllmSshTransportArgs,
  writeManagedVllmSshBinding,
} from "./managed-cluster-ssh-binding.js";

const COMMAND_TIMEOUT_MS = 20_000;
const MAX_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_LOCAL_FILE_BYTES = 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 4096;
const SAFE_TARGET_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const SAFE_USERNAME_PATTERN = /^[A-Za-z_][A-Za-z0-9._-]*$/;
const SAFE_DEVICE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const MAC_PATTERN = /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_SSH_KEY_TYPE_PATTERN = /^(?:ssh-|ecdsa-|sk-)[A-Za-z0-9@._+-]+$/;
const SAFE_SSH_KEY_DATA_PATTERN = /^[A-Za-z0-9+/]+={0,3}$/;

export type ManagedClusterSpawnSync = (
  file: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => {
  readonly status: number | null;
  readonly stdout: string | null;
  readonly stderr: string | null;
  readonly error?: Error;
};

export type ManagedClusterHostParser = (value: unknown) => ManagedClusterHostObservation;

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validatePeerTarget(raw: string): string {
  if (
    raw.length === 0 ||
    raw.length > 286 ||
    raw !== raw.trim() ||
    /[/,:;`'"\\$(){}[\]<>|&!?*\s\u0000-\u001f\u007f]/.test(raw)
  ) {
    throw new Error("DGX Spark SSH peer target is invalid");
  }
  const parts = raw.split("@");
  const username = parts.length === 2 ? parts[0] : "";
  const hostname = parts.at(-1) ?? "";
  if (
    parts.length > 2 ||
    (parts.length === 2 && !username) ||
    (username !== "" && !SAFE_USERNAME_PATTERN.test(username)) ||
    (net.isIP(hostname) !== 4 && !SAFE_TARGET_PATTERN.test(hostname))
  ) {
    throw new Error("DGX Spark SSH peer target is invalid");
  }
  return raw;
}

const REMOTE_ARGV_EXECUTOR = String.raw`
import base64
import json
import subprocess
import sys

try:
    encoded = sys.argv[1]
    padding = "=" * ((4 - len(encoded) % 4) % 4)
    request = json.loads(base64.urlsafe_b64decode(encoded + padding))
    argv = request["argv"]
    if (
        not isinstance(argv, list)
        or not argv
        or len(argv) > 128
        or any(not isinstance(value, str) or not value or "\x00" in value for value in argv)
        or sum(len(value) for value in argv) > 262144
    ):
        raise ValueError("invalid argv")
    result = subprocess.run(
        argv,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=15,
        check=False,
        shell=False,
    )
    sys.stdout.buffer.write(result.stdout)
    sys.stderr.buffer.write(result.stderr)
    raise SystemExit(result.returncode)
except subprocess.TimeoutExpired:
    raise SystemExit(124)
except Exception:
    raise SystemExit(125)
`;

const READ_FILE_SCRIPT = String.raw`
import os
import sys

path = sys.argv[1]
fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
try:
    data = os.read(fd, 1024 * 1024 + 1)
    if len(data) > 1024 * 1024:
        raise SystemExit(2)
    sys.stdout.buffer.write(data)
finally:
    os.close(fd)
`;

const READDIR_SCRIPT = String.raw`
import json
import os
import sys

entries = sorted(os.listdir(sys.argv[1]))
if len(entries) > 4096:
    raise SystemExit(2)
print(json.dumps(entries, separators=(",", ":")))
`;

const HOST_PROBE_SCRIPT = String.raw`
import csv
import ipaddress
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import socket
import subprocess

DOCKER_ENV_NAMES = (
    "DOCKER_API_VERSION",
    "DOCKER_CERT_PATH",
    "DOCKER_CONFIG",
    "DOCKER_CONTEXT",
    "DOCKER_HOST",
    "DOCKER_TLS",
    "DOCKER_TLS_VERIFY",
)

def run(argv, timeout=10):
    try:
        env = None
        if argv and argv[0] == "docker":
            env = os.environ.copy()
            for name in DOCKER_ENV_NAMES:
                env.pop(name, None)
            env["DOCKER_CONTEXT"] = "default"
        result = subprocess.run(
            argv,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout,
            check=False,
            shell=False,
            env=env,
        )
        return result.returncode, result.stdout
    except Exception:
        return 125, ""

def read_text(path, default=""):
    try:
        return Path(path).read_text(encoding="utf-8", errors="replace")[:4096].strip()
    except Exception:
        return default

def read_int(path, default=-1):
    try:
        return int(read_text(path))
    except Exception:
        return default

def ipv4_addresses(netdev):
    code, output = run(["ip", "-j", "address", "show", "dev", netdev])
    if code != 0:
        return []
    try:
        payload = json.loads(output)
        result = []
        for interface in payload:
            for address in interface.get("addr_info", []):
                if address.get("family") == "inet":
                    result.append({
                        "address": address["local"],
                        "prefixLength": int(address["prefixlen"]),
                    })
        return result
    except Exception:
        return []

def gid_ipv4(value):
    try:
        mapped = ipaddress.IPv6Address(value).ipv4_mapped
        return str(mapped) if mapped is not None else ""
    except Exception:
        return ""

def pci_name(address):
    if not address:
        return ""
    code, output = run(["lspci", "-D", "-s", address])
    return output.strip()[:512] if code == 0 else ""

def physical_adapter_id(pci_address):
    if re.fullmatch(r"[0-9a-fA-F]{4}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}\.[0-7]", pci_address):
        return "pci-" + pci_address.rsplit(".", 1)[0].lower()
    return "unknown"

def collect_rails():
    rails = []
    root = Path("/sys/class/infiniband")
    if not root.is_dir():
        return rails
    for hca in sorted(root.iterdir(), key=lambda item: item.name)[:32]:
        ports = hca / "ports"
        if not ports.is_dir():
            continue
        for port_path in sorted(ports.iterdir(), key=lambda item: item.name)[:16]:
            try:
                port = int(port_path.name)
            except Exception:
                continue
            ndevs = port_path / "gid_attrs" / "ndevs"
            types = port_path / "gid_attrs" / "types"
            gids = port_path / "gids"
            if not ndevs.is_dir() or not types.is_dir() or not gids.is_dir():
                continue
            by_netdev = {}
            for ndev_file in sorted(ndevs.iterdir(), key=lambda item: item.name)[:4096]:
                try:
                    index = int(ndev_file.name)
                except Exception:
                    continue
                netdev = read_text(ndev_file)
                gid_type = read_text(types / ndev_file.name)
                gid = read_text(gids / ndev_file.name).lower()
                if not netdev or "roce v2" not in gid_type.lower():
                    continue
                address = gid_ipv4(gid)
                if not address:
                    continue
                by_netdev.setdefault(netdev, []).append({
                    "index": index,
                    "value": gid,
                    "ipv4Address": address,
                })
            for netdev, roce_gids in sorted(by_netdev.items()):
                net_root = Path("/sys/class/net") / netdev
                if not net_root.is_dir():
                    continue
                try:
                    pci_address = (net_root / "device").resolve(strict=True).name
                except Exception:
                    pci_address = ""
                rails.append({
                    "physicalPortId": physical_adapter_id(pci_address),
                    "netdev": netdev,
                    "hcaDevice": hca.name,
                    "hcaPort": port,
                    "macAddress": read_text(net_root / "address").lower(),
                    "pciAddress": pci_address,
                    "pciName": pci_name(pci_address),
                    "state": read_text(port_path / "state"),
                    "operState": read_text(net_root / "operstate"),
                    "carrier": read_text(net_root / "carrier") == "1",
                    "linkLayer": read_text(port_path / "link_layer"),
                    "speedMbps": read_int(net_root / "speed"),
                    "mtu": read_int(net_root / "mtu"),
                    "ipv4Addresses": ipv4_addresses(netdev),
                    "roceV2Ipv4Gids": sorted(roce_gids, key=lambda gid: (gid["index"], gid["value"])),
                })
    return rails

def collect_gpus():
    code, output = run([
        "nvidia-smi",
        "--query-gpu=index,name,uuid",
        "--format=csv,noheader,nounits",
    ])
    if code != 0:
        return []
    result = []
    try:
        for row in csv.reader(output.splitlines()):
            if len(row) != 3:
                return []
            result.append({"index": int(row[0].strip()), "name": row[1].strip(), "uuid": row[2].strip()})
    except Exception:
        return []
    return result

def listening_ports():
    ports = set()
    complete = True
    for source in ("/proc/net/tcp", "/proc/net/tcp6"):
        try:
            lines = Path(source).read_text(encoding="ascii").splitlines()[1:]
            for line in lines:
                fields = line.split()
                if len(fields) >= 4 and fields[3] == "0A":
                    ports.add(int(fields[1].split(":")[1], 16))
        except Exception:
            complete = False
    return sorted(ports), complete

def containers():
    code, output = run(["docker", "ps", "-aq", "--no-trunc"])
    if code != 0:
        return [], False
    ids = [line.strip() for line in output.splitlines() if line.strip()]
    if len(ids) > 256:
        return [], False
    if not ids:
        return [], True
    code, output = run(["docker", "inspect", *ids])
    if code != 0:
        return [], False
    try:
        inspected = json.loads(output)
        result = []
        for item in inspected:
            state = item.get("State") or {}
            health = state.get("Health") or {}
            container_id = str(item.get("Id", ""))
            name = str(item.get("Name", "")).lstrip("/")
            image = str((item.get("Config") or {}).get("Image", ""))
            labels = (item.get("Config") or {}).get("Labels") or {}
            if (
                not re.fullmatch(r"[a-f0-9]{64}", container_id)
                or not name or len(name) > 256
                or not image or len(image) > 1024
                or not isinstance(labels, dict) or len(labels) > 128
                or any(
                    not isinstance(key, str) or not key or len(key) > 256
                    or not isinstance(value, str) or len(value) > 4096
                    for key, value in labels.items()
                )
            ):
                return [], False
            result.append({
                "id": container_id,
                "name": name,
                "image": image,
                "running": bool(state.get("Running", False)),
                "healthy": health.get("Status") == "healthy",
                "labels": labels,
            })
        return result, len(result) == len(ids)
    except Exception:
        return [], False

def nearest_capacity(requested):
    try:
        candidate = Path(requested).expanduser()
        while not candidate.exists() and candidate != candidate.parent:
            candidate = candidate.parent
        if not candidate.exists():
            raise RuntimeError("no existing parent")
        resolved = candidate.resolve(strict=True)
        stats = os.stat(resolved)
        fs_stats = os.statvfs(resolved)
        return {
            "requestedPath": str(Path(requested).expanduser()),
            "probePath": str(resolved),
            "filesystemId": str(stats.st_dev),
            "availableBytes": int(fs_stats.f_bavail * fs_stats.f_frsize),
            "availableInodes": int(fs_stats.f_favail),
            "ownerUid": int(stats.st_uid),
            "ownerGid": int(stats.st_gid),
            "isDirectory": resolved.is_dir(),
            "writableByUser": os.access(resolved, os.W_OK | os.X_OK),
        }
    except Exception:
        return {
            "requestedPath": str(Path(requested).expanduser()),
            "probePath": None,
            "filesystemId": None,
            "availableBytes": None,
            "availableInodes": None,
            "ownerUid": None,
            "ownerGid": None,
            "isDirectory": False,
            "writableByUser": False,
        }

uid = os.getuid()
gid = os.getgid()
account = pwd.getpwuid(uid)
home = Path(account.pw_dir).resolve()
hf_home = home / ".cache" / "huggingface"
hf_capacity = nearest_capacity(hf_home)

docker_root = None
docker_info_code, docker_info_output = run(["docker", "info", "--format", "{{json .}}"])
if docker_info_code == 0:
    try:
        docker_root = json.loads(docker_info_output).get("DockerRootDir")
    except Exception:
        docker_root = None
docker_capacity = nearest_capacity(docker_root or "/var/lib/docker")
observed_containers, containers_complete = containers()
ports, ports_complete = listening_ports()

earlyoom_units = [
    Path("/etc/systemd/system/earlyoom.service"),
    Path("/lib/systemd/system/earlyoom.service"),
    Path("/usr/lib/systemd/system/earlyoom.service"),
]
earlyoom_service_installed = any(unit.exists() for unit in earlyoom_units)
earlyoom_installed = bool(shutil.which("earlyoom")) or earlyoom_service_installed
earlyoom_active = "unknown" if earlyoom_installed else "inactive"
earlyoom_enabled = "disabled"
if earlyoom_installed:
    service_active = False if not earlyoom_service_installed else None
    process_active = None
    if earlyoom_service_installed and shutil.which("systemctl"):
        active_code, active_output = run(["systemctl", "is-active", "earlyoom.service"])
        enabled_code, enabled_output = run(["systemctl", "is-enabled", "earlyoom.service"])
        service_active = True if active_code == 0 and active_output.strip() == "active" else False if active_output.strip() in ("inactive", "failed") else None
        earlyoom_enabled = "enabled" if enabled_code == 0 and enabled_output.strip() == "enabled" else "disabled" if enabled_output.strip() in ("disabled", "masked", "static") else "unknown"
    if shutil.which("pgrep"):
        process_code, process_output = run(["pgrep", "-x", "earlyoom"])
        process_active = True if process_code == 0 and process_output.strip() else False if process_code == 1 else None
    earlyoom_active = "active" if service_active is True or process_active is True else "inactive" if service_active is False and process_active is False else "unknown"

result = {
    "schemaVersion": 1,
    "hostname": socket.gethostname(),
    "nodeId": read_text("/etc/machine-id"),
    "productName": read_text("/sys/class/dmi/id/product_name"),
    "architecture": os.uname().machine,
    "home": str(home),
    "username": account.pw_name,
    "uid": uid,
    "gid": gid,
    "gpus": collect_gpus(),
    "rails": collect_rails(),
    "earlyoom": {
        "installed": earlyoom_installed,
        "active": earlyoom_active,
        "enabled": earlyoom_enabled,
    },
    "runtimeInspectionComplete": containers_complete and ports_complete,
    "runtimeSnapshot": {"containers": observed_containers, "listeningPorts": ports},
    "storage": {
        "huggingFace": {
            **hf_capacity,
            "cacheRoot": str(hf_home),
        },
        "docker": {
            **docker_capacity,
            "dockerRootDir": docker_root,
        },
    },
}
print(json.dumps(result, separators=(",", ":"), sort_keys=True))
`;

function defaultSpawnSync(
  file: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
): ReturnType<ManagedClusterSpawnSync> {
  const result = spawnSync(file, [...args], options);
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.error ? { error: result.error } : {}),
  };
}

function validateArgv(argv: readonly string[]): void {
  if (
    argv.length === 0 ||
    argv.length > 128 ||
    argv.some((value) => !value || value.includes("\0")) ||
    argv.reduce((total, value) => total + Buffer.byteLength(value, "utf8"), 0) > 262_144
  ) {
    throw new Error("DGX Spark probe argv is invalid");
  }
}

function runCommand(
  spawn: ManagedClusterSpawnSync,
  file: string,
  args: readonly string[],
  input = "",
  env: Readonly<Record<string, string>> = buildVllmSshTransportEnv({ LC_ALL: "C", LANG: "C" }),
): ManagedClusterCommandResult {
  const result = spawn(file, args, {
    encoding: "utf8",
    input,
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    killSignal: "SIGKILL",
    windowsHide: true,
    env,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error ? { error: result.error.message } : {}),
  };
}

function commandSucceeded(result: ManagedClusterCommandResult, requireOutput = false): boolean {
  return (
    result.status === 0 &&
    result.error === undefined &&
    (!requireOutput || result.stdout.trim().length > 0)
  );
}

function readBoundedLocalFile(filePath: string): string {
  const flags =
    fs.constants.O_RDONLY |
    (typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0);
  const descriptor = fs.openSync(filePath, flags);
  try {
    const metadata = fs.fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size > MAX_LOCAL_FILE_BYTES) {
      throw new Error(`DGX Spark probe file ${filePath} is invalid`);
    }
    const contents = fs.readFileSync(descriptor);
    if (contents.length > MAX_LOCAL_FILE_BYTES) {
      throw new Error(`DGX Spark probe file ${filePath} is too large`);
    }
    return contents.toString("utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

function readBoundedDirectory(directory: string): string[] {
  const entries = fs.readdirSync(directory);
  if (entries.length > MAX_DIRECTORY_ENTRIES) {
    throw new Error(`DGX Spark probe directory ${directory} is too large`);
  }
  return entries.sort(compareStrings);
}

function createLocalTransport(spawn: ManagedClusterSpawnSync): ManagedClusterReadOnlyHostTransport {
  return {
    execute(argv) {
      validateArgv(argv);
      return runCommand(
        spawn,
        argv[0]!,
        argv.slice(1),
        "",
        buildLocalManagedVllmDockerEnv({ LC_ALL: "C", LANG: "C" }),
      );
    },
    readFile: readBoundedLocalFile,
    readdir: readBoundedDirectory,
  };
}

function parseJsonCommandResult(result: ManagedClusterCommandResult, label: string): unknown {
  if (!commandSucceeded(result, true)) throw new Error(`${label} failed`);
  if (Buffer.byteLength(result.stdout, "utf8") > MAX_COMMAND_OUTPUT_BYTES) {
    throw new Error(`${label} output is too large`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

function probeHostWithTransport(
  transport: ManagedClusterReadOnlyHostTransport,
  parseHost: ManagedClusterHostParser,
): ManagedClusterHostObservation {
  const result = transport.execute(["python3", "-c", HOST_PROBE_SCRIPT]);
  return parseHost(parseJsonCommandResult(result, "DGX Spark host probe"));
}

type SshConfiguration = ReadonlyMap<string, readonly string[]>;

function parseSshConfiguration(stdout: string): SshConfiguration {
  const values = new Map<string, string[]>();
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const separator = line.search(/\s/);
    if (separator <= 0) throw new Error("ssh -G returned malformed effective configuration");
    const key = line.slice(0, separator).toLowerCase();
    const value = line.slice(separator).trim();
    values.set(key, [...(values.get(key) ?? []), value]);
  }
  return values;
}

function oneSshConfigurationValue(values: SshConfiguration, key: string): string {
  const entries = values.get(key) ?? [];
  if (entries.length !== 1 || !entries[0]) {
    throw new Error(`Effective SSH configuration must define exactly one ${key}`);
  }
  return entries[0];
}

function assertStrictSshConfiguration(values: SshConfiguration): void {
  const exactly = (key: string, allowed: readonly string[]): boolean => {
    const observed = (values.get(key) ?? []).map((value) => value.toLowerCase());
    return observed.length === 1 && allowed.includes(observed[0]!);
  };
  const absentOrNone = (key: string): boolean => {
    const observed = (values.get(key) ?? []).map((value) => value.toLowerCase());
    return observed.length === 0 || (observed.length === 1 && observed[0] === "none");
  };
  const preferred = (values.get("preferredauthentications") ?? []).flatMap((value) =>
    value.toLowerCase().split(",").filter(Boolean),
  );
  const sendEnv = (values.get("sendenv") ?? []).map((value) => value.toLowerCase());
  if (
    !exactly("batchmode", ["yes"]) ||
    !exactly("stricthostkeychecking", ["yes", "true"]) ||
    !exactly("passwordauthentication", ["no", "false"]) ||
    !exactly("kbdinteractiveauthentication", ["no", "false"]) ||
    !exactly("numberofpasswordprompts", ["0"]) ||
    preferred.length !== 1 ||
    preferred[0] !== "publickey" ||
    !exactly("permitlocalcommand", ["no"]) ||
    !exactly("forwardagent", ["no"]) ||
    !exactly("forwardx11", ["no"]) ||
    !exactly("forwardx11trusted", ["no"]) ||
    !exactly("tunnel", ["false", "no"]) ||
    !exactly("updatehostkeys", ["false", "no"]) ||
    !exactly("controlmaster", ["false", "no"]) ||
    !absentOrNone("controlpath") ||
    !absentOrNone("remotecommand") ||
    !absentOrNone("proxycommand") ||
    !absentOrNone("proxyjump") ||
    !absentOrNone("localcommand") ||
    !absentOrNone("knownhostscommand") ||
    values.has("localforward") ||
    values.has("remoteforward") ||
    values.has("dynamicforward") ||
    values.has("setenv") ||
    !sendEnv.every((value) => value === "lang" || value === "lc_*")
  ) {
    throw new Error("Effective SSH configuration is unsafe for DGX Spark discovery");
  }
}

function canonicalSshHost(value: string): boolean {
  return net.isIP(value) === 4 || SAFE_TARGET_PATTERN.test(value);
}

function trustedKnownHostLines(
  spawn: ManagedClusterSpawnSync,
  lookupHost: string,
  files: readonly string[],
): string[] | null {
  const lines = new Set<string>();
  let positive = false;
  for (const file of files) {
    if (!path.isAbsolute(file) || path.normalize(file) !== file) continue;
    let metadata: fs.Stats;
    try {
      metadata = fs.lstatSync(file);
    } catch {
      continue;
    }
    const uid = process.getuid?.();
    if (
      uid === undefined ||
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      (metadata.uid !== uid && metadata.uid !== 0) ||
      (metadata.mode & 0o022) !== 0
    ) {
      continue;
    }
    const result = runCommand(spawn, "ssh-keygen", ["-F", lookupHost, "-f", file]);
    if (!commandSucceeded(result, true)) continue;
    for (const rawLine of result.stdout.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#") || /[\u0000\r\n]/.test(line)) continue;
      const fields = line.split(/\s+/);
      const marker = fields[0]?.startsWith("@") ? fields.shift() : "";
      if ((marker !== "" && marker !== "@revoked") || fields.length < 3) continue;
      const keyType = fields[1] ?? "";
      const keyData = fields[2] ?? "";
      if (!SAFE_SSH_KEY_TYPE_PATTERN.test(keyType) || !SAFE_SSH_KEY_DATA_PATTERN.test(keyData)) {
        continue;
      }
      lines.add(line);
      if (marker === "") positive = true;
    }
  }
  if (!positive || lines.size === 0) return null;
  const result = [...lines].sort(compareStrings);
  managedVllmKnownHostsDigest(`${result.join("\n")}\n`);
  return result;
}

function inspectPretrustedTarget(
  spawn: ManagedClusterSpawnSync,
  rawTarget: string,
): QualifiedManagedVllmSshIdentity | null {
  const target = validatePeerTarget(rawTarget);
  const result = runCommand(spawn, "ssh", [
    "-G",
    ...strictManagedVllmSshTransportArgs(),
    "--",
    target,
  ]);
  if (!commandSucceeded(result, true)) return null;
  const config = parseSshConfiguration(result.stdout);
  assertStrictSshConfiguration(config);
  const resolvedHost = oneSshConfigurationValue(config, "hostname");
  const sshUser = oneSshConfigurationValue(config, "user");
  const port = Number(oneSshConfigurationValue(config, "port"));
  if (!canonicalSshHost(resolvedHost) || !SAFE_USERNAME_PATTERN.test(sshUser)) {
    throw new Error("Effective SSH endpoint is invalid");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Effective SSH port is invalid");
  }
  const requestedHost = target.slice(target.lastIndexOf("@") + 1);
  if (net.isIP(requestedHost) === 4 && resolvedHost !== requestedHost) {
    throw new Error("Automatic rail target was remapped by SSH configuration");
  }
  const alias = config.get("hostkeyalias")?.[0];
  const baseLookupHost = alias && alias.toLowerCase() !== "none" ? alias : resolvedHost;
  if (!canonicalSshHost(baseLookupHost)) throw new Error("Effective SSH host-key alias is invalid");
  const lookupHost = port === 22 ? baseLookupHost : `[${baseLookupHost}]:${String(port)}`;
  const files = [
    ...(config.get("userknownhostsfile") ?? []),
    ...(config.get("globalknownhostsfile") ?? []),
  ].flatMap((entry) => entry.split(/\s+/).filter((value) => value && value !== "none"));
  const knownHostsLines = trustedKnownHostLines(spawn, lookupHost, files);
  if (!knownHostsLines) return null;
  return {
    requestedTarget: target,
    sshTarget: target,
    resolvedHost,
    sshUser,
    port,
    lookupHost,
    hostKeyDigest: managedVllmKnownHostsDigest(`${knownHostsLines.join("\n")}\n`),
    knownHostsLines,
  };
}

function assertPinnedIdentity(identity: QualifiedManagedVllmSshIdentity): void {
  if (
    validatePeerTarget(identity.sshTarget) !== identity.sshTarget ||
    identity.requestedTarget !== identity.sshTarget ||
    !canonicalSshHost(identity.resolvedHost) ||
    !SAFE_USERNAME_PATTERN.test(identity.sshUser) ||
    !Number.isInteger(identity.port) ||
    identity.port < 1 ||
    identity.port > 65_535 ||
    !SHA256_PATTERN.test(identity.hostKeyDigest)
  ) {
    throw new Error("Qualified DGX Spark SSH identity is invalid");
  }
  const expectedLookup =
    identity.port === 22
      ? identity.resolvedHost
      : `[${identity.resolvedHost}]:${String(identity.port)}`;
  if (identity.lookupHost !== expectedLookup) {
    throw new Error("Qualified DGX Spark SSH host-key lookup is invalid");
  }
  const contents = `${identity.knownHostsLines.join("\n")}\n`;
  if (
    identity.knownHostsLines.length === 0 ||
    identity.knownHostsLines.some(
      (line) => !line || line !== line.trim() || /[\u0000\r\n]/.test(line),
    ) ||
    managedVllmKnownHostsDigest(contents) !== identity.hostKeyDigest
  ) {
    throw new Error("Qualified DGX Spark SSH host-key evidence is invalid");
  }
}

function assertTemporaryPinnedFiles(
  directory: string,
  knownHostsFile: string,
  expectedDigest: string,
): void {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("DGX Spark discovery requires a POSIX user identity");
  const directoryMetadata = fs.lstatSync(directory);
  const fileMetadata = fs.lstatSync(knownHostsFile);
  if (
    directoryMetadata.isSymbolicLink() ||
    !directoryMetadata.isDirectory() ||
    directoryMetadata.uid !== uid ||
    (directoryMetadata.mode & 0o777) !== 0o700 ||
    fileMetadata.isSymbolicLink() ||
    !fileMetadata.isFile() ||
    fileMetadata.uid !== uid ||
    (fileMetadata.mode & 0o777) !== 0o600 ||
    fs.readdirSync(directory).some((entry) => entry !== path.basename(knownHostsFile)) ||
    managedVllmKnownHostsDigest(readBoundedLocalFile(knownHostsFile)) !== expectedDigest
  ) {
    throw new Error("Temporary DGX Spark SSH host-key pin is unsafe");
  }
}

function openPinnedPeerTransport(
  spawn: ManagedClusterSpawnSync,
  identity: QualifiedManagedVllmSshIdentity,
): ManagedClusterPinnedPeerTransport {
  assertPinnedIdentity(identity);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-managed-cluster-"));
  fs.chmodSync(directory, 0o700);
  const knownHostsFile = path.join(directory, "known_hosts");
  try {
    fs.writeFileSync(knownHostsFile, `${identity.knownHostsLines.join("\n")}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    fs.chmodSync(knownHostsFile, 0o600);
    assertTemporaryPinnedFiles(directory, knownHostsFile, identity.hostKeyDigest);
  } catch (error) {
    try {
      if (fs.existsSync(knownHostsFile)) fs.unlinkSync(knownHostsFile);
      fs.rmdirSync(directory);
    } catch {
      // The exact owner-only temporary path is retained for inspection if safe cleanup fails.
    }
    throw error;
  }

  const execute = (argv: readonly string[]): ManagedClusterCommandResult => {
    validateArgv(argv);
    assertTemporaryPinnedFiles(directory, knownHostsFile, identity.hostKeyDigest);
    const request = Buffer.from(JSON.stringify({ argv }), "utf8").toString("base64url");
    return runCommand(
      spawn,
      "ssh",
      [
        "-F",
        "/dev/null",
        ...strictManagedVllmSshTransportArgs(),
        "-o",
        `UserKnownHostsFile=${knownHostsFile}`,
        "-o",
        "GlobalKnownHostsFile=/dev/null",
        "-o",
        `HostKeyAlias=${identity.lookupHost}`,
        "-o",
        `Hostname=${identity.resolvedHost}`,
        "-o",
        `User=${identity.sshUser}`,
        "-o",
        `Port=${String(identity.port)}`,
        "--",
        identity.sshTarget,
        "python3",
        "-",
        request,
      ],
      REMOTE_ARGV_EXECUTOR,
    );
  };
  const transport: ManagedClusterReadOnlyHostTransport = {
    execute,
    readFile(filePath) {
      if (!path.posix.isAbsolute(filePath) || path.posix.normalize(filePath) !== filePath) {
        throw new Error("Remote DGX Spark probe file path is invalid");
      }
      const result = execute(["python3", "-c", READ_FILE_SCRIPT, filePath]);
      if (!commandSucceeded(result)) throw new Error(`Remote file ${filePath} could not be read`);
      if (Buffer.byteLength(result.stdout, "utf8") > MAX_LOCAL_FILE_BYTES) {
        throw new Error(`Remote file ${filePath} is too large`);
      }
      return result.stdout;
    },
    readdir(directoryPath) {
      if (
        !path.posix.isAbsolute(directoryPath) ||
        path.posix.normalize(directoryPath) !== directoryPath
      ) {
        throw new Error("Remote DGX Spark probe directory path is invalid");
      }
      const result = execute(["python3", "-c", READDIR_SCRIPT, directoryPath]);
      const value = parseJsonCommandResult(result, `Remote directory ${directoryPath}`);
      if (
        !Array.isArray(value) ||
        value.length > MAX_DIRECTORY_ENTRIES ||
        value.some(
          (entry) =>
            typeof entry !== "string" ||
            !entry ||
            entry === "." ||
            entry === ".." ||
            entry.includes("/") ||
            entry.includes("\0"),
        )
      ) {
        throw new Error(`Remote directory ${directoryPath} returned invalid entries`);
      }
      return (value as string[]).sort(compareStrings);
    },
  };
  return {
    transport,
    close() {
      assertTemporaryPinnedFiles(directory, knownHostsFile, identity.hostKeyDigest);
      fs.unlinkSync(knownHostsFile);
      fs.rmdirSync(directory);
    },
  };
}

function isRecordArray(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.every(isRecord);
}

function connectivityCheck(
  transport: ManagedClusterReadOnlyHostTransport,
  request: ManagedClusterConnectivityRequest,
): ManagedClusterConnectivityFailure | null {
  const failed = (check: "route" | "jumbo" | "neighbor"): ManagedClusterConnectivityFailure => ({
    check,
    netdev: request.netdev,
  });
  const routeResult = transport.execute([
    "ip",
    "-j",
    "route",
    "get",
    request.peerAddress,
    "from",
    request.sourceAddress,
    "oif",
    request.netdev,
  ]);
  let routeValue: unknown;
  try {
    routeValue = parseJsonCommandResult(routeResult, "DGX Spark direct route probe");
  } catch {
    return failed("route");
  }
  if (!isRecordArray(routeValue) || routeValue.length !== 1) return failed("route");
  const route = routeValue[0]!;
  const routeSource = route.prefsrc ?? route.src;
  if (
    route.dev !== request.netdev ||
    routeSource !== request.sourceAddress ||
    route.gateway !== undefined ||
    (route.scope !== undefined && String(route.scope).toLowerCase() !== "link")
  ) {
    return failed("route");
  }
  const ping = transport.execute([
    "ping",
    "-c",
    "1",
    "-W",
    "2",
    "-M",
    "do",
    "-s",
    "8972",
    "-I",
    request.sourceAddress,
    request.peerAddress,
  ]);
  if (!commandSucceeded(ping)) return failed("jumbo");
  const neighborResult = transport.execute([
    "ip",
    "-j",
    "neigh",
    "show",
    "to",
    request.peerAddress,
    "dev",
    request.netdev,
  ]);
  let neighborValue: unknown;
  try {
    neighborValue = parseJsonCommandResult(neighborResult, "DGX Spark neighbor probe");
  } catch {
    return failed("neighbor");
  }
  if (!isRecordArray(neighborValue) || neighborValue.length !== 1) return failed("neighbor");
  const neighbor = neighborValue[0]!;
  const states = Array.isArray(neighbor.state) ? neighbor.state : [neighbor.state];
  // `ip` applies the `dev` filter itself and then omits `dev` from the JSON, so an
  // absent `dev` already means the entry belongs to the requested netdev.
  const matched =
    String(neighbor.dst ?? "") === request.peerAddress &&
    String(neighbor.dev ?? request.netdev) === request.netdev &&
    String(neighbor.lladdr ?? "").toLowerCase() === request.expectedPeerMac &&
    states.length > 0 &&
    states.every(
      (state) =>
        typeof state === "string" &&
        /^(?:REACHABLE|STALE|DELAY|PROBE|PERMANENT|NOARP)$/i.test(state),
    );
  return matched ? null : failed("neighbor");
}

function probeConnectivity(
  transport: ManagedClusterReadOnlyHostTransport,
  requests: readonly ManagedClusterConnectivityRequest[],
): ManagedClusterConnectivityFailure | null {
  if (
    requests.length !== 2 ||
    new Set(requests.map(({ netdev }) => netdev)).size !== 2 ||
    requests.some(
      ({ netdev, sourceAddress, peerAddress, expectedPeerMac }) =>
        !SAFE_DEVICE_PATTERN.test(netdev) ||
        net.isIP(sourceAddress) !== 4 ||
        net.isIP(peerAddress) !== 4 ||
        !MAC_PATTERN.test(expectedPeerMac),
    )
  ) {
    return { check: "rails" };
  }
  for (const request of requests) {
    const failure = connectivityCheck(transport, request);
    if (failure) return failure;
  }
  return null;
}

function createCanonicalReadiness(
  host: ManagedClusterHostObservation,
  transport: ManagedClusterReadOnlyHostTransport,
  buildIdentity: BuildIdentity,
  now: Date,
): SystemReadinessReport {
  const runCaptureImpl = (
    argv: readonly string[],
    options?: { readonly ignoreError?: boolean },
  ): string => {
    const result = transport.execute(argv);
    if (!commandSucceeded(result) && options?.ignoreError !== true) {
      throw new Error(`Readiness command ${argv[0] ?? "unknown"} failed`);
    }
    return commandSucceeded(result) ? result.stdout : "";
  };
  const releaseResult = transport.execute(["uname", "-r"]);
  if (!commandSucceeded(releaseResult, true)) {
    throw new Error("DGX Spark kernel release could not be observed");
  }
  let procVersion = "";
  try {
    procVersion = transport.readFile("/proc/version");
  } catch {
    // assessHost treats an unavailable proc version as absent WSL evidence.
  }
  const assessment = assessHost({
    platform: "linux",
    env: {},
    release: releaseResult.stdout.trim(),
    procVersion,
    readFileImpl: (filePath) => transport.readFile(filePath),
    readdirImpl: (directory) => transport.readdir(directory),
    runCaptureImpl,
    gpuProbeImpl: () => host.gpus.length === 1,
  });
  const platformIdentity = collectPlatformIdentity({
    readFile: (filePath) => transport.readFile(filePath),
    readdir: (directory) => transport.readdir(directory),
  });
  return createHostReadinessReport(
    {
      nemoclawVersion: buildIdentity.nemoclawVersion,
      sourceRevision: buildIdentity.sourceRevision,
      now: () => now,
    },
    {
      now: () => now,
      architecture: "arm64",
      assess: () => assessment,
      detectHostGpuPlatform: () => "spark",
      collectPlatformIdentity: () => platformIdentity,
    },
  );
}

function claimBinding(statePath: string): boolean {
  const bindingDirectory = managedVllmSshBindingDirectory(statePath);
  const parent = path.dirname(bindingDirectory);
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("DGX Spark binding claim requires a POSIX user identity");
  const directoryFlags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
  const parentDescriptor = fs.openSync(parent, directoryFlags);
  try {
    const parentMetadata = fs.fstatSync(parentDescriptor);
    if (
      !parentMetadata.isDirectory() ||
      parentMetadata.uid !== uid ||
      (parentMetadata.mode & 0o777) !== 0o700
    ) {
      throw new Error("DGX Spark binding parent is unsafe");
    }
    try {
      fs.mkdirSync(bindingDirectory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }

    const bindingDescriptor = fs.openSync(bindingDirectory, directoryFlags);
    try {
      const bindingMetadata = fs.fstatSync(bindingDescriptor);
      if (!bindingMetadata.isDirectory() || bindingMetadata.uid !== uid) {
        throw new Error("DGX Spark binding claim is unsafe");
      }
      fs.fchmodSync(bindingDescriptor, 0o700);
      fs.fsyncSync(bindingDescriptor);
    } finally {
      fs.closeSync(bindingDescriptor);
    }

    fs.fsyncSync(parentDescriptor);
    return true;
  } finally {
    fs.closeSync(parentDescriptor);
  }
}

/**
 * Construct the production discovery seams. The optional spawn adapter exists
 * only so strict SSH argv behavior can be tested without network or host mutation.
 */
export function createProductionManagedClusterDiscoveryDeps(
  parseHost: ManagedClusterHostParser,
  spawn: ManagedClusterSpawnSync = defaultSpawnSync,
): ManagedClusterDiscoveryDeps {
  return {
    now: () => new Date(),
    currentUid: () => process.getuid?.() ?? null,
    getBuildIdentity,
    localTransport: () => createLocalTransport(spawn),
    probeHost: (transport) => probeHostWithTransport(transport, parseHost),
    inspectPretrustedTarget: (target) => inspectPretrustedTarget(spawn, target),
    openPinnedPeerTransport: (identity) => openPinnedPeerTransport(spawn, identity),
    createReadiness: createCanonicalReadiness,
    probeConnectivity,
    claimBinding,
    writeBinding: writeManagedVllmSshBinding,
    clearBinding: clearManagedVllmSshBinding,
    encodeBinding: encodeManagedVllmSshBindingHandoff,
    resolveBindingStatePath: (nodeId) =>
      path.join(managedVllmStateDir(), `${MANAGED_CLUSTER_MANAGED_SERVING_STATE_FILE}.${nodeId}`),
  };
}
