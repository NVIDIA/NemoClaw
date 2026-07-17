// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import YAML from "yaml";

import { shellQuote } from "../../../src/lib/core/shell-quote";
import { parseOpenShellPolicy } from "../../../src/lib/policy/merge";
import type { ArtifactSink } from "../fixtures/artifacts.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { CleanupRegistry } from "../fixtures/cleanup.ts";
import { assertExitZero as expectExitZero, resultText } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import {
  type SandboxClient,
  sandboxAccessEnv,
  trustedSandboxShellScript,
} from "../fixtures/clients/sandbox.ts";
import { expect } from "../fixtures/e2e-test.ts";

const EXACT_MAIN_POLICY_KEY = "exact_main_live_exe_identity";
const LIVE_EXE_PATH = "/tmp/nemoclaw-exact-main-live-exe/live-bash";
const NETNS_PROXY_HOST = "10.200.0.1";
const NETNS_PROXY_PORT = 3128;
const POLICY_TIMEOUT_MS = 120_000;
const SANDBOX_CONTAINER_LABEL = "openshell.ai/sandbox-name";

type JsonRecord = Record<string, unknown>;

export interface ExactMainPolicyStatus {
  activeVersion: number;
  configRevision?: number;
  hash: string;
  policySource?: string;
  sandbox: string;
  status: string;
  version: number;
}

export interface ExactMainNftInspection {
  chainPolicy: string;
  loopbackAcceptIndex: number;
  proxyAcceptIndex: number;
  rejectIndexes: Record<"ipv4Tcp" | "ipv4Udp" | "ipv6Tcp" | "ipv6Udp", number>;
  ruleCount: number;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(record: JsonRecord, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`expected non-empty string ${key} in exact-main JSON output`);
  }
  return value;
}

function requiredInteger(record: JsonRecord, key: string): number {
  const value = record[key];
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`expected non-negative integer ${key} in exact-main JSON output`);
  }
  return Number(value);
}

export function parseExactMainPolicyStatus(raw: string): ExactMainPolicyStatus {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) throw new Error("exact-main policy status must be a JSON object");
  const configRevision = parsed.config_revision;
  const policySource = parsed.policy_source;
  if (configRevision !== undefined && !Number.isSafeInteger(configRevision)) {
    throw new Error("exact-main policy config_revision must be an integer when present");
  }
  if (policySource !== undefined && typeof policySource !== "string") {
    throw new Error("exact-main policy policy_source must be a string when present");
  }
  return {
    activeVersion: requiredInteger(parsed, "active_version"),
    ...(configRevision === undefined ? {} : { configRevision: Number(configRevision) }),
    hash: requiredString(parsed, "hash"),
    ...(policySource === undefined ? {} : { policySource }),
    sandbox: requiredString(parsed, "sandbox"),
    status: requiredString(parsed, "status"),
    version: requiredInteger(parsed, "version"),
  };
}

function containsObject(value: unknown, predicate: (candidate: JsonRecord) => boolean): boolean {
  if (Array.isArray(value)) return value.some((entry) => containsObject(entry, predicate));
  if (!isRecord(value)) return false;
  if (predicate(value)) return true;
  return Object.values(value).some((entry) => containsObject(entry, predicate));
}

function containsScalar(value: unknown, expected: string | number): boolean {
  if (value === expected) return true;
  if (Array.isArray(value)) return value.some((entry) => containsScalar(entry, expected));
  if (!isRecord(value)) return false;
  return Object.values(value).some((entry) => containsScalar(entry, expected));
}

function hasVerdict(rule: JsonRecord, verdict: "accept" | "reject"): boolean {
  return containsObject(rule, (candidate) => Object.hasOwn(candidate, verdict));
}

function hasMatch(rule: JsonRecord, selector: JsonRecord, right: string | number): boolean {
  return containsObject(
    rule,
    (candidate) =>
      isRecord(candidate.match) &&
      containsObject(candidate.match, (nested) =>
        Object.entries(selector).every(([key, value]) => nested[key] === value),
      ) &&
      candidate.match.right === right,
  );
}

function nftRuleMatchesReject(
  rule: JsonRecord,
  family: "ipv4" | "ipv6",
  protocol: "tcp" | "udp",
): boolean {
  return (
    hasVerdict(rule, "reject") &&
    hasMatch(rule, { key: "nfproto" }, family) &&
    hasMatch(rule, { key: "l4proto" }, protocol) &&
    containsScalar(rule, "port-unreachable")
  );
}

