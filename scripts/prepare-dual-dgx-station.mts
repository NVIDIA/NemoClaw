#!/usr/bin/env -S node --no-warnings --experimental-strip-types
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  clearDualStationSshBinding,
  encodeDualStationSshBindingHandoff,
  stationKnownHostsDigest,
  writeDualStationSshBinding,
} from "../src/lib/inference/vllm-station-ssh-binding.ts";
import {
  type DualStationPreparationDeps,
  type DualStationResumeState,
  type PretrustedSshTarget,
  parseDualStationResumeState,
  parseStationDiscoveryHost,
  prepareDualStationPair,
  type RailConnectivityRequest,
  type StationDiscoveryHost,
  type StationPrepMode,
  validateResumeFileMetadata,
  validateStationPeerTarget,
} from "./lib/dgx-station-peer.mts";

const COMMAND_TIMEOUT_MS = 60_000;
const HELPER_TIMEOUT_MS = 2 * 60 * 60_000;
const MAX_PROBE_OUTPUT_BYTES = 1024 * 1024;

type CommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
};

type CliOptions = {
  helperPath: string;
  statePath: string;
  revision: string;
  explicitPeer?: string;
  reuseExistingManagedPair: boolean;
  migrateLegacySingleStationHead: boolean;
  clearState: boolean;
};

type SshConfig = Map<string, string[]>;

const SUBPROCESS_ENV_NAMES = new Set([
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PATH",
  "TERM",
  "HOSTNAME",
  "NODE_ENV",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "GIT_SSL_CAINFO",
  "GIT_SSL_CAPATH",
  "CURL_CA_BUNDLE",
  "REQUESTS_CA_BUNDLE",
  "SSH_AUTH_SOCK",
]);

const STATION_DISCOVERY_PROBE = String.raw`
import csv
import json
from pathlib import Path
import platform
import re
import socket
import subprocess

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
        "--query-gpu=index,name,uuid",
        "--format=csv,noheader,nounits",
    ])
    if rc != 0:
        return []
    result = []
    for row in csv.reader(output.splitlines()):
        if len(row) != 3:
            continue
        try:
            index = int(row[0].strip())
        except ValueError:
            continue
        result.append({"index": index, "name": row[1].strip(), "uuid": row[2].strip()})
    return result

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
            "netdev": netdev,
            "macAddress": read_text(Path("/sys/class/net") / netdev / "address").lower(),
            "pciAddress": pci_address,
            "pciName": pci_name,
            "state": read_text(ib_port / "state"),
            "linkLayer": read_text(ib_port / "link_layer"),
            "speedMbps": speed_mbps,
            "mtu": mtu,
            "ipv4Addresses": ipv4_addresses(netdev),
        })
    return rails

print(json.dumps({
    "schemaVersion": 1,
    "hostname": socket.gethostname(),
    "productName": product_name(),
    "architecture": platform.machine(),
    "gpus": gpu_inventory(),
    "rails": rail_inventory(),
}, separators=(",", ":")))
`;

export const CONNECTIVITY_PROBE = String.raw`
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
            route_source = route.get("prefsrc", route.get("src", route.get("from", ""))) if isinstance(route, dict) else ""
            route_gateway = route.get("gateway") if isinstance(route, dict) else None
        except json.JSONDecodeError:
            pass
    network = str(ipaddress.ip_network(source + "/30", strict=False))
    link_rc, link_output = run(["ip", "-j", "route", "show", "exact", network])
    if link_rc == 0:
        try:
            link_routes = json.loads(link_output)
            matching_routes = [
                route for route in link_routes if (
                    isinstance(route, dict)
                    and route.get("dst") == network
                    and route.get("dev") == netdev
                    and route.get("gateway") is None
                )
            ] if isinstance(link_routes, list) else []
            if len(matching_routes) == 1:
                route_scope = matching_routes[0].get("scope", "")
        except json.JSONDecodeError:
            pass
    ping_rc, _ = run([
        "ping", "-4", "-M", "do", "-s", "8972", "-c", "1", "-W", "2", "-I", source, peer,
    ])
    neighbor_rc, neighbor_output = run(["ip", "-j", "neighbor", "show", "to", peer])
    if neighbor_rc == 0:
        try:
            neighbors = json.loads(neighbor_output)
            matching_neighbors = [
                neighbor for neighbor in neighbors if (
                    isinstance(neighbor, dict)
                    and neighbor.get("dst") == peer
                    and neighbor.get("dev") == netdev
                )
            ] if isinstance(neighbors, list) else []
            if len(matching_neighbors) == 1:
                peer_mac = str(matching_neighbors[0].get("lladdr", "")).lower()
                raw_state = matching_neighbors[0].get("state", "")
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

print(json.dumps({"schemaVersion": 1, "checks": checks}, separators=(",", ":")))
`;

