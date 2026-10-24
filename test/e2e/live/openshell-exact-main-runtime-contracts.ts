// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { createServer } from "node:net";
import { createSocket } from "node:dgram";

import YAML from "yaml";

import { shellQuote } from "../../../src/lib/core/shell-quote";
import { setPolicyDocument } from "../../../src/lib/policy";
import { parseOpenShellPolicy } from "../../../src/lib/adapters/openshell/policy-boundary";
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

import { exactMainDockerContainerId } from "./openshell-exact-main-exec.ts";

const EXACT_MAIN_POLICY_KEY = "exact_main_live_exe_identity";
const LIVE_EXE_PATH = "/tmp/nemoclaw-exact-main-live-exe/live-python";
const CONTROLLED_HOST = "host.openshell.internal";
const POLICY_TIMEOUT_MS = 120_000;
const SANDBOX_CONTAINER_LABEL = "openshell.ai/sandbox-name";

type JsonRecord = Record<string, unknown>;

export interface ExactMainPolicyStatus {
  activeVersion: number;
  configRevision?: string;
  hash: string;
  policySource?: string;
  sandbox: string;
  status: string;
  version: number;
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
  let exactConfigRevision: string | undefined;
  if (configRevision !== undefined) {
    const matches = [...raw.matchAll(/"config_revision"\s*:\s*(0|[1-9][0-9]*)(?=\s*[,}])/gu)];
    if (matches.length !== 1 || matches[0][1] === undefined) {
      throw new Error(
        "exact-main policy config_revision must be one non-negative JSON integer when present",
      );
    }
    exactConfigRevision = matches[0][1];
  }
  if (policySource !== undefined && typeof policySource !== "string") {
    throw new Error("exact-main policy policy_source must be a string when present");
  }
  return {
    activeVersion: requiredInteger(parsed, "active_version"),
    ...(exactConfigRevision === undefined ? {} : { configRevision: exactConfigRevision }),
    hash: requiredString(parsed, "hash"),
    ...(policySource === undefined ? {} : { policySource }),
    sandbox: requiredString(parsed, "sandbox"),
    status: requiredString(parsed, "status"),
    version: requiredInteger(parsed, "version"),
  };
}

export function inspectExactMainIsolation(raw: string, containerId: string): JsonRecord {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length !== 1 || !isRecord(parsed[0])) {
    throw new Error("expected exactly one workload inspection");
  }
  const container = parsed[0];
  const config = container.HostConfig;
  if (
    container.Id !== containerId ||
    !isRecord(config) ||
    config.NetworkMode !== "none" ||
    !Array.isArray(config.CapDrop) ||
    !config.CapDrop.includes("ALL") ||
    (config.CapAdd !== null && (!Array.isArray(config.CapAdd) || config.CapAdd.length !== 0)) ||
    config.Privileged !== false
  ) {
    throw new Error("workload does not preserve native network/capability isolation");
  }
  return {
    containerId,
    networkMode: config.NetworkMode,
    capDrop: config.CapDrop,
    privileged: false,
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

const LIVE_EXE_CONNECT_SCRIPT = String.raw`import errno
import socket
import sys
import time

host, port = sys.argv[1], int(sys.argv[2])
def connect_status():
    try:
        with socket.create_connection((host, port), timeout=3) as stream:
            stream.sendall(b"NEMOCLAW_IDENTITY_CONTROL")
            return "allowed" if stream.recv(128) == b"NEMOCLAW_IDENTITY_CONTROL" else "invalid-echo"
    except OSError as exc:
        return "EACCES" if exc.errno == errno.EACCES else f"unexpected-{exc.errno}"
def publish(result_path):
    status = "unattempted"
    for _ in range(50):
        status = connect_status()
        if status == "allowed":
            break
        time.sleep(0.1)
    with open(result_path, "w", encoding="utf-8") as output:
        output.write(status)
if len(sys.argv) == 3:
    print(connect_status())
else:
    publish(sys.argv[3])
    with open(sys.argv[5], encoding="utf-8") as trigger:
        trigger.readline()
    publish(sys.argv[4])`;

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
    "python_source=$(command -v python3)",
    '[ -n "$python_source" ]',
    'cp "$python_source" "$live"',
    'chmod 0755 "$live"',
    'first="$root/old-first.status"',
    'second="$root/old-second.status"',
    'trigger="$root/old-second.trigger"',
    'mkfifo "$trigger"',
    `worker_script=${shellQuote(LIVE_EXE_CONNECT_SCRIPT)}`,
    `oneshot_script=${shellQuote(LIVE_EXE_CONNECT_SCRIPT)}`,
    `"$live" -c "$worker_script" ${shellQuote(endpoint.hostname)} ${endpointPort} "$first" "$second" "$trigger" &`,
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
    '[ "$old_first" = allowed ] || { printf \'expected initial live-exe broker connection allowed, got %s\\n\' "$old_first" >&2; exit 1; }',
    'replacement="$root/live-python.next"',
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
    '[ "$old_second" = allowed ] || { printf \'expected retained live-exe broker connection allowed, got %s\\n\' "$old_second" >&2; exit 1; }',
    'wait "$old_pid"',
    'old_pid=""',
    `new_status=$("$live" -c "$oneshot_script" ${shellQuote(endpoint.hostname)} ${endpointPort} | tr -d '\\r\\n')`,
    "printf 'NEMOCLAW_LIVE_EXE_OLD_FIRST=%s\\n' \"$old_first\"",
    "printf 'NEMOCLAW_LIVE_EXE_OLD_SECOND=%s\\n' \"$old_second\"",
    "printf 'NEMOCLAW_LIVE_EXE_NEW=%s\\n' \"$new_status\"",
    "printf 'NEMOCLAW_LIVE_EXE_OLD_LINK=%s\\n' \"$old_exe\"",
    "printf 'NEMOCLAW_LIVE_EXE_OLD_HASH=%s\\n' \"$old_hash\"",
    "printf 'NEMOCLAW_LIVE_EXE_NEW_HASH=%s\\n' \"$new_hash\"",
    '[ "$new_status" = EACCES ] || { printf \'expected replacement live-exe broker EACCES, got %s\\n\' "$new_status" >&2; exit 1; }',
  ].join("\n");
}