export function inspectExactMainNftRuleset(raw: string): ExactMainNftInspection {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || !Array.isArray(parsed.nftables)) {
    throw new Error("nft -j output must contain an nftables array");
  }
  const entries = parsed.nftables.filter(isRecord);
  const table = entries
    .map((entry) => entry.table)
    .find(
      (candidate) =>
        isRecord(candidate) && candidate.family === "inet" && candidate.name === "openshell_bypass",
    );
  if (!table) throw new Error("missing inet openshell_bypass nft table");
  const chain = entries
    .map((entry) => entry.chain)
    .find(
      (candidate) =>
        isRecord(candidate) &&
        candidate.family === "inet" &&
        candidate.table === "openshell_bypass" &&
        candidate.name === "output",
    );
  if (!isRecord(chain)) throw new Error("missing openshell_bypass output chain");
  if (
    chain.type !== "filter" ||
    chain.hook !== "output" ||
    chain.prio !== 0 ||
    chain.policy !== "accept"
  ) {
    throw new Error(
      `unexpected openshell_bypass chain contract: ${JSON.stringify({
        hook: chain.hook,
        policy: chain.policy,
        prio: chain.prio,
        type: chain.type,
      })}`,
    );
  }

  const rules = entries
    .map((entry) => entry.rule)
    .filter(
      (candidate): candidate is JsonRecord =>
        isRecord(candidate) &&
        candidate.family === "inet" &&
        candidate.table === "openshell_bypass" &&
        candidate.chain === "output",
    );
  const proxyAcceptIndex = rules.findIndex(
    (rule) =>
      hasVerdict(rule, "accept") &&
      hasMatch(rule, { protocol: "ip", field: "daddr" }, NETNS_PROXY_HOST) &&
      hasMatch(rule, { protocol: "tcp", field: "dport" }, NETNS_PROXY_PORT),
  );
  const loopbackAcceptIndex = rules.findIndex(
    (rule) => hasVerdict(rule, "accept") && hasMatch(rule, { key: "oifname" }, "lo"),
  );
  if (proxyAcceptIndex < 0) throw new Error("missing exact proxy IPv4 accept rule");
  if (loopbackAcceptIndex < 0) throw new Error("missing loopback accept rule");

  const rejectKinds = [
    ["ipv4Tcp", "ipv4", "tcp"],
    ["ipv6Tcp", "ipv6", "tcp"],
    ["ipv4Udp", "ipv4", "udp"],
    ["ipv6Udp", "ipv6", "udp"],
  ] as const;
  const rejectIndexes = {} as ExactMainNftInspection["rejectIndexes"];
  for (const [key, family, protocol] of rejectKinds) {
    const matches = rules
      .map((rule, index) => ({ index, matches: nftRuleMatchesReject(rule, family, protocol) }))
      .filter((entry) => entry.matches);
    if (matches.length !== 1) {
      throw new Error(
        `expected exactly one ${family} ${protocol} reject rule, got ${matches.length}`,
      );
    }
    rejectIndexes[key] = matches[0]?.index ?? -1;
  }

  const firstReject = Math.min(...Object.values(rejectIndexes));
  if (proxyAcceptIndex >= firstReject || loopbackAcceptIndex >= firstReject) {
    throw new Error("nft accept rules must precede every required reject rule");
  }
  if (
    !(
      rejectIndexes.ipv4Tcp < rejectIndexes.ipv6Tcp &&
      rejectIndexes.ipv6Tcp < rejectIndexes.ipv4Udp &&
      rejectIndexes.ipv4Udp < rejectIndexes.ipv6Udp
    )
  ) {
    throw new Error("required nft rejects are not in IPv4/IPv6 TCP then IPv4/IPv6 UDP order");
  }
  return {
    chainPolicy: "accept",
    loopbackAcceptIndex,
    proxyAcceptIndex,
    rejectIndexes,
    ruleCount: rules.length,
  };
}

function buildIdentityPolicy(basePolicyYaml: string, mcpUrl: string): string {
  const parsed: unknown = YAML.parse(basePolicyYaml);
  if (!isRecord(parsed)) throw new Error("OpenShell base policy must be a YAML mapping");
  const networkPolicies = parsed.network_policies;
  if (networkPolicies !== undefined && !isRecord(networkPolicies)) {
    throw new Error("OpenShell network_policies must be a mapping");
  }
  const endpoint = new URL(mcpUrl);
  const port = endpoint.port ? Number(endpoint.port) : endpoint.protocol === "https:" ? 443 : 80;
  parsed.network_policies = {
    ...(networkPolicies ?? {}),
    [EXACT_MAIN_POLICY_KEY]: {
      name: EXACT_MAIN_POLICY_KEY,
      endpoints: [{ host: endpoint.hostname, port, access: "full", tls: "skip" }],
      binaries: [{ path: LIVE_EXE_PATH }],
    },
  };
  return YAML.stringify(parsed);
}