export function buildStationPrepSubprocessEnv(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (
      value !== undefined &&
      (SUBPROCESS_ENV_NAMES.has(name) || name.startsWith("LC_") || name.startsWith("XDG_"))
    ) {
      env[name] = value;
    }
  }
  env.LC_ALL = "C";
  env.LANG = "C";
  return env;
}

function runCommand(
  file: string,
  args: readonly string[],
  input = "",
  timeout = COMMAND_TIMEOUT_MS,
  maxBuffer = MAX_PROBE_OUTPUT_BYTES,
): CommandResult {
  const result = spawnSync(file, [...args], {
    encoding: "utf8",
    input,
    timeout,
    maxBuffer,
    killSignal: "SIGKILL",
    windowsHide: true,
    env: buildStationPrepSubprocessEnv(),
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error?.message,
  };
}

function commandSucceeded(result: CommandResult, requireOutput = false): boolean {
  return (
    result.status === 0 && !result.error && (!requireOutput || result.stdout.trim().length > 0)
  );
}

function runStreamingCommand(
  file: string,
  args: readonly string[],
  input: string,
  timeout = HELPER_TIMEOUT_MS,
): number {
  const result = spawnSync(file, [...args], {
    input,
    timeout,
    killSignal: "SIGKILL",
    windowsHide: true,
    env: buildStationPrepSubprocessEnv(),
    // Keep stdout machine-readable for the coordinator result while allowing
    // long package and acceptance-image operations to stream without a
    // bounded child-process buffer.
    stdio: ["pipe", process.stderr.fd, process.stderr.fd],
  });
  if (result.error) {
    process.stderr.write(`[station-pair] ${result.error.message}\n`);
  }
  return result.status ?? 1;
}

export function strictStationPrepSshTransportArgs(): string[] {
  return [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "VerifyHostKeyDNS=no",
    "-o",
    "NoHostAuthenticationForLocalhost=no",
    "-o",
    "NumberOfPasswordPrompts=0",
    "-o",
    "PasswordAuthentication=no",
    "-o",
    "KbdInteractiveAuthentication=no",
    "-o",
    "PreferredAuthentications=publickey",
    "-o",
    "ConnectTimeout=5",
    "-o",
    "ConnectionAttempts=1",
    "-o",
    "ServerAliveInterval=5",
    "-o",
    "ServerAliveCountMax=1",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ForwardX11=no",
    "-o",
    "ForwardX11Trusted=no",
    "-o",
    "Tunnel=no",
    "-o",
    "UpdateHostKeys=no",
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-o",
    "PermitLocalCommand=no",
    "-o",
    "RemoteCommand=none",
    "-o",
    "ProxyCommand=none",
    "-o",
    "ProxyJump=none",
    "-o",
    "KnownHostsCommand=none",
    "-o",
    "LogLevel=ERROR",
  ];
}

function parseSshConfig(stdout: string): SshConfig {
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

function assertStrictSshConfig(values: SshConfig): void {
  const exactly = (key: string, allowed: readonly string[]): boolean => {
    const observed = (values.get(key) ?? []).map((value) => value.toLowerCase());
    return observed.length === 1 && allowed.includes(observed[0]);
  };
  const absentOrNone = (key: string): boolean => {
    const observed = (values.get(key) ?? []).map((value) => value.toLowerCase());
    return observed.length === 0 || (observed.length === 1 && observed[0] === "none");
  };
  const sendEnv = (values.get("sendenv") ?? []).map((value) => value.toLowerCase());
  if (
    !exactly("batchmode", ["yes"]) ||
    !exactly("stricthostkeychecking", ["yes", "true"]) ||
    !exactly("verifyhostkeydns", ["false", "no"]) ||
    !exactly("nohostauthenticationforlocalhost", ["false", "no"]) ||
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
    throw new Error("Effective SSH configuration is unsafe for Station peer preparation");
  }
}

function oneSshConfigValue(values: SshConfig, key: string): string {
  const entries = values.get(key) ?? [];
  if (entries.length !== 1 || entries[0].length === 0) {
    throw new Error(`Effective SSH configuration must define exactly one ${key}`);
  }
  return entries[0];
}

function fingerprintKnownHostKey(keyType: string, keyData: string): string | null {
  const result = runCommand(
    "ssh-keygen",
    ["-l", "-E", "sha256", "-f", "-"],
    `${keyType} ${keyData}\n`,
  );
  if (!commandSucceeded(result, true)) return null;
  return result.stdout.match(/\b(SHA256:[A-Za-z0-9+/]{16,86}={0,2})\b/)?.[1] ?? null;
}

function knownHostEvidence(
  lookupHost: string,
  files: readonly string[],
): {
  lines: string[];
  fingerprints: string[];
  digest: string;
} | null {
  const lines = new Set<string>();
  const fingerprints = new Set<string>();
  for (const file of files) {
    if (!path.isAbsolute(file)) continue;
    let metadata: fs.Stats;
    try {
      metadata = fs.lstatSync(file);
    } catch {
      continue;
    }
    const uid = process.getuid?.();
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      uid === undefined ||
      (metadata.uid !== uid && metadata.uid !== 0) ||
      (metadata.mode & 0o022) !== 0
    ) {
      continue;
    }
    const result = runCommand("ssh-keygen", ["-F", lookupHost, "-f", file]);
    if (!commandSucceeded(result, true)) continue;
    for (const rawLine of result.stdout.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#") || /[\u0000\r\n]/.test(line)) continue;
      const fields = line.split(/\s+/);
      const marker = fields[0]?.startsWith("@") ? fields.shift() : "";
      if (fields.length < 3) continue;
      const [_hosts, keyType, keyData] = fields;
      if (!/^(?:ssh-|ecdsa-|sk-)[A-Za-z0-9@._+-]+$/.test(keyType)) continue;
      if (!/^[A-Za-z0-9+/]+={0,3}$/.test(keyData)) continue;
      const fingerprint = fingerprintKnownHostKey(keyType, keyData);
      if (!fingerprint) continue;
      lines.add(line);
      // Preserve matching revocations in the private pinned file so the
      // subsequent SSH connection cannot resurrect a key the operator or
      // system administrator explicitly revoked. A revoked line alone is not
      // positive trust evidence.
      if (marker === "@revoked") continue;
      fingerprints.add(fingerprint);
    }
  }
  if (lines.size === 0 || fingerprints.size === 0) return null;
  const retainedLines = [...lines].sort();
  return {
    lines: retainedLines,
    fingerprints: [...fingerprints].sort(),
    digest: stationKnownHostsDigest(`${retainedLines.join("\n")}\n`),
  };
}

export function inspectPretrustedSshTarget(target: string): PretrustedSshTarget | null {
  validateStationPeerTarget(target);
  const configResult = runCommand(
    "ssh",
    ["-G", ...strictStationPrepSshTransportArgs(), "--", target],
    "",
  );
  if (!commandSucceeded(configResult, true)) return null;
  const config = parseSshConfig(configResult.stdout);
  assertStrictSshConfig(config);
  const resolvedHost = oneSshConfigValue(config, "hostname");
  const sshUser = oneSshConfigValue(config, "user");
  const portText = oneSshConfigValue(config, "port");
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Effective SSH port is invalid");
  }
  const requestedHost = target.slice(target.lastIndexOf("@") + 1);
  if (net.isIP(requestedHost) === 4 && resolvedHost !== requestedHost) {
    throw new Error("Automatic rail target was remapped by SSH configuration");
  }
  const alias = config.get("hostkeyalias")?.[0];
  const baseLookupHost = alias && alias.toLowerCase() !== "none" ? alias : resolvedHost;
  validateStationPeerTarget(baseLookupHost);
  const lookupHost = port === 22 ? baseLookupHost : `[${baseLookupHost}]:${String(port)}`;
  const knownHostFiles = [
    ...(config.get("userknownhostsfile") ?? []),
    ...(config.get("globalknownhostsfile") ?? []),
  ].flatMap((entry) => entry.split(/\s+/).filter((value) => value && value !== "none"));
  const evidence = knownHostEvidence(lookupHost, knownHostFiles);
  if (!evidence) return null;
  return {
    requestedTarget: target,
    sshTarget: target,
    resolvedHost,
    sshUser,
    port,
    lookupHost,
    hostKeyDigest: evidence.digest,
    keyFingerprints: evidence.fingerprints,
    knownHostsLines: evidence.lines,
  };
}

