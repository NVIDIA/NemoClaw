// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ArtifactSink } from "./artifacts.ts";
import { artifactLabel, assertExitZero } from "./clients/command.ts";
import {
  type SandboxClient,
  type TrustedSandboxShellScript,
  trustedSandboxShellScript,
} from "./clients/sandbox.ts";
import type { ShellProbeRunOptions } from "./shell-probe.ts";

const HERMES_ROUTING_TOPOLOGY_PROBE = String.raw`
import json
import os
from pathlib import Path
import sys

proc_root = Path(sys.argv[1])
self_pid = os.getpid()


def read_bytes(path):
    try:
        return path.read_bytes()
    except (FileNotFoundError, ProcessLookupError):
        return None
    except PermissionError as error:
        raise RuntimeError(f"permission denied reading process metadata: {path}") from error


def read_status(path):
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except (FileNotFoundError, ProcessLookupError):
        return None
    except PermissionError as error:
        raise RuntimeError(f"permission denied reading process metadata: {path}") from error
    fields = {}
    for line in lines:
        key, separator, value = line.partition(":")
        if separator:
            fields[key] = value.strip()
    try:
        return {
            "ppid": int(fields["PPid"]),
            "uid": int(fields["Uid"].split()[0]),
        }
    except (KeyError, IndexError, ValueError):
        return None


def invocation(argv):
    if not argv:
        return "", []
    program = Path(argv[0]).name
    rest = argv[1:]
    if program.startswith("python") and rest:
        if rest[0] == "-m" and len(rest) >= 2:
            return rest[1], rest[2:]
        if not rest[0].startswith("-"):
            return Path(rest[0]).name, rest[1:]
    return program, rest


def normalized_program(program):
    return program.lower().replace("_", "-").replace(".", "-")


def is_hermes_gateway(program, args):
    if normalized_program(program) not in {"hermes", "hermes-real"}:
        return False
    return any(args[index : index + 2] == ["gateway", "run"] for index in range(len(args) - 1))


def is_nemo_relay_sidecar(program):
    return normalized_program(program) in {"nemo-relay", "nemo-relay-cli"}


def is_switchyard_sidecar(program, args):
    normalized = normalized_program(program)
    return normalized in {"switchyard-server", "switchyard-server-cli"} or (
        normalized == "switchyard" and bool(args) and args[0] == "server"
    )


gateways = []
nemo_relay_pids = []
switchyard_server_pids = []

for process_dir in sorted(
    (entry for entry in proc_root.iterdir() if entry.name.isdigit()),
    key=lambda entry: int(entry.name),
):
    pid = int(process_dir.name)
    if pid == self_pid:
        continue
    raw_cmdline = read_bytes(process_dir / "cmdline")
    status = read_status(process_dir / "status")
    if raw_cmdline is None or status is None:
        continue
    argv = [part.decode("utf-8", errors="surrogateescape") for part in raw_cmdline.split(b"\0") if part]
    program, args = invocation(argv)
    if is_hermes_gateway(program, args):
        gateways.append(
            {
                "pid": pid,
                "ppid": status["ppid"],
                "uid": status["uid"],
            }
        )
    if is_nemo_relay_sidecar(program):
        nemo_relay_pids.append(pid)
    if is_switchyard_sidecar(program, args):
        switchyard_server_pids.append(pid)

sidecar_pids = sorted(set(nemo_relay_pids + switchyard_server_pids))
payload = {
    "schema_version": 1,
    "gateway_processes": gateways,
    "sidecars": {
        "nemo_relay_pids": nemo_relay_pids,
        "switchyard_server_pids": switchyard_server_pids,
        "total": len(sidecar_pids),
    },
}
print(json.dumps(payload, separators=(",", ":"), sort_keys=True))
`.trim();

export interface HermesRoutingGatewayProcess {
  readonly pid: number;
  readonly ppid: number;
  readonly uid: number;
}

export interface HermesRoutingTopology {
  readonly schema_version: 1;
  readonly gateway_processes: readonly HermesRoutingGatewayProcess[];
  readonly sidecars: {
    readonly nemo_relay_pids: readonly number[];
    readonly switchyard_server_pids: readonly number[];
    readonly total: number;
  };
}