const LIVE_EXE_CONNECT_SCRIPT = String.raw`set -eu
endpoint_host=$1
endpoint_port=$2
first_result=$3
second_result=$4
trigger=$5
proxy_url=$(printenv HTTPS_PROXY 2>/dev/null || printenv https_proxy 2>/dev/null || printenv HTTP_PROXY 2>/dev/null || printenv http_proxy 2>/dev/null || true)
[ -n "$proxy_url" ] || { printf '%s\n' 'proxy environment missing' >&2; exit 1; }
proxy_authority=$(printf '%s' "$proxy_url" | sed -E 's#^[^:]+://##; s#/.*$##')
proxy_host=$(printf '%s' "$proxy_authority" | cut -d: -f1)
proxy_port=$(printf '%s' "$proxy_authority" | cut -d: -f2)
[ -n "$proxy_host" ] && [ "$proxy_port" -ge 1 ] 2>/dev/null
connect_status() {
  status=000
  if exec 7<>"/dev/tcp/$proxy_host/$proxy_port"; then
    printf 'CONNECT %s:%s HTTP/1.1\r\nHost: %s:%s\r\nConnection: close\r\n\r\n' "$endpoint_host" "$endpoint_port" "$endpoint_host" "$endpoint_port" >&7
    IFS=' ' read -r -t 30 _ status _ <&7 || status=000
    exec 7<&-
    exec 7>&-
  fi
  printf '%s\n' "$status"
}
connect_status > "$first_result"
IFS= read -r _ < "$trigger"
connect_status > "$second_result"`;

const LIVE_EXE_ONESHOT_SCRIPT = String.raw`set -eu
endpoint_host=$1
endpoint_port=$2
proxy_url=$(printenv HTTPS_PROXY 2>/dev/null || printenv https_proxy 2>/dev/null || printenv HTTP_PROXY 2>/dev/null || printenv http_proxy 2>/dev/null || true)
[ -n "$proxy_url" ] || { printf '%s\n' '000'; exit 0; }
proxy_authority=$(printf '%s' "$proxy_url" | sed -E 's#^[^:]+://##; s#/.*$##')
proxy_host=$(printf '%s' "$proxy_authority" | cut -d: -f1)
proxy_port=$(printf '%s' "$proxy_authority" | cut -d: -f2)
status=000
if exec 7<>"/dev/tcp/$proxy_host/$proxy_port"; then
  printf 'CONNECT %s:%s HTTP/1.1\r\nHost: %s:%s\r\nConnection: close\r\n\r\n' "$endpoint_host" "$endpoint_port" "$endpoint_host" "$endpoint_port" >&7
  IFS=' ' read -r -t 30 _ status _ <&7 || status=000
  exec 7<&-
  exec 7>&-
fi
printf '%s\n' "$status"`;