function parseHostResult(result: CommandResult, label: string): StationDiscoveryHost {
  if (!commandSucceeded(result, true)) {
    throw new Error(`${label} failed${result.error ? `: ${result.error}` : ""}`);
  }
  if (Buffer.byteLength(result.stdout, "utf8") > MAX_PROBE_OUTPUT_BYTES) {
    throw new Error(`${label} output is too large`);
  }
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
  return parseStationDiscoveryHost(value);
}

function validateConnectivityArgs(requests: readonly RailConnectivityRequest[]): string[] {
  if (requests.length !== 2) throw new Error("Station connectivity requires exactly two rails");
  const args: string[] = [];
  for (const request of requests) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(request.netdev)) {
      throw new Error("Station connectivity netdev is unsafe");
    }
    if (net.isIP(request.sourceAddress) !== 4 || net.isIP(request.peerAddress) !== 4) {
      throw new Error("Station connectivity addresses are invalid");
    }
    if (!/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(request.expectedPeerMac)) {
      throw new Error("Station connectivity peer MAC is invalid");
    }
    args.push(request.netdev, request.sourceAddress, request.peerAddress);
  }
  return args;
}

function connectivityMatches(
  result: CommandResult,
  requests: readonly RailConnectivityRequest[],
): boolean {
  if (!commandSucceeded(result, true)) return false;
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    return false;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== 1 ||
    !("checks" in value) ||
    !Array.isArray(value.checks) ||
    value.checks.length !== requests.length
  ) {
    return false;
  }
  const checks = value.checks as unknown[];
  return requests.every((request) =>
    checks.some(
      (check) =>
        typeof check === "object" &&
        check !== null &&
        "netdev" in check &&
        check.netdev === request.netdev &&
        "sourceAddress" in check &&
        check.sourceAddress === request.sourceAddress &&
        "peerAddress" in check &&
        check.peerAddress === request.peerAddress &&
        "routeDevice" in check &&
        check.routeDevice === request.netdev &&
        "routeSource" in check &&
        check.routeSource === request.sourceAddress &&
        "routeGateway" in check &&
        check.routeGateway === null &&
        "routeScope" in check &&
        typeof check.routeScope === "string" &&
        check.routeScope.toLowerCase() === "link" &&
        "peerMac" in check &&
        check.peerMac === request.expectedPeerMac &&
        "peerNeighborState" in check &&
        typeof check.peerNeighborState === "string" &&
        /^(?:REACHABLE|STALE|DELAY|PROBE|PERMANENT|NOARP)(?:,(?:REACHABLE|STALE|DELAY|PROBE|PERMANENT|NOARP))*$/i.test(
          check.peerNeighborState,
        ) &&
        "jumboPing" in check &&
        check.jumboPing === true,
    ),
  );
}