export interface CaptureHermesRoutingTopologyOptions {
  readonly artifactName: string;
  readonly artifacts: ArtifactSink;
  readonly env?: NodeJS.ProcessEnv;
  readonly sandbox: SandboxClient;
  readonly sandboxName: string;
  readonly timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Hermes routing topology ${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function parsePidList(value: unknown, label: string): number[] {
  if (!Array.isArray(value)) {
    throw new Error(`Hermes routing topology ${label} must be an array`);
  }
  const pids = value.map((pid, index) => parseNonNegativeInteger(pid, `${label}[${index}]`));
  if (new Set(pids).size !== pids.length) {
    throw new Error(`Hermes routing topology ${label} must not contain duplicate PIDs`);
  }
  return pids;
}

function parseGatewayProcess(value: unknown, index: number): HermesRoutingGatewayProcess {
  if (!isRecord(value)) {
    throw new Error(`Hermes routing topology gateway_processes[${index}] must be an object`);
  }
  return {
    pid: parseNonNegativeInteger(value.pid, `gateway_processes[${index}].pid`),
    ppid: parseNonNegativeInteger(value.ppid, `gateway_processes[${index}].ppid`),
    uid: parseNonNegativeInteger(value.uid, `gateway_processes[${index}].uid`),
  };
}

export function buildHermesRoutingTopologyProbeScript(
  procRoot = "/proc",
): TrustedSandboxShellScript {
  if (procRoot.length === 0 || procRoot.includes("\0")) {
    throw new Error("Hermes routing topology proc root must be nonempty and contain no NUL bytes");
  }
  const encodedProbe = Buffer.from(HERMES_ROUTING_TOPOLOGY_PROBE, "utf8").toString("base64");
  const encodedRoot = Buffer.from(procRoot, "utf8").toString("base64");
  return trustedSandboxShellScript(
    `python3 -I -c 'import base64,sys; probe=base64.b64decode(sys.argv[1]); sys.argv=[sys.argv[0],base64.b64decode(sys.argv[2]).decode("utf-8")]; exec(compile(probe, "<hermes-routing-topology>", "exec"))' ${encodedProbe} ${encodedRoot}`,
  );
}

export function parseHermesRoutingTopology(text: string): HermesRoutingTopology {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Hermes routing topology output is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!isRecord(value)) {
    throw new Error("Hermes routing topology output must be an object");
  }
  if (value.schema_version !== 1) {
    throw new Error("Hermes routing topology schema_version must be 1");
  }
  if (!Array.isArray(value.gateway_processes)) {
    throw new Error("Hermes routing topology gateway_processes must be an array");
  }
  const gatewayProcesses = value.gateway_processes.map(parseGatewayProcess);
  if (new Set(gatewayProcesses.map(({ pid }) => pid)).size !== gatewayProcesses.length) {
    throw new Error("Hermes routing topology gateway_processes must not contain duplicate PIDs");
  }
  if (!isRecord(value.sidecars)) {
    throw new Error("Hermes routing topology sidecars must be an object");
  }
  const nemoRelayPids = parsePidList(value.sidecars.nemo_relay_pids, "sidecars.nemo_relay_pids");
  const switchyardServerPids = parsePidList(
    value.sidecars.switchyard_server_pids,
    "sidecars.switchyard_server_pids",
  );
  const total = parseNonNegativeInteger(value.sidecars.total, "sidecars.total");
  const uniqueSidecarCount = new Set([...nemoRelayPids, ...switchyardServerPids]).size;
  if (total !== uniqueSidecarCount) {
    throw new Error(
      `Hermes routing topology sidecars.total ${total} does not match observed process count ${uniqueSidecarCount}`,
    );
  }
  return {
    schema_version: 1,
    gateway_processes: gatewayProcesses,
    sidecars: {
      nemo_relay_pids: nemoRelayPids,
      switchyard_server_pids: switchyardServerPids,
      total,
    },
  };
}

export function assertHermesHasNoRoutingSidecars(
  topology: HermesRoutingTopology,
  expectedGatewayPid?: number,
): HermesRoutingGatewayProcess {
  if (topology.gateway_processes.length !== 1) {
    throw new Error(
      `expected exactly one Hermes gateway process, observed ${topology.gateway_processes.length}`,
    );
  }
  const gateway = topology.gateway_processes[0]!;
  if (expectedGatewayPid !== undefined && gateway.pid !== expectedGatewayPid) {
    throw new Error(
      `expected Hermes gateway PID ${expectedGatewayPid}, observed routing topology PID ${gateway.pid}`,
    );
  }
  if (topology.sidecars.total !== 0) {
    throw new Error(
      `expected zero standalone NeMo Relay/Switchyard sidecars, observed ${topology.sidecars.total}`,
    );
  }
  return gateway;
}

export async function captureHermesRoutingTopology(
  options: CaptureHermesRoutingTopologyOptions,
): Promise<HermesRoutingTopology> {
  const result = await options.sandbox.execShell(
    options.sandboxName,
    buildHermesRoutingTopologyProbeScript(),
    {
      artifactName: options.artifactName,
      env: options.env,
      timeoutMs: options.timeoutMs ?? 30_000,
    } satisfies ShellProbeRunOptions,
  );
  assertExitZero(result, `capture Hermes routing topology for ${options.sandboxName}`);
  const artifactBase = `routing-topology/${artifactLabel(options.artifactName)}`;
  await options.artifacts.writeText(`${artifactBase}.raw.txt`, result.stdout);
  const topology = parseHermesRoutingTopology(result.stdout.trim());
  await options.artifacts.writeJson(`${artifactBase}.json`, topology);
  return topology;
}