export function buildExactMainLiveExeIdentityScript(mcpUrl: string): string {
  const endpoint = new URL(mcpUrl);
  const endpointPort = endpoint.port
    ? Number(endpoint.port)
    : endpoint.protocol === "https:"
      ? 443
      : 80;
  const root = path.posix.dirname(LIVE_EXE_PATH);
  return [
    "set -eu",
    `root=${shellQuote(root)}`,
    `live=${shellQuote(LIVE_EXE_PATH)}`,
    'old_pid=""',
    'trap \'if [ -n "${old_pid:-}" ]; then kill "$old_pid" 2>/dev/null || true; fi; rm -rf "$root"\' EXIT',
    'rm -rf "$root"',
    'mkdir -p "$root"',
    "bash_source=$(command -v bash)",
    '[ -n "$bash_source" ]',
    'cp "$bash_source" "$live"',
    'chmod 0755 "$live"',
    'first="$root/old-first.status"',
    'second="$root/old-second.status"',
    'trigger="$root/old-second.trigger"',
    'mkfifo "$trigger"',
    `worker_script=${shellQuote(LIVE_EXE_CONNECT_SCRIPT)}`,
    `oneshot_script=${shellQuote(LIVE_EXE_ONESHOT_SCRIPT)}`,
    `"$live" -c "$worker_script" exact-main-old ${shellQuote(endpoint.hostname)} ${endpointPort} "$first" "$second" "$trigger" &`,
    "old_pid=$!",
    "wait_for_result() {",
    "  result_path=$1",
    "  attempts=0",
    '  while [ ! -s "$result_path" ]; do',
    '    if ! kill -0 "$old_pid" 2>/dev/null; then',
    "      printf 'old process exited before result: %s\\n' \"$result_path\" >&2",
    "      exit 1",
    "    fi",
    "    attempts=$((attempts + 1))",
    '    [ "$attempts" -lt 300 ] || { printf \'timed out waiting for %s\\n\' "$result_path" >&2; exit 1; }',
    "    sleep 0.1",
    "  done",
    "}",
    'wait_for_result "$first"',
    "old_first=$(tr -d '\\r\\n' < \"$first\")",
    '[ "$old_first" = 200 ]',
    'replacement="$root/live-bash.next"',
    'cp "$live" "$replacement"',
    "printf '\\nNEMOCLAW_EXACT_MAIN_REPLACEMENT\\n' >> \"$replacement\"",
    'chmod 0755 "$replacement"',
    'mv -f "$replacement" "$live"',
    'old_exe=$(readlink "/proc/$old_pid/exe")',
    "old_hash=$(sha256sum \"/proc/$old_pid/exe\" | awk '{print $1}')",
    "new_hash=$(sha256sum \"$live\" | awk '{print $1}')",
    '[ "$old_hash" != "$new_hash" ]',
    "printf 'go\\n' > \"$trigger\"",
    'wait_for_result "$second"',
    "old_second=$(tr -d '\\r\\n' < \"$second\")",
    '[ "$old_second" = 200 ]',
    'wait "$old_pid"',
    'old_pid=""',
    `new_status=$("$live" -c "$oneshot_script" exact-main-new ${shellQuote(endpoint.hostname)} ${endpointPort} | tr -d '\\r\\n')`,
    "printf 'NEMOCLAW_LIVE_EXE_OLD_FIRST=%s\\n' \"$old_first\"",
    "printf 'NEMOCLAW_LIVE_EXE_OLD_SECOND=%s\\n' \"$old_second\"",
    "printf 'NEMOCLAW_LIVE_EXE_NEW=%s\\n' \"$new_status\"",
    "printf 'NEMOCLAW_LIVE_EXE_OLD_LINK=%s\\n' \"$old_exe\"",
    "printf 'NEMOCLAW_LIVE_EXE_OLD_HASH=%s\\n' \"$old_hash\"",
    "printf 'NEMOCLAW_LIVE_EXE_NEW_HASH=%s\\n' \"$new_hash\"",
    '[ "$old_first" = 200 ]',
    '[ "$old_second" = 200 ]',
    '[ "$new_status" = 403 ]',
  ].join("\n");
}

const BYPASS_SERVER_CODE = String.raw`import os
import selectors
import socket
import sys

ready_path = sys.argv[1]
bind_host = sys.argv[2]
tcp = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
tcp.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
tcp.bind((bind_host, 0))
port = tcp.getsockname()[1]
tcp.listen(8)
udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
udp.bind((bind_host, port))
selector = selectors.DefaultSelector()
selector.register(tcp, selectors.EVENT_READ, "tcp")
selector.register(udp, selectors.EVENT_READ, "udp")
with open(ready_path, "w", encoding="utf-8") as ready:
    ready.write(f"{os.getpid()} {port}\n")
    ready.flush()
while True:
    for key, _ in selector.select(timeout=30):
        if key.data == "tcp":
            client, _ = tcp.accept()
            with client:
                client.settimeout(2)
                payload = client.recv(4096)
                client.sendall(payload or b"NEMOCLAW_TCP_ECHO")
        else:
            payload, address = udp.recvfrom(4096)
            udp.sendto(payload or b"NEMOCLAW_UDP_ECHO", address)`;

const START_BYPASS_SERVER_SCRIPT = String.raw`ready=$1
log=$2
server_code=$3
bind_host=$4
rm -f "$ready" "$log"
nohup python3 -c "$server_code" "$ready" "$bind_host" >"$log" 2>&1 </dev/null &
pid=$!
attempts=0
while [ ! -s "$ready" ]; do
  if ! kill -0 "$pid" 2>/dev/null; then
    cat "$log" >&2 || true
    exit 1
  fi
  attempts=$((attempts + 1))
  [ "$attempts" -lt 100 ] || { cat "$log" >&2 || true; exit 1; }
  sleep 0.1
done
cat "$ready"`;