export function buildRemoteHelperCommand(helperSha256: string, mode: StationPrepMode): string {
  if (!/^[a-f0-9]{64}$/.test(helperSha256)) throw new Error("Helper SHA-256 is invalid");
  if (
    mode !== "--check" &&
    mode !== "--apply" &&
    mode !== "--verify" &&
    mode !== "--bind-controller"
  ) {
    throw new Error("Helper mode is invalid");
  }
  return [
    "set -eu",
    "umask 077",
    'd=$(mktemp -d "${TMPDIR:-/tmp}/nemoclaw-station-prep.XXXXXX")',
    "trap 'rm -rf -- \"$d\"' EXIT HUP INT TERM",
    'f="$d/prepare-dgx-station-host.sh"',
    'cat >"$f"',
    `test "$(sha256sum "$f" | awk '{print $1}')" = "${helperSha256}"`,
    'chmod 0600 "$f"',
    "sudo -n true",
    `NEMOCLAW_STATION_PREP_SUDO_NONINTERACTIVE=1 bash "$f" ${mode}`,
  ].join("; ");
}

function assertSecureStateDirectory(directory: string): void {
  let metadata: fs.Stats;
  try {
    metadata = fs.lstatSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("Dual-Station resume directory must already exist");
    }
    throw error;
  }
  const uid = process.getuid?.();
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    uid === undefined ||
    metadata.uid !== uid ||
    (metadata.mode & 0o077) !== 0
  ) {
    throw new Error("Dual-Station resume directory must be owner-only and symlink-free");
  }
}