async function startControlledListener(cleanup: CleanupRegistry) {
  const observed = { tcp: 0, udp: 0 };
  const tcp = createServer((socket) => {
    observed.tcp += 1;
    socket.setTimeout(3_000, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    socket.on("data", (data) => socket.end(data));
  });
  const udp = createSocket("udp4");
  let closed = false;
  const close = async () => {
    if (closed) return;
    await Promise.all([
      new Promise<void>((resolve, reject) =>
        tcp.close((error) => (error ? reject(error) : resolve())),
      ),
      new Promise<void>((resolve) => udp.close(() => resolve())),
    ]);
    closed = true;
  };
  await new Promise<void>((resolve, reject) => {
    tcp.once("error", reject);
    tcp.listen(0, "127.0.0.1", resolve);
  });
  const address = tcp.address();
  if (!address || typeof address === "string") throw new Error("listener has no TCP address");
  try {
    await new Promise<void>((resolve, reject) => {
      udp.once("error", reject);
      udp.bind(address.port, "127.0.0.1", resolve);
    });
  } catch (error) {
    await new Promise<void>((resolve) => tcp.close(() => resolve()));
    udp.close();
    throw error;
  }
  udp.on("message", (data, peer) => {
    observed.udp += 1;
    udp.send(data, peer.port, peer.address);
  });
  cleanup.add("stop exact-main controlled TCP/UDP listener", close);
  return { port: address.port, observed, close };
}

export const DIRECT_BYPASS_PROBE_CODE = String.raw`import errno
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
denial_errnos = {errno.EACCES}
if tcp_error.get("errno") not in denial_errnos or udp_error.get("errno") not in denial_errnos:
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
      "--filter",
      "label=openshell.ai/isolation-role=sandbox",
      "--format",
      '{{.ID}}\t{{.Names}}\t{{.Label "openshell.ai/sandbox-id"}}\t{{.Label "openshell.ai/sandbox-workspace"}}',
    ],
    { artifactName, env: buildAvailabilityProbeEnv(), timeoutMs: 30_000 },
  );
  expectExitZero(result, `locate OpenShell sandbox container ${sandboxName}`);
  return exactMainDockerContainerId(result.stdout, sandboxName);
}

async function inspectIsolation(
  host: HostCliClient,
  containerId: string,
  artifactName: string,
): Promise<JsonRecord> {
  const result = await host.command(
    "docker",
    [
      "inspect",
      "--format",
      '{"Id":{{json .Id}},"HostConfig":{"NetworkMode":{{json .HostConfig.NetworkMode}},"CapDrop":{{json .HostConfig.CapDrop}},"CapAdd":{{json .HostConfig.CapAdd}},"Privileged":{{json .HostConfig.Privileged}}}}',
      containerId,
    ],
    {
      artifactName,
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
      persistArtifacts: false,
    },
  );
  expectExitZero(result, "inspect exact-main native workload isolation");
  return inspectExactMainIsolation(`[${result.stdout.trim()}]`, containerId);
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

export async function waitForRestartedPolicy(
  sandbox: SandboxClient,
  sandboxName: string,
  expected: ExactMainPolicyStatus,
  expectedRevision: ExactMainPolicyStatus,
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
        revision.hash === expectedRevision.hash &&
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

async function assertDirectBypassDenied(options: {
  host: HostCliClient;
  sandbox: SandboxClient;
  sandboxName: string;
  listener: Awaited<ReturnType<typeof startControlledListener>>;
}): Promise<JsonRecord> {
  const control = () =>
    options.host.command(
      "python3",
      [
        "-c",
        String.raw`import socket, sys
port = int(sys.argv[1])
with socket.create_connection(("127.0.0.1", port), timeout=3) as tcp:
    tcp.sendall(b"host-control")
    assert tcp.recv(128) == b"host-control"
with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as udp:
    udp.settimeout(3)
    udp.sendto(b"host-control", ("127.0.0.1", port))
    assert udp.recv(128) == b"host-control"
`,
        String(options.listener.port),
      ],
      { artifactName: "exact-main-listener-positive-control", timeoutMs: 30_000 },
    );
  expectExitZero(await control(), "controlled TCP/UDP listeners echo before denial probe");
  const before = { ...options.listener.observed };
  const probe = await options.sandbox.exec(
    options.sandboxName,
    ["python3", "-c", DIRECT_BYPASS_PROBE_CODE, CONTROLLED_HOST, String(options.listener.port)],
    {
      artifactName: "exact-main-direct-tcp-udp-bypass-denied",
      env: sandboxAccessEnv(),
      timeoutMs: 30_000,
    },
  );
  expectExitZero(probe, "native broker rejects unauthorized TCP and non-DNS UDP");
  const parsed: unknown = JSON.parse(probe.stdout);
  if (!isRecord(parsed)) throw new Error("direct bypass probe must return a JSON object");
  expect(options.listener.observed).toEqual(before);
  expectExitZero(await control(), "controlled TCP/UDP listeners remain reachable after denial");
  return parsed;
}

export async function assertExactMainPolicyAndIdentityContracts(options: {
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

  const listener = await startControlledListener(options.cleanup);
  const controlledUrl = `http://${CONTROLLED_HOST}:${listener.port}`;
  let restoreRequired = false;
  const restorePolicy = async () => {
    if (!restoreRequired) return;
    expect(
      await setPolicyDocument(options.sandboxName, basePolicyYaml, {
        nonFatal: true,
        operation: "restore the exact-main policy proof",
      }),
      "exact-main-policy-restore",
    ).toBe(true);
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

  let primaryFailure: unknown;
  try {
    const before = await readPolicyStatus(
      options.sandbox,
      options.sandboxName,
      [],
      "exact-main-policy-effective-before-mutation",
    );
    restoreRequired = true;
    expect(
      await setPolicyDocument(
        options.sandboxName,
        buildIdentityPolicy(basePolicyYaml, controlledUrl),
        {
          nonFatal: true,
          operation: "apply the exact-main live-exe identity policy",
        },
      ),
      "exact-main-policy-hot-update",
    ).toBe(true);
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
      sandbox: options.sandboxName,
      status: "loaded",
      version: effective.version,
    });
    // Effective policy includes attached provider rules. Its hash and the
    // stored base revision hash each remain stable across the restart.

    const containerId = await findSandboxContainer(
      options.host,
      options.sandboxName,
      "exact-main-sandbox-container-before-restart",
    );
    const beforeRestartIsolation = await inspectIsolation(
      options.host,
      containerId,
      "exact-main-native-isolation-before-restart",
    );
    // OpenShell treats an unexpected main-process exit as terminal Error.
    // Its lifecycle commands retain the container and wait for Stopped/Ready.
    for (const operation of ["stop", "start"]) {
      const result = await options.sandbox.openshell(["sandbox", operation, options.sandboxName], {
        artifactName: `exact-main-sandbox-container-${operation}`,
        env: sandboxAccessEnv(),
        timeoutMs: POLICY_TIMEOUT_MS,
      });
      expectExitZero(result, `${operation} exact-main OpenShell sandbox container`);
    }
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
      revision,
    );
    const acknowledgement = await waitForInitialPolicyAcknowledgement(
      options.sandbox,
      options.sandboxName,
      effective.version,
    );
    const afterRestartIsolation = await inspectIsolation(
      options.host,
      restartedContainerId,
      "exact-main-native-isolation-after-restart",
    );

    const liveExe = await options.sandbox.execShell(
      options.sandboxName,
      trustedSandboxShellScript(buildExactMainLiveExeIdentityScript(controlledUrl)),
      {
        artifactName: "exact-main-live-proc-exe-identity",
        env: sandboxAccessEnv(),
        timeoutMs: POLICY_TIMEOUT_MS,
      },
    );
    expectExitZero(liveExe, "prove live /proc/<pid>/exe identity across on-disk replacement");
    expect(listener.observed.tcp).toBe(2);
    expect(listener.observed.udp).toBe(0);
    expect(liveExe.stdout).toContain("NEMOCLAW_LIVE_EXE_NEW=EACCES");
    expect(liveExe.stdout).toMatch(/NEMOCLAW_LIVE_EXE_OLD_LINK=.*live-python \(deleted\)/u);

    const bypass = await assertDirectBypassDenied({ ...options, listener });
    await options.artifacts.writeJson("exact-main-policy-native-identity-summary.json", {
      acknowledgement,
      bypass,
      isolationAfterRestart: afterRestartIsolation,
      isolationBeforeRestart: beforeRestartIsolation,
      policyAfterRestart: restartedPolicy,
      policyHotUpdate: { effective, revision },
    });
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    const cleanupResults = await Promise.allSettled([restorePolicy(), listener.close()]);
    const failures = cleanupResults.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length) {
      throw new AggregateError(
        primaryFailure === undefined ? failures : [primaryFailure, ...failures],
        "Exact-main proof cleanup failed",
      );
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