const DIRECT_BYPASS_PROBE_CODE = String.raw`import errno
import json
import socket
import sys
import time

host = sys.argv[1]
port = int(sys.argv[2])

def tcp_probe():
    started = time.monotonic()
    connected = False
    error = None
    try:
        with socket.create_connection((host, port), timeout=3) as stream:
            connected = True
            stream.sendall(b"NEMOCLAW_TCP_BYPASS")
            stream.recv(128)
    except OSError as exc:
        error = {"errno": exc.errno, "name": type(exc).__name__, "text": str(exc)}
    return {"connected": connected, "elapsedMs": round((time.monotonic() - started) * 1000), "error": error}

def udp_probe():
    started = time.monotonic()
    echoed = False
    error = None
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(3)
    try:
        sock.connect((host, port))
        sock.send(b"NEMOCLAW_UDP_BYPASS")
        echoed = sock.recv(128) == b"NEMOCLAW_UDP_BYPASS"
    except OSError as exc:
        error = {"errno": exc.errno, "name": type(exc).__name__, "text": str(exc)}
    finally:
        sock.close()
    return {"echoed": echoed, "elapsedMs": round((time.monotonic() - started) * 1000), "error": error}

result = {"tcp": tcp_probe(), "udp": udp_probe()}
print(json.dumps(result, sort_keys=True))
tcp_error = result["tcp"]["error"] or {}
udp_error = result["udp"]["error"] or {}
if result["tcp"]["connected"] or result["udp"]["echoed"]:
    raise SystemExit(1)
if tcp_error.get("errno") != errno.ECONNREFUSED or udp_error.get("errno") != errno.ECONNREFUSED:
    raise SystemExit(1)
if result["tcp"]["elapsedMs"] >= 2500 or result["udp"]["elapsedMs"] >= 2500:
    raise SystemExit(1)`;

async function findSandboxContainer(
  host: HostCliClient,
  sandboxName: string,
  artifactName: string,
): Promise<string> {
  const result = await host.command(
    "docker",
    [
      "ps",
      "--no-trunc",
      "--filter",
      "label=openshell.ai/managed-by=openshell",
      "--filter",
      `label=${SANDBOX_CONTAINER_LABEL}=${sandboxName}`,
      "--format",
      "{{.ID}}",
    ],
    { artifactName, env: buildAvailabilityProbeEnv(), timeoutMs: 30_000 },
  );
  expectExitZero(result, `locate OpenShell sandbox container ${sandboxName}`);
  const ids = result.stdout.trim().split(/\s+/u).filter(Boolean);
  expect(ids, resultText(result)).toHaveLength(1);
  return ids[0] ?? "";
}

async function inspectNftRules(
  host: HostCliClient,
  containerId: string,
  artifactName: string,
): Promise<{ inspection: ExactMainNftInspection; raw: string }> {
  const script = [
    "set -- /var/run/netns/sandbox-*",
    '[ "$#" -eq 1 ] && [ -e "$1" ] || { printf \'expected exactly one sandbox netns\\n\' >&2; exit 1; }',
    "namespace=${1##*/}",
    'exec ip netns exec "$namespace" nft -j list table inet openshell_bypass',
  ].join("\n");
  const result = await host.command(
    "docker",
    ["exec", "--user", "0", containerId, "sh", "-ceu", script],
    { artifactName, env: buildAvailabilityProbeEnv(), timeoutMs: 30_000 },
  );
  expectExitZero(result, "inspect exact-main nft bypass rules");
  return { inspection: inspectExactMainNftRuleset(result.stdout), raw: result.stdout };
}

async function readPolicyStatus(
  sandbox: SandboxClient,
  sandboxName: string,
  args: string[],
  artifactName: string,
): Promise<ExactMainPolicyStatus> {
  const result = await sandbox.openshell(
    ["policy", "get", ...args, sandboxName, "--output", "json"],
    {
      artifactName,
      env: sandboxAccessEnv(),
      timeoutMs: POLICY_TIMEOUT_MS,
    },
  );
  expectExitZero(result, `read exact-main policy status for ${sandboxName}`);
  return parseExactMainPolicyStatus(result.stdout);
}