export function readDualStationResumeState(statePath: string): DualStationResumeState | null {
  const directory = path.dirname(statePath);
  assertSecureStateDirectory(directory);
  const noFollow = fs.constants.O_NOFOLLOW;
  if (typeof noFollow !== "number") throw new Error("O_NOFOLLOW is required for resume state");
  let fd: number;
  try {
    fd = fs.openSync(statePath, fs.constants.O_RDONLY | noFollow | fs.constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP") throw new Error("Dual-Station resume state must not be a symlink");
    throw error;
  }
  try {
    const metadata = fs.fstatSync(fd);
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("Current user identity is unavailable");
    validateResumeFileMetadata(
      {
        isFile: metadata.isFile(),
        isSymbolicLink: metadata.isSymbolicLink(),
        uid: metadata.uid,
        mode: metadata.mode,
        size: metadata.size,
      },
      uid,
    );
    const raw = fs.readFileSync(fd, "utf8");
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error("Dual-Station resume state is malformed JSON");
    }
    return parseDualStationResumeState(value);
  } finally {
    fs.closeSync(fd);
  }
}

export function writeDualStationResumeState(
  statePath: string,
  state: DualStationResumeState,
): void {
  const validated = parseDualStationResumeState(state);
  const directory = path.dirname(statePath);
  assertSecureStateDirectory(directory);
  const noFollow = fs.constants.O_NOFOLLOW;
  if (typeof noFollow !== "number") throw new Error("O_NOFOLLOW is required for resume state");
  const temporary = `${statePath}.tmp.${randomBytes(12).toString("hex")}`;
  let fd: number | null = null;
  let failure: { error: unknown } | null = null;
  try {
    fd = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
      0o600,
    );
    fs.writeFileSync(fd, `${JSON.stringify(validated)}\n`, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temporary, statePath);
    const directoryFd = fs.openSync(directory, fs.constants.O_RDONLY);
    let directoryFailure: { error: unknown } | null = null;
    try {
      fs.fsyncSync(directoryFd);
    } catch (error) {
      directoryFailure = { error };
    }
    try {
      fs.closeSync(directoryFd);
    } catch (error) {
      directoryFailure ??= { error };
    }
    if (directoryFailure) throw directoryFailure.error;
  } catch (error) {
    failure = { error };
  }
  if (fd !== null) {
    try {
      fs.closeSync(fd);
    } catch (error) {
      failure ??= { error };
    }
  }
  try {
    fs.unlinkSync(temporary);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") failure ??= { error };
  }
  if (failure) throw failure.error;
}

export function clearDualStationResumeState(statePath: string): void {
  const current = readDualStationResumeState(statePath);
  clearDualStationSshBinding(statePath);
  if (!current) return;

  fs.unlinkSync(statePath);
  const directoryFd = fs.openSync(path.dirname(statePath), fs.constants.O_RDONLY);
  let failure: { error: unknown } | null = null;
  try {
    fs.fsyncSync(directoryFd);
  } catch (error) {
    failure = { error };
  }
  try {
    fs.closeSync(directoryFd);
  } catch (error) {
    failure ??= { error };
  }
  if (failure) throw failure.error;
}