async function waitForRestartedPolicy(
  sandbox: SandboxClient,
  sandboxName: string,
  expected: ExactMainPolicyStatus,
): Promise<{ effective: ExactMainPolicyStatus; revision: ExactMainPolicyStatus }> {
  const deadline = Date.now() + POLICY_TIMEOUT_MS;
  let last = "no status response";
  while (Date.now() < deadline) {
    try {
      const revision = await readPolicyStatus(
        sandbox,
        sandboxName,
        ["--rev", String(expected.version)],
        "exact-main-policy-revision-after-restart",
      );
      const effective = await readPolicyStatus(
        sandbox,
        sandboxName,
        [],
        "exact-main-policy-effective-after-restart",
      );
      if (
        revision.status === "loaded" &&
        revision.hash === expected.hash &&
        revision.activeVersion === expected.version &&
        effective.status === "effective" &&
        effective.hash === expected.hash &&
        effective.version === expected.version
      ) {
        return { effective, revision };
      }
      last = JSON.stringify({ effective, revision });
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`timed out waiting for exact policy identity after restart: ${last}`);
}

async function waitForInitialPolicyAcknowledgement(
  sandbox: SandboxClient,
  sandboxName: string,
  version: number,
): Promise<string> {
  const marker = `Acknowledged initial policy revision as loaded [version:${version}]`;
  const deadline = Date.now() + 60_000;
  let last = "";
  while (Date.now() < deadline) {
    const logs = await sandbox.openshell(
      ["logs", sandboxName, "-n", "4000", "--since", "10m", "--source", "sandbox"],
      {
        artifactName: "exact-main-initial-policy-acknowledgement",
        env: sandboxAccessEnv(),
        timeoutMs: 30_000,
      },
    );
    if (logs.exitCode === 0) {
      last = logs.stdout;
      if (last.includes(marker)) return marker;
    } else {
      last = resultText(logs);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`missing exact initial policy acknowledgement ${marker}\n${last}`);
}

async function stopBypassServer(
  host: HostCliClient,
  containerId: string,
  pid: number,
  readyPath: string,
  logPath: string,
): Promise<void> {
  const result = await host.command(
    "docker",
    [
      "exec",
      "--user",
      "0",
      containerId,
      "sh",
      "-ceu",
      'kill "$1" 2>/dev/null || true; rm -f "$2" "$3"',
      "exact-main-bypass-cleanup",
      String(pid),
      readyPath,
      logPath,
    ],
    {
      artifactName: "exact-main-bypass-listener-cleanup",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    },
  );
  expectExitZero(result, "stop exact-main controlled bypass listener");
}

async function assertDirectBypassDenied(options: {
  cleanup: CleanupRegistry;
  host: HostCliClient;
  containerId: string;
  sandbox: SandboxClient;
  sandboxName: string;
  version: number;
}): Promise<JsonRecord> {
  const readyPath = `/tmp/nemoclaw-exact-main-bypass-${options.version}.ready`;
  const logPath = `/tmp/nemoclaw-exact-main-bypass-${options.version}.log`;
  const start = await options.host.command(
    "docker",
    [
      "exec",
      "--user",
      "0",
      options.containerId,
      "sh",
      "-ceu",
      START_BYPASS_SERVER_SCRIPT,
      "exact-main-bypass-listener",
      readyPath,
      logPath,
      BYPASS_SERVER_CODE,
      NETNS_PROXY_HOST,
    ],
    {
      artifactName: "exact-main-bypass-listener-start",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    },
  );
  expectExitZero(start, "start controlled TCP/UDP bypass listener");
  const match = start.stdout.trim().match(/^(\d+)\s+(\d+)$/u);
  if (!match) throw new Error(`unexpected bypass listener identity: ${start.stdout}`);
  const pid = Number(match[1]);
  const port = Number(match[2]);
  let listenerRunning = true;
  const cleanupListener = async () => {
    if (!listenerRunning) return;
    await stopBypassServer(options.host, options.containerId, pid, readyPath, logPath);
    listenerRunning = false;
  };
  options.cleanup.add("stop exact-main controlled TCP/UDP bypass listener", cleanupListener);
  try {
    const probe = await options.sandbox.exec(
      options.sandboxName,
      ["python3", "-c", DIRECT_BYPASS_PROBE_CODE, NETNS_PROXY_HOST, String(port)],
      {
        artifactName: "exact-main-direct-tcp-udp-bypass-denied",
        env: sandboxAccessEnv(),
        timeoutMs: 30_000,
      },
    );
    expectExitZero(probe, "deny direct IPv4 TCP and UDP bypass to controlled listeners");
    const parsed: unknown = JSON.parse(probe.stdout);
    if (!isRecord(parsed)) throw new Error("direct bypass probe must return a JSON object");
    return parsed;
  } finally {
    await cleanupListener();
  }
}

export async function assertExactMainPolicyNftAndIdentityContracts(options: {
  artifacts: ArtifactSink;
  cleanup: CleanupRegistry;
  host: HostCliClient;
  mcpUrl: string;
  sandbox: SandboxClient;
  sandboxName: string;
}): Promise<void> {
  if (process.env.NEMOCLAW_OPENSHELL_EXACT_MAIN_PROOF !== "1") return;

  const base = await options.sandbox.openshell(["policy", "get", "--base", options.sandboxName], {
    artifactName: "exact-main-policy-get-base-before-contract",
    env: sandboxAccessEnv(),
    timeoutMs: POLICY_TIMEOUT_MS,
  });
  expectExitZero(base, "capture exact-main base policy");
  const basePolicyYaml = parseOpenShellPolicy(base.stdout).yamlBody;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-exact-main-policy-"));
  await fs.chmod(tempDir, 0o700);
  const basePolicyPath = path.join(tempDir, "base.yaml");
  const identityPolicyPath = path.join(tempDir, "identity.yaml");
  await fs.writeFile(basePolicyPath, basePolicyYaml, { encoding: "utf8", mode: 0o600 });
  await fs.writeFile(identityPolicyPath, buildIdentityPolicy(basePolicyYaml, options.mcpUrl), {
    encoding: "utf8",
    mode: 0o600,
  });
  let removeTemp = true;
  const cleanupTemp = async () => {
    if (!removeTemp) return;
    await fs.rm(tempDir, { force: true, recursive: true });
    removeTemp = false;
  };
  options.cleanup.add("remove exact-main policy proof temp files", cleanupTemp);

  let restoreRequired = false;
  const restorePolicy = async () => {
    if (!restoreRequired) return;
    const restored = await options.sandbox.openshell(
      ["policy", "set", "--policy", basePolicyPath, "--wait", options.sandboxName],
      {
        artifactName: "exact-main-policy-restore",
        env: sandboxAccessEnv(),
        timeoutMs: POLICY_TIMEOUT_MS,
      },
    );
    expectExitZero(restored, "restore exact-main base policy");
    const verify = await options.sandbox.openshell(
      ["policy", "get", "--base", options.sandboxName],
      {
        artifactName: "exact-main-policy-restore-verify",
        env: sandboxAccessEnv(),
        timeoutMs: POLICY_TIMEOUT_MS,
      },
    );
    expectExitZero(verify, "verify exact-main base policy restoration");
    expect(parseOpenShellPolicy(verify.stdout).yamlBody).not.toContain(EXACT_MAIN_POLICY_KEY);
    restoreRequired = false;
  };
  options.cleanup.add("restore exact-main base policy", restorePolicy);

  try {
    const before = await readPolicyStatus(
      options.sandbox,
      options.sandboxName,
      [],
      "exact-main-policy-effective-before-mutation",
    );
    restoreRequired = true;
    const apply = await options.sandbox.openshell(
      ["policy", "set", "--policy", identityPolicyPath, "--wait", options.sandboxName],
      {
        artifactName: "exact-main-policy-hot-update",
        env: sandboxAccessEnv(),
        timeoutMs: POLICY_TIMEOUT_MS,
      },
    );
    expectExitZero(apply, "apply exact-main live-exe identity policy");
    const effective = await readPolicyStatus(
      options.sandbox,
      options.sandboxName,
      [],
      "exact-main-policy-effective-after-hot-update",
    );
    expect(effective.version).toBeGreaterThan(before.version);
    expect(effective.activeVersion).toBe(effective.version);
    expect(effective.status).toBe("effective");
    expect(effective.policySource).toBe("sandbox");
    const revision = await readPolicyStatus(
      options.sandbox,
      options.sandboxName,
      ["--rev", String(effective.version)],
      "exact-main-policy-revision-after-hot-update",
    );
    expect(revision).toMatchObject({
      activeVersion: effective.version,
      hash: effective.hash,
      sandbox: options.sandboxName,
      status: "loaded",
      version: effective.version,
    });

    const containerId = await findSandboxContainer(
      options.host,
      options.sandboxName,
      "exact-main-sandbox-container-before-restart",
    );
    const beforeRestartNft = await inspectNftRules(
      options.host,
      containerId,
      "exact-main-nft-rules-before-restart",
    );
    const restart = await options.host.command("docker", ["restart", containerId], {
      artifactName: "exact-main-sandbox-container-restart",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: POLICY_TIMEOUT_MS,
    });
    expectExitZero(restart, "restart exact-main OpenShell sandbox container");
    const restartedContainerId = await findSandboxContainer(
      options.host,
      options.sandboxName,
      "exact-main-sandbox-container-after-restart",
    );
    expect(restartedContainerId).toBe(containerId);
    const restartedPolicy = await waitForRestartedPolicy(
      options.sandbox,
      options.sandboxName,
      effective,
    );
    const acknowledgement = await waitForInitialPolicyAcknowledgement(
      options.sandbox,
      options.sandboxName,
      effective.version,
    );
    const afterRestartNft = await inspectNftRules(
      options.host,
      restartedContainerId,
      "exact-main-nft-rules-after-restart",
    );
    const bypass = await assertDirectBypassDenied({
      cleanup: options.cleanup,
      containerId: restartedContainerId,
      host: options.host,
      sandbox: options.sandbox,
      sandboxName: options.sandboxName,
      version: effective.version,
    });

    const liveExe = await options.sandbox.execShell(
      options.sandboxName,
      trustedSandboxShellScript(buildExactMainLiveExeIdentityScript(options.mcpUrl)),
      {
        artifactName: "exact-main-live-proc-exe-identity",
        env: sandboxAccessEnv(),
        timeoutMs: POLICY_TIMEOUT_MS,
      },
    );
    expectExitZero(liveExe, "prove live /proc/<pid>/exe identity across on-disk replacement");
    expect(liveExe.stdout).toContain("NEMOCLAW_LIVE_EXE_OLD_FIRST=200");
    expect(liveExe.stdout).toContain("NEMOCLAW_LIVE_EXE_OLD_SECOND=200");
    expect(liveExe.stdout).toContain("NEMOCLAW_LIVE_EXE_NEW=403");
    expect(liveExe.stdout).toMatch(/NEMOCLAW_LIVE_EXE_OLD_LINK=.*live-bash \(deleted\)/u);

    await options.artifacts.writeJson("exact-main-policy-nft-identity-summary.json", {
      acknowledgement,
      bypass,
      nftAfterRestart: afterRestartNft.inspection,
      nftBeforeRestart: beforeRestartNft.inspection,
      policyAfterRestart: restartedPolicy,
      policyHotUpdate: { effective, revision },
    });
  } finally {
    try {
      await restorePolicy();
    } finally {
      await cleanupTemp();
    }
  }
}

export async function assertExactMainMcpLogPrivacy(options: {
  argumentCanaries: string[];
  artifacts: ArtifactSink;
  expectedTool: string;
  sandbox: SandboxClient;
  sandboxName: string;
}): Promise<void> {
  if (process.env.NEMOCLAW_OPENSHELL_EXACT_MAIN_PROOF !== "1") return;
  const logs = await options.sandbox.openshell(
    ["logs", options.sandboxName, "-n", "4000", "--since", "10m", "--source", "sandbox"],
    {
      artifactName: "exact-main-mcp-policy-logs",
      env: sandboxAccessEnv(),
      redactionValues: options.argumentCanaries,
      timeoutMs: 30_000,
    },
  );
  expectExitZero(logs, "read exact-main MCP policy logs");
  const fullLogs = logs.stdout;
  for (const canary of options.argumentCanaries) {
    expect(fullLogs).not.toContain(canary);
  }
  expect(fullLogs).not.toContain("[REDACTED]");
  expect(fullLogs).not.toMatch(/\barguments\b["']?\s*[:=]/iu);

  const jsonRpcLines = fullLogs
    .split(/\r?\n/u)
    .filter((line) => line.includes("JSONRPC_L7_REQUEST"));
  const toolLines = jsonRpcLines.filter(
    (line) =>
      line.includes("decision=allow") &&
      line.includes("rule_methods=tools/call") &&
      line.includes(`tools=${options.expectedTool}`),
  );
  expect(toolLines, jsonRpcLines.join("\n")).not.toHaveLength(0);
  await options.artifacts.writeText(
    "exact-main-mcp-tool-name-policy-logs.txt",
    `${jsonRpcLines.join("\n")}\n`,
  );
}