function parseCliOptions(args: readonly string[]): CliOptions {
  const values = new Map<string, string>();
  let reuseExistingManagedPair = false;
  let migrateLegacySingleStationHead = false;
  let clearState = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--reuse-existing-managed-pair") {
      reuseExistingManagedPair = true;
      continue;
    }
    if (arg === "--migrate-legacy-single-head") {
      migrateLegacySingleStationHead = true;
      continue;
    }
    if (arg === "--clear-state") {
      clearState = true;
      continue;
    }
    if (!arg.startsWith("--") || index + 1 >= args.length) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    if (values.has(arg)) throw new Error(`Duplicate argument: ${arg}`);
    values.set(arg, args[(index += 1)]);
  }
  const helperPath = values.get("--helper") ?? "";
  const statePath = values.get("--state") ?? "";
  const revision = values.get("--revision") ?? "";
  if (!path.isAbsolute(statePath)) throw new Error("--state must be an absolute path");
  if (!clearState && !path.isAbsolute(helperPath)) {
    throw new Error("--helper must be an absolute path");
  }
  if (!clearState && !/^[a-f0-9]{40}$/.test(revision)) {
    throw new Error("--revision must be an exact commit SHA");
  }
  const explicitPeer = values.get("--explicit-peer");
  if (explicitPeer !== undefined) validateStationPeerTarget(explicitPeer);
  const allowed = new Set(["--helper", "--state", "--revision", "--explicit-peer"]);
  for (const key of values.keys()) {
    if (!allowed.has(key)) throw new Error(`Unexpected argument: ${key}`);
  }
  return {
    helperPath,
    statePath,
    revision,
    explicitPeer,
    reuseExistingManagedPair,
    migrateLegacySingleStationHead,
    clearState,
  };
}

function assertHelperFile(helperPath: string): Buffer {
  const noFollow = fs.constants.O_NOFOLLOW;
  if (typeof noFollow !== "number") throw new Error("O_NOFOLLOW is required for the helper");
  let fd: number;
  try {
    fd = fs.openSync(helperPath, fs.constants.O_RDONLY | noFollow | fs.constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error("Station host-preparation helper must not be a symlink");
    }
    throw error;
  }
  try {
    const metadata = fs.fstatSync(fd);
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > 2 ** 20) {
      throw new Error("Station host-preparation helper must be a bounded regular file");
    }
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function sshArgs(
  binding: PretrustedSshTarget,
  pinnedKnownHostsPath: string,
  remoteCommand: string,
): string[] {
  return [
    ...strictStationPrepSshTransportArgs(),
    "-o",
    `UserKnownHostsFile=${pinnedKnownHostsPath}`,
    "-o",
    "GlobalKnownHostsFile=/dev/null",
    "-o",
    `HostKeyAlias=${binding.lookupHost}`,
    "--",
    binding.sshTarget,
    remoteCommand,
  ];
}

function createRuntimeDeps(options: CliOptions): {
  deps: DualStationPreparationDeps;
  helperSha256: string;
  cleanup(): void;
} {
  const helperBytes = assertHelperFile(options.helperPath);
  const helperSha256 = createHash("sha256").update(helperBytes).digest("hex");
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-pair-"));
  fs.chmodSync(temporaryDirectory, 0o700);
  const pinnedHelperPath = path.join(temporaryDirectory, "prepare-dgx-station-host.sh");
  fs.writeFileSync(pinnedHelperPath, helperBytes, { flag: "wx", mode: 0o600 });
  const pinnedFiles = new Map<string, string>();

  const pinnedKnownHosts = (binding: PretrustedSshTarget): string => {
    const cached = pinnedFiles.get(binding.hostKeyDigest);
    if (cached) return cached;
    const file = path.join(temporaryDirectory, `known-hosts-${binding.hostKeyDigest}`);
    fs.writeFileSync(file, `${binding.knownHostsLines.join("\n")}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    pinnedFiles.set(binding.hostKeyDigest, file);
    return file;
  };

  const runLocalHelper = (mode: StationPrepMode): number => {
    return runStreamingCommand("bash", [pinnedHelperPath, mode], "");
  };

  const deps: DualStationPreparationDeps = {
    runLocalHelper,
    probeLocalHost: () =>
      parseHostResult(
        runCommand("python3", ["-"], STATION_DISCOVERY_PROBE),
        "Local Station identity probe",
      ),
    inspectPretrustedTarget: inspectPretrustedSshTarget,
    probePeerHost: (binding) =>
      parseHostResult(
        runCommand(
          "ssh",
          sshArgs(binding, pinnedKnownHosts(binding), "python3 -"),
          STATION_DISCOVERY_PROBE,
        ),
        "Peer Station identity probe",
      ),
    probeLocalConnectivity: (requests) => {
      const args = validateConnectivityArgs(requests);
      return connectivityMatches(
        runCommand("python3", ["-", ...args], CONNECTIVITY_PROBE),
        requests,
      );
    },
    probePeerConnectivity: (binding, requests) => {
      const args = validateConnectivityArgs(requests);
      return connectivityMatches(
        runCommand(
          "ssh",
          sshArgs(binding, pinnedKnownHosts(binding), ["python3", "-", ...args].join(" ")),
          CONNECTIVITY_PROBE,
        ),
        requests,
      );
    },
    runRemoteHelper: (binding, mode) => {
      return runStreamingCommand(
        "ssh",
        sshArgs(binding, pinnedKnownHosts(binding), buildRemoteHelperCommand(helperSha256, mode)),
        helperBytes.toString("utf8"),
      );
    },
    readResumeState: () => readDualStationResumeState(options.statePath),
    writeResumeState: (state) => writeDualStationResumeState(options.statePath, state),
    clearResumeState: () => clearDualStationResumeState(options.statePath),
    log: (message) => process.stderr.write(`[station-pair] ${message}\n`),
  };

  return {
    deps,
    helperSha256,
    cleanup: () => fs.rmSync(temporaryDirectory, { recursive: true, force: true }),
  };
}

export function runCli(args: readonly string[]): number {
  const options = parseCliOptions(args);
  if (options.clearState) {
    clearDualStationResumeState(options.statePath);
    process.stdout.write(`${JSON.stringify({ kind: "cleared" })}\n`);
    return 0;
  }
  const runtime = createRuntimeDeps(options);
  try {
    const result = prepareDualStationPair(
      {
        revision: options.revision,
        helperSha256: runtime.helperSha256,
        explicitPeer: options.explicitPeer,
        reuseExistingManagedPair: options.reuseExistingManagedPair,
        migrateLegacySingleStationHead: options.migrateLegacySingleStationHead,
      },
      runtime.deps,
    );
    if (result.kind === "single-station") {
      runtime.deps.log(`Using the existing single-Station path: ${result.reason}`);
      // A single-Station result is possible only without pair resume state.
      // Remove any owner-only binding orphan left by an interrupted earlier
      // cleanup so it cannot linger without the pair identity that owns it.
      if (readDualStationResumeState(options.statePath)) {
        throw new Error("Single-Station fallback cannot discard exact pair resume state");
      }
      clearDualStationSshBinding(options.statePath);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return 0;
    }
    if (
      result.binding.sshTarget !== result.peerTarget ||
      result.binding.hostKeyDigest !== result.identity.hostKeyDigest
    ) {
      throw new Error("Qualified Station SSH binding does not match the prepared pair identity");
    }
    const binding = writeDualStationSshBinding(options.statePath, result.binding);
    process.stdout.write(
      `${JSON.stringify({
        kind: result.kind,
        peerTarget: result.peerTarget,
        identity: result.identity,
        sshBinding: encodeDualStationSshBindingHandoff(binding),
      })}\n`,
    );
    return result.kind === "reboot-required" ? 10 : 0;
  } finally {
    runtime.cleanup();
  }
}

function isMainModule(): boolean {
  const invoked = process.argv[1];
  return Boolean(invoked && path.resolve(invoked) === path.resolve(fileURLToPath(import.meta.url)));
}

if (isMainModule()) {
  try {
    process.exitCode = runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`[station-pair] ERROR: ${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
