// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { privilegedSandboxExecArgv } from "../../../src/lib/sandbox/privileged-exec.ts";
import type { ArtifactSink } from "../fixtures/artifacts.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { expect } from "../fixtures/e2e-test.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import { stripAnsi } from "./json-envelope.ts";

type RestartAgent = "hermes" | "openclaw";
type ShieldsPosture = "DOWN" | "UP";

type ContainerState = {
  readonly created: string;
  readonly exitCode: number;
  readonly finishedAt: string;
  readonly health: string;
  readonly id: string;
  readonly image: string;
  readonly name: string;
  readonly pid: number;
  readonly restarting: boolean;
  readonly running: boolean;
  readonly startedAt: string;
  readonly status: string;
};

type FileEvidence = {
  readonly exists: boolean;
  readonly gid?: number;
  readonly kind?: "directory" | "other" | "regular" | "symlink";
  readonly mode?: string;
  readonly nlink?: number;
  readonly path: string;
  readonly sha256?: string;
  readonly uid?: number;
};

type ProcessIdentity = {
  readonly exists: boolean;
  readonly namespaceInode?: number;
  readonly parentPid?: number;
  readonly pid: number;
  readonly startTime?: string;
  readonly state?: string;
  readonly uids?: readonly number[];
};

type ReadinessMarker = FileEvidence & {
  readonly identity?: {
    readonly namespaceInode: number;
    readonly pid: number;
    readonly startTime: string;
    readonly version: number;
  };
  readonly valid: boolean;
};

type ManagedControlEvidence = {
  readonly disposition: "already-running";
  readonly exitCode: number;
  readonly newPid: number;
  readonly nonceSha256: string;
  readonly oldPid: number;
  readonly phase: "complete";
  readonly valid: true;
  readonly version: "v1";
};

type ManagedProcessChainEvidence = {
  readonly gateway: ProcessIdentity;
  readonly supervisor: ProcessIdentity;
};

type RuntimeEvidence = {
  readonly files: readonly FileEvidence[];
  readonly pid1: ProcessIdentity;
  readonly readiness: readonly ReadinessMarker[];
  readonly runDirectory: FileEvidence;
};

type HostStateEvidence = {
  readonly configurationSealHash: string;
  readonly exists: true;
  readonly fileHashes: Record<string, string>;
  readonly gid: number;
  readonly mode: string;
  readonly policySnapshotHash: string | null;
  readonly shieldsDown: boolean;
  readonly stateFileHash: string;
  readonly uid: number;
};

type RegistryEvidence = {
  readonly agent: unknown;
  readonly entryHash: string;
  readonly inferenceHash: string;
  readonly model: unknown;
  readonly preferredInferenceApi: unknown;
  readonly provider: unknown;
};

type StageEvidence = {
  readonly container: ContainerState;
  readonly forwardList: string;
  readonly openshellExitCode: number | null;
  readonly openshellPhase: string | null;
  readonly openshellSandbox: string;
  readonly registry: RegistryEvidence;
  readonly runtime: RuntimeEvidence | null;
  readonly shields: HostStateEvidence;
  readonly stage: "after" | "before" | "stopped";
};

export type ShieldsRestartRecoveryOptions = {
  readonly agent: RestartAgent;
  readonly artifactPrefix: string;
  readonly artifacts: ArtifactSink;
  readonly configPaths: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly host: HostCliClient;
  readonly posture: ShieldsPosture;
  readonly posturePaths: readonly string[];
  readonly readShieldsStatus: (artifactName: string) => Promise<ShellProbeResult>;
  readonly redactionValues: readonly string[];
  readonly requiredForwards: readonly {
    readonly path: string;
    readonly port: number;
  }[];
  readonly sandboxName: string;
  readonly workspaceMarkerPath: string;
};

const RUNTIME_EVIDENCE_SCRIPT = String.raw`
import hashlib
import json
import os
import re
import stat
import sys

agent = sys.argv[1]
workspace_marker = sys.argv[2]
config_paths = json.loads(sys.argv[3])
posture_paths = json.loads(sys.argv[4])
max_file_bytes = 64 * 1024 * 1024

def kind(mode):
    if stat.S_ISREG(mode):
        return "regular"
    if stat.S_ISDIR(mode):
        return "directory"
    if stat.S_ISLNK(mode):
        return "symlink"
    return "other"

def metadata(path):
    try:
        current = os.lstat(path)
    except FileNotFoundError:
        return {"path": path, "exists": False}
    return {
        "path": path,
        "exists": True,
        "kind": kind(current.st_mode),
        "mode": format(stat.S_IMODE(current.st_mode), "04o"),
        "uid": current.st_uid,
        "gid": current.st_gid,
        "nlink": current.st_nlink,
    }

def read_regular(path, limit=max_file_bytes):
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            raise RuntimeError(f"unsafe regular-file evidence path: {path}")
        chunks = []
        total = 0
        while True:
            chunk = os.read(descriptor, min(65536, limit + 1 - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
            if total > limit:
                raise RuntimeError(f"evidence file exceeds limit: {path}")
        after = os.fstat(descriptor)
        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (
            after.st_dev,
            after.st_ino,
            after.st_size,
            after.st_mtime_ns,
        ):
            raise RuntimeError(f"evidence file changed while reading: {path}")
        return b"".join(chunks), before
    finally:
        os.close(descriptor)

def file_evidence(path):
    record = metadata(path)
    if not record["exists"] or record.get("kind") != "regular":
        return record
    raw, current = read_regular(path)
    record.update({
        "mode": format(stat.S_IMODE(current.st_mode), "04o"),
        "uid": current.st_uid,
        "gid": current.st_gid,
        "nlink": current.st_nlink,
        "sha256": hashlib.sha256(raw).hexdigest(),
    })
    return record

def proc_identity(pid):
    base = f"/proc/{pid}"
    try:
        raw_stat = open(f"{base}/stat", "r", encoding="ascii").read().strip()
        suffix = raw_stat.rsplit(") ", 1)[1].split()
        status = open(f"{base}/status", "r", encoding="ascii").read().splitlines()
        uid_line = next(line for line in status if line.startswith("Uid:"))
        uids = [int(value) for value in uid_line.split()[1:5]]
        return {
            "pid": pid,
            "exists": True,
            "parentPid": int(suffix[1]),
            "state": suffix[0],
            "startTime": suffix[19],
            "namespaceInode": os.stat(f"{base}/ns/pid").st_ino,
            "uids": uids,
        }
    except (FileNotFoundError, IndexError, StopIteration, ValueError):
        return {"pid": pid, "exists": False}

pid1 = proc_identity(1)
if not pid1.get("exists"):
    raise RuntimeError("PID 1 identity is unavailable")

def marker(path):
    record = file_evidence(path)
    record["valid"] = False
    if not record.get("exists") or record.get("kind") != "regular":
        return record
    raw, _current = read_regular(path, 4096)
    try:
        if agent == "openclaw":
            payload = json.loads(raw.decode("ascii"))
            identity = {
                "version": payload.get("version"),
                "pid": payload.get("pid"),
                "startTime": str(payload.get("pidStartTime", "")),
                "namespaceInode": payload.get("pidNamespaceInode"),
            }
        else:
            match = re.fullmatch(rb"v2 ([0-9]+) ([0-9]+)\n", raw)
            if match is None:
                return record
            identity = {
                "version": 2,
                "pid": 1,
                "startTime": match.group(1).decode("ascii"),
                "namespaceInode": int(match.group(2), 10),
            }
    except (UnicodeDecodeError, ValueError, json.JSONDecodeError):
        return record
    record["identity"] = identity
    record["valid"] = bool(
        record.get("mode") == "0600"
        and record.get("uid") == 0
        and record.get("gid") == 0
        and record.get("nlink") == 1
        and identity == {
            "version": 2,
            "pid": 1,
            "startTime": pid1["startTime"],
            "namespaceInode": pid1["namespaceInode"],
        }
    )
    return record

marker_paths = (
    [
        "/run/nemoclaw/openclaw-config-ready-v1.capability.json",
        "/run/nemoclaw/openclaw-config-ready.json",
    ]
    if agent == "openclaw"
    else ["/run/nemoclaw/hermes-startup-ready"]
)
all_paths = list(dict.fromkeys(config_paths + posture_paths + [workspace_marker]))
print(json.dumps({
    "pid1": pid1,
    "runDirectory": metadata("/run/nemoclaw"),
    "readiness": [marker(item) for item in marker_paths],
    "files": [file_evidence(item) for item in all_paths],
}, sort_keys=True, separators=(",", ":")))
`;

const MANAGED_PROCESS_CHAIN_SCRIPT = String.raw`
import json
import os
import sys

def proc_identity(pid):
    base = f"/proc/{pid}"
    try:
        raw_stat = open(f"{base}/stat", "r", encoding="ascii").read().strip()
        suffix = raw_stat.rsplit(") ", 1)[1].split()
        status = open(f"{base}/status", "r", encoding="ascii").read().splitlines()
        uid_line = next(line for line in status if line.startswith("Uid:"))
        return {
            "pid": pid,
            "exists": True,
            "parentPid": int(suffix[1]),
            "state": suffix[0],
            "startTime": suffix[19],
            "namespaceInode": os.stat(f"{base}/ns/pid").st_ino,
            "uids": [int(value) for value in uid_line.split()[1:5]],
        }
    except (FileNotFoundError, IndexError, StopIteration, ValueError):
        return {"pid": pid, "exists": False}

gateway = proc_identity(int(sys.argv[1], 10))
supervisor = proc_identity(gateway.get("parentPid", 0))
print(json.dumps({"gateway": gateway, "supervisor": supervisor}, sort_keys=True, separators=(",", ":")))
`;

const RESTART_DIAGNOSTICS_SCRIPT = String.raw`
set +e
sandbox_name="$1"

redact_stream() {
  LC_ALL=C tr -d '\000-\010\013-\037\177' | sed -E \
    -e 's/(nvapi-|sk-)[[:alnum:]_.-]+/<redacted>/g' \
    -e 's/(Bearer[[:space:]]+)[[:alnum:]_.-]+/\1<redacted>/g' \
    -e 's/(API_SERVER_KEY=)[^[:space:]]+/\1<redacted>/g' \
    -e 's/(COMPATIBLE_API_KEY=)[^[:space:]]+/\1<redacted>/g' \
    -e 's/([[:alnum:]_]*(KEY|TOKEN|SECRET|PASSWORD)=)[^[:space:]]+/\1<redacted>/gI'
}

printf '%s\n' '== OpenShell sandbox state =='
openshell sandbox get "$sandbox_name" 2>&1 | redact_stream
printf '%s\n' '== OpenShell phase history checkpoint: forwards =='
openshell forward list 2>&1 | redact_stream
printf '%s\n' '== OpenShell gateway service =='
systemctl --user status nemoclaw-openshell-gateway --no-pager -l 2>&1 | redact_stream
printf '%s\n' '== OpenShell gateway journal =='
journalctl --user -u nemoclaw-openshell-gateway -n 120 --no-pager 2>&1 | redact_stream

container_ids="$(docker ps -aq --no-trunc \
  --filter label=openshell.ai/managed-by=openshell \
  --filter "label=openshell.ai/sandbox-name=$sandbox_name" \
  --filter label=openshell.ai/sandbox-workspace=default)"
printf '%s\n' '== matching containers =='
if [ -z "$container_ids" ]; then
  printf '%s\n' 'none'
fi
for container_id in $container_ids; do
  docker inspect --format '{{.Id}} {{.Name}} {{.Created}} {{.Image}} {{.State.Status}} {{.State.Running}} {{.State.Restarting}} {{.State.Pid}} {{.State.ExitCode}} {{.State.StartedAt}} {{.State.FinishedAt}}' "$container_id" 2>&1
  printf '%s\n' "== container $container_id process tree =="
  docker top "$container_id" -eo pid,ppid,user,stat,comm 2>&1
  printf '%s\n' "== container $container_id runtime logs =="
  docker exec --user 0 "$container_id" sh -lc '
    printf "%s\n" "== PID 1 =="
    ps -o user=,pid=,ppid=,stat=,comm= -p 1 2>&1 || true
    printf "%s\n" "== startup readiness leases =="
    stat -c "%n %F %a %u:%g %h" /run/nemoclaw/*ready* 2>&1 || true
    printf "%s\n" "== startup log =="
    tail -n 240 /tmp/nemoclaw-start.log 2>&1 || true
    printf "%s\n" "== gateway log =="
    tail -n 240 /tmp/gateway.log 2>&1 || true
    printf "%s\n" "== Hermes dashboard log =="
    tail -n 120 /tmp/dashboard.log 2>&1 || true
  ' 2>&1 | redact_stream
  printf '%s\n' "== container $container_id Docker logs =="
  docker logs --tail 240 "$container_id" 2>&1 | redact_stream
done
`;

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function fileMode(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(4, "0");
}

function readStableRegularFile(filePath: string): { raw: Buffer; stats: fs.BigIntStats } {
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > 64n * 1024n * 1024n) {
      throw new Error(`unsafe restart evidence file: ${filePath}`);
    }
    const raw = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    expect(
      [after.dev, after.ino, after.size, after.mtimeNs],
      `restart evidence file changed while reading: ${filePath}`,
    ).toEqual([before.dev, before.ino, before.size, before.mtimeNs]);
    return { raw, stats: after };
  } finally {
    fs.closeSync(descriptor);
  }
}

function readRegistryEvidence(sandboxName: string): RegistryEvidence {
  const registryPath = path.join(process.env.HOME ?? os.homedir(), ".nemoclaw", "sandboxes.json");
  const registry = JSON.parse(readStableRegularFile(registryPath).raw.toString("utf8")) as {
    sandboxes?: Record<string, Record<string, unknown>>;
  };
  const entry = registry.sandboxes?.[sandboxName];
  expect(entry, `registry entry ${sandboxName} is missing`).toBeTruthy();
  if (!entry) throw new Error(`registry entry ${sandboxName} is missing`);
  const inference = {
    compatibleEndpointReasoning: entry.compatibleEndpointReasoning ?? null,
    compatibleEndpointReasoningEffort: entry.compatibleEndpointReasoningEffort ?? null,
    credentialEnv: entry.credentialEnv ?? null,
    endpointSource: entry.endpointSource ?? null,
    endpointUrl: entry.endpointUrl ?? null,
    model: entry.model ?? null,
    nimContainer: entry.nimContainer ?? null,
    preferredInferenceApi: entry.preferredInferenceApi ?? null,
    provider: entry.provider ?? null,
  };
  return {
    agent: entry.agent ?? null,
    entryHash: sha256(stableJson(entry)),
    inferenceHash: sha256(stableJson(inference)),
    model: entry.model ?? null,
    preferredInferenceApi: entry.preferredInferenceApi ?? null,
    provider: entry.provider ?? null,
  };
}

function readShieldsEvidence(sandboxName: string): HostStateEvidence {
  const statePath = path.join(
    process.env.HOME ?? os.homedir(),
    ".nemoclaw",
    "state",
    `shields-${sandboxName}.json`,
  );
  const { raw, stats: pathMetadata } = readStableRegularFile(statePath);
  const state = JSON.parse(raw.toString("utf8")) as {
    fileHashes?: Record<string, string>;
    shieldsDown?: boolean;
    shieldsDownPolicy?: string | null;
    shieldsPolicySnapshotPath?: string | null;
  };
  const fileHashes = Object.fromEntries(
    Object.entries(state.fileHashes ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  );
  return {
    configurationSealHash: sha256(stableJson(fileHashes)),
    exists: true,
    fileHashes,
    gid: Number(pathMetadata.gid),
    mode: fileMode(Number(pathMetadata.mode)),
    policySnapshotHash: state.shieldsPolicySnapshotPath
      ? sha256(readStableRegularFile(state.shieldsPolicySnapshotPath).raw)
      : null,
    shieldsDown: state.shieldsDown === true,
    stateFileHash: sha256(raw),
    uid: Number(pathMetadata.uid),
  };
}

function openshellPhase(value: string): string | null {
  const plain = stripAnsi(value);
  return (
    plain.match(/Phase:\s*([A-Za-z][A-Za-z -]*)/i)?.[1]?.trim() ??
    plain.match(/\b(Ready|Stopped|Provisioning|Running|Failed|Error)\b/i)?.[1] ??
    null
  );
}

async function containerState(
  host: HostCliClient,
  sandboxName: string,
  artifactPrefix: string,
  env: NodeJS.ProcessEnv,
  redactionValues: readonly string[],
): Promise<ContainerState> {
  const list = await host.command(
    "docker",
    [
      "ps",
      "-aq",
      "--no-trunc",
      "--filter",
      "label=openshell.ai/managed-by=openshell",
      "--filter",
      `label=openshell.ai/sandbox-name=${sandboxName}`,
      "--filter",
      "label=openshell.ai/sandbox-workspace=default",
    ],
    {
      artifactName: `${artifactPrefix}-docker-containers`,
      env,
      redactionValues: [...redactionValues],
      timeoutMs: 30_000,
    },
  );
  expect(list.exitCode, resultText(list)).toBe(0);
  const ids = list.stdout.trim().split(/\s+/).filter(Boolean);
  expect(ids, `expected exactly one Docker container for ${sandboxName}`).toHaveLength(1);
  const inspect = await host.command(
    "docker",
    [
      "inspect",
      "--format",
      "{{.Id}}\t{{.Name}}\t{{.Created}}\t{{.Image}}\t{{.State.Status}}\t{{.State.Running}}\t{{.State.Restarting}}\t{{.State.Pid}}\t{{.State.ExitCode}}\t{{.State.StartedAt}}\t{{.State.FinishedAt}}\t{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}",
      ids[0]!,
    ],
    {
      artifactName: `${artifactPrefix}-docker-inspect`,
      env,
      redactionValues: [...redactionValues],
      timeoutMs: 30_000,
    },
  );
  expect(inspect.exitCode, resultText(inspect)).toBe(0);
  const fields = inspect.stdout.trim().split("\t");
  expect(fields, `unexpected Docker inspect evidence: ${inspect.stdout}`).toHaveLength(12);
  return {
    id: fields[0] ?? "",
    name: fields[1] ?? "",
    created: fields[2] ?? "",
    image: fields[3] ?? "",
    status: fields[4] ?? "",
    running: fields[5] === "true",
    restarting: fields[6] === "true",
    pid: Number.parseInt(fields[7] ?? "0", 10),
    exitCode: Number.parseInt(fields[8] ?? "0", 10),
    startedAt: fields[9] ?? "",
    finishedAt: fields[10] ?? "",
    health: fields[11] ?? "",
  };
}

async function runtimeEvidence(
  host: HostCliClient,
  options: ShieldsRestartRecoveryOptions,
  containerId: string,
  artifactPrefix: string,
): Promise<RuntimeEvidence> {
  const result = await host.command(
    "docker",
    [
      "exec",
      "--user",
      "0",
      containerId,
      "python3",
      "-I",
      "-c",
      RUNTIME_EVIDENCE_SCRIPT,
      options.agent,
      options.workspaceMarkerPath,
      JSON.stringify(options.configPaths),
      JSON.stringify(options.posturePaths),
    ],
    {
      artifactName: `${artifactPrefix}-runtime-security-evidence`,
      env: options.env,
      redactionValues: [...options.redactionValues],
      timeoutMs: 60_000,
    },
  );
  expect(result.exitCode, resultText(result)).toBe(0);
  return JSON.parse(result.stdout.trim()) as RuntimeEvidence;
}

async function postStartManagedControlProbe(
  options: ShieldsRestartRecoveryOptions,
  expectedContainerId: string,
): Promise<ManagedControlEvidence> {
  const nonce = randomBytes(32).toString("hex");
  const result = await options.host.command(
    "docker",
    privilegedSandboxExecArgv(
      options.sandboxName,
      ["/usr/local/bin/nemoclaw-gateway-control", "probe", nonce],
      false,
      true,
      expectedContainerId,
    ),
    {
      artifactName: `${options.artifactPrefix}-post-start-managed-control`,
      env: buildAvailabilityProbeEnv(options.env),
      // ShellProbe redacts before returning output. The random nonce is a
      // single-use challenge, not a credential, and must remain visible long
      // enough to authenticate the controller response. Credential values
      // still pass through the canonical fixture redaction boundary.
      redactionValues: [...options.redactionValues],
      timeoutMs: 210_000,
    },
  );
  const match = result
    ? new RegExp(
        `^v1 ${nonce} complete already-running ([1-9][0-9]*) ([1-9][0-9]*)\\nGATEWAY_PID=([1-9][0-9]*)$`,
      ).exec(result.stdout.trim())
    : null;
  const oldPid = Number.parseInt(match?.[1] ?? "0", 10);
  const newPid = Number.parseInt(match?.[2] ?? "0", 10);
  const gatewayPid = Number.parseInt(match?.[3] ?? "0", 10);
  if (
    result.exitCode !== 0 ||
    result.stderr.trim() !== "" ||
    match === null ||
    !Number.isSafeInteger(oldPid) ||
    !Number.isSafeInteger(newPid) ||
    oldPid !== newPid ||
    newPid !== gatewayPid
  ) {
    throw new Error(
      `post-start managed-control authentication failed with exit code ${result.exitCode}; ` +
        `inspect the redacted ${options.artifactPrefix}-post-start-managed-control artifact`,
    );
  }
  const evidence: ManagedControlEvidence = {
    disposition: "already-running",
    exitCode: 0,
    newPid,
    nonceSha256: sha256(nonce),
    oldPid,
    phase: "complete",
    valid: true,
    version: "v1",
  };
  await options.artifacts.writeJson(
    `${options.artifactPrefix}-post-start-managed-control.json`,
    evidence,
  );
  return evidence;
}

async function managedProcessChainEvidence(
  options: ShieldsRestartRecoveryOptions,
  containerId: string,
  gatewayPid: number,
): Promise<ManagedProcessChainEvidence> {
  const result = await options.host.command(
    "docker",
    [
      "exec",
      "--user",
      "0",
      containerId,
      "python3",
      "-I",
      "-c",
      MANAGED_PROCESS_CHAIN_SCRIPT,
      String(gatewayPid),
    ],
    {
      artifactName: `${options.artifactPrefix}-post-start-managed-process-chain`,
      env: options.env,
      redactionValues: [...options.redactionValues],
      timeoutMs: 30_000,
    },
  );
  expect(result.exitCode, resultText(result)).toBe(0);
  return JSON.parse(result.stdout.trim()) as ManagedProcessChainEvidence;
}

async function captureStage(
  options: ShieldsRestartRecoveryOptions,
  stage: StageEvidence["stage"],
  includeRuntime: boolean,
): Promise<StageEvidence> {
  const prefix = `${options.artifactPrefix}-${stage}`;
  const sandboxState = await options.host.command(
    "openshell",
    ["sandbox", "get", options.sandboxName],
    {
      artifactName: `${prefix}-openshell-sandbox`,
      env: options.env,
      redactionValues: [...options.redactionValues],
      timeoutMs: 60_000,
    },
  );
  if (stage !== "stopped") {
    expect(sandboxState.exitCode, resultText(sandboxState)).toBe(0);
  }
  const forwards = await options.host.command("openshell", ["forward", "list"], {
    artifactName: `${prefix}-openshell-forwards`,
    env: options.env,
    redactionValues: [...options.redactionValues],
    timeoutMs: 60_000,
  });
  expect(forwards.exitCode, resultText(forwards)).toBe(0);
  const container = await containerState(
    options.host,
    options.sandboxName,
    prefix,
    options.env,
    options.redactionValues,
  );
  const evidence: StageEvidence = {
    container,
    forwardList: stripAnsi(forwards.stdout),
    openshellExitCode: sandboxState.exitCode,
    openshellPhase: openshellPhase(resultText(sandboxState)),
    openshellSandbox: stripAnsi(resultText(sandboxState)),
    registry: readRegistryEvidence(options.sandboxName),
    runtime: includeRuntime
      ? await runtimeEvidence(options.host, options, container.id, prefix)
      : null,
    shields: readShieldsEvidence(options.sandboxName),
    stage,
  };
  await options.artifacts.writeJson(`${prefix}-restart-evidence.json`, evidence);
  return evidence;
}

async function captureDiagnostics(
  options: ShieldsRestartRecoveryOptions,
  stage: string,
): Promise<void> {
  await options.host.command(
    "bash",
    [
      "-lc",
      RESTART_DIAGNOSTICS_SCRIPT,
      "shields-restart-recovery-diagnostics",
      options.sandboxName,
    ],
    {
      artifactName: `${options.artifactPrefix}-${stage}-diagnostics`,
      captureLimitBytes: 512 * 1024,
      env: options.env,
      redactionValues: [...options.redactionValues],
      timeoutMs: 90_000,
    },
  );
}

function assertImmutableContainer(
  before: ContainerState,
  current: ContainerState,
  stage: string,
): void {
  expect(current.id, `${stage} replaced the Docker container`).toBe(before.id);
  expect(current.name, `${stage} renamed the Docker container`).toBe(before.name);
  expect(current.created, `${stage} changed Docker creation identity`).toBe(before.created);
  expect(current.image, `${stage} changed the Docker image identity`).toBe(before.image);
}

function assertRuntimeReady(
  runtime: RuntimeEvidence,
  agent: RestartAgent,
  requiredFilePaths: ReadonlySet<string>,
  requiredDirectoryPaths: ReadonlySet<string>,
): void {
  expect(runtime.runDirectory).toMatchObject({ exists: true, gid: 0, kind: "directory", uid: 0 });
  expect(runtime.runDirectory.mode).toMatch(
    agent === "openclaw" ? /^07(?:00|11)$/ : /^07(?:11|55)$/,
  );
  expect(runtime.pid1).toMatchObject({ exists: true, parentPid: 0, pid: 1 });
  expect(runtime.pid1.state).not.toBe("Z");
  expect(runtime.pid1.uids).toEqual([0, 0, 0, 0]);
  expect(runtime.readiness).toHaveLength(agent === "openclaw" ? 2 : 1);
  for (const marker of runtime.readiness) {
    expect(marker.valid, `invalid startup readiness lease at ${marker.path}`).toBe(true);
  }
  if (agent === "openclaw") {
    expect(runtime.readiness[0]?.identity).toEqual(runtime.readiness[1]?.identity);
  }
  const files = new Map(runtime.files.map((entry) => [entry.path, entry]));
  for (const filePath of requiredFilePaths) {
    expect(files.get(filePath), `required restart file is missing: ${filePath}`).toMatchObject({
      exists: true,
      kind: "regular",
      nlink: 1,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  }
  for (const directoryPath of requiredDirectoryPaths) {
    expect(
      files.get(directoryPath),
      `required restart directory is missing: ${directoryPath}`,
    ).toMatchObject({ exists: true, kind: "directory" });
  }
}

function assertRestartFileInvariants(
  before: RuntimeEvidence,
  after: RuntimeEvidence,
  options: ShieldsRestartRecoveryOptions,
): void {
  const beforeFiles = new Map(before.files.map((entry) => [entry.path, entry]));
  const afterFiles = new Map(after.files.map((entry) => [entry.path, entry]));
  const sandboxGid = afterFiles.get("/sandbox")?.gid;
  expect([...afterFiles.keys()]).toEqual([...beforeFiles.keys()]);
  const openClawCredentials = "/sandbox/.openclaw/credentials";
  for (const [filePath, beforeFile] of beforeFiles) {
    const afterFile = afterFiles.get(filePath);
    expect(afterFile, `restart evidence disappeared for ${filePath}`).toBeDefined();
    if (
      options.agent === "openclaw" &&
      options.posture === "UP" &&
      filePath === openClawCredentials
    ) {
      expect(beforeFile).toMatchObject({ exists: true, kind: "directory", uid: 0 });
      expect(beforeFile.mode).toMatch(/^07(?:00|10)$/);
      expect(afterFile).toMatchObject({ exists: true, kind: "directory", mode: "0710", uid: 0 });
      expect(sandboxGid, "sandbox group identity is unavailable").toBeGreaterThan(0);
      expect(afterFile?.gid, "OpenClaw credentials traversal must use the sandbox group").toBe(
        sandboxGid,
      );
      continue;
    }
    if (beforeFile.kind === "directory") {
      const { nlink: _beforeNlink, ...stableBefore } = beforeFile;
      const { nlink: _afterNlink, ...stableAfter } = afterFile!;
      expect(stableAfter, `restart changed protected directory state at ${filePath}`).toEqual(
        stableBefore,
      );
    } else {
      expect(afterFile, `restart changed protected state at ${filePath}`).toEqual(beforeFile);
    }
  }
}

function assertManagedControlReady(
  control: ManagedControlEvidence,
  processChain: ManagedProcessChainEvidence,
  pid1: ProcessIdentity,
): void {
  expect(control.valid, "the post-start managed-control probe was not authenticated").toBe(true);
  expect(control).toMatchObject({
    disposition: "already-running",
    exitCode: 0,
    phase: "complete",
    version: "v1",
  });
  expect(control.nonceSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(control.newPid).toBe(control.oldPid);
  expect(processChain.gateway).toMatchObject({ exists: true, pid: control.newPid });
  expect(processChain.gateway.parentPid).toBeGreaterThan(1);
  expect(processChain.gateway.state).not.toBe("Z");
  expect(processChain.gateway.namespaceInode).toBe(pid1.namespaceInode);
  expect(processChain.supervisor).toMatchObject({
    exists: true,
    parentPid: 1,
    pid: processChain.gateway.parentPid,
  });
  expect(processChain.supervisor.state).not.toBe("Z");
  expect(processChain.supervisor.namespaceInode).toBe(pid1.namespaceInode);
  const gatewayUids = processChain.gateway.uids ?? [];
  expect(gatewayUids).toHaveLength(4);
  expect(new Set(gatewayUids).size).toBe(1);
  expect(gatewayUids[0], "managed gateway must run as a non-root identity").toBeGreaterThan(0);
  expect(processChain.supervisor.uids).toEqual(gatewayUids);
}

function assertRequiredForward(forwardList: string, sandboxName: string, port: number): void {
  const rows = forwardList
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter(
      (columns) =>
        columns[0] === sandboxName &&
        columns[2] === String(port) &&
        /^(active|running)$/i.test(columns[4] ?? ""),
    );
  expect(
    rows,
    `required host forward ${sandboxName}:${port} must have one active owner`,
  ).toHaveLength(1);
  const row = rows[0]!;
  expect(row[1], `required host forward ${sandboxName}:${port} must bind loopback`).toMatch(
    /^(?:127\.0\.0\.1|\[?::1\]?)$/,
  );
  expect(Number.parseInt(row[3] ?? "0", 10)).toBeGreaterThan(0);
}

async function assertForwardHealth(
  options: ShieldsRestartRecoveryOptions,
  port: number,
  healthPath: string,
): Promise<void> {
  const health = await options.host.command(
    "curl",
    [
      "-q",
      "--noproxy",
      "*",
      "-sS",
      "-o",
      "/dev/null",
      "-w",
      "%{http_code}",
      "--connect-timeout",
      "3",
      "--max-time",
      "10",
      `http://127.0.0.1:${port}${healthPath}`,
    ],
    {
      artifactName: `${options.artifactPrefix}-after-forward-${port}-health`,
      env: options.env,
      redactionValues: [...options.redactionValues],
      timeoutMs: 30_000,
    },
  );
  expect(health.exitCode, resultText(health)).toBe(0);
  expect(health.stdout.trim(), resultText(health)).toMatch(/^(200|401)$/);
}

async function captureStartReturnBarrier(options: ShieldsRestartRecoveryOptions): Promise<{
  forwardList: string;
  openshellPhase: string | null;
}> {
  const sandboxState = await options.host.command(
    "openshell",
    ["sandbox", "get", options.sandboxName],
    {
      artifactName: `${options.artifactPrefix}-return-barrier-openshell-sandbox`,
      env: options.env,
      redactionValues: [...options.redactionValues],
      timeoutMs: 60_000,
    },
  );
  expect(sandboxState.exitCode, resultText(sandboxState)).toBe(0);
  const phase = openshellPhase(resultText(sandboxState));
  expect(phase, "public start returned before OpenShell reported Ready").toMatch(/^Ready$/i);

  const forwards = await options.host.command("openshell", ["forward", "list"], {
    artifactName: `${options.artifactPrefix}-return-barrier-openshell-forwards`,
    env: options.env,
    redactionValues: [...options.redactionValues],
    timeoutMs: 60_000,
  });
  expect(forwards.exitCode, resultText(forwards)).toBe(0);
  const forwardList = stripAnsi(forwards.stdout);
  for (const required of options.requiredForwards) {
    assertRequiredForward(forwardList, options.sandboxName, required.port);
    await assertForwardHealth(options, required.port, required.path);
  }
  return { forwardList, openshellPhase: phase };
}

function leaseIdentity(runtime: RuntimeEvidence): string {
  return stableJson(runtime.readiness.map((marker) => marker.identity));
}

/**
 * Exercise the public stop/start path and bind success to the preserved
 * container, Shields receipt, config seals, PID 1 lease, a nonce-bound
 * post-start managed-control authentication probe, and required host forwards.
 */
export async function expectProtectedStopStartRecovery(
  options: ShieldsRestartRecoveryOptions,
): Promise<void> {
  const requiredFilePaths = new Set([...options.configPaths, options.workspaceMarkerPath]);
  const requiredDirectoryPaths = new Set(
    options.posturePaths.filter((filePath) => !requiredFilePaths.has(filePath)),
  );
  const before = await captureStage(options, "before", true);
  expect(before.container.running, "sandbox container must run before stop").toBe(true);
  expect(before.container.restarting, "sandbox container must not restart before stop").toBe(false);
  expect(before.openshellPhase).toMatch(/^Ready$/i);
  expect(before.shields.shieldsDown).toBe(options.posture === "DOWN");
  expect(before.shields.fileHashes).not.toEqual({});
  expect(before.shields.mode).toBe("0600");
  for (const [sealedPath, sealedHash] of Object.entries(before.shields.fileHashes)) {
    expect(sealedPath).toMatch(/^\/sandbox\//);
    expect(sealedHash).toMatch(/^[0-9a-f]{64}$/);
  }
  expect(before.registry.agent).toBe(options.agent);
  assertRuntimeReady(before.runtime!, options.agent, requiredFilePaths, requiredDirectoryPaths);
  for (const required of options.requiredForwards) {
    assertRequiredForward(before.forwardList, options.sandboxName, required.port);
  }
  await captureDiagnostics(options, "before-stop");

  const stop = await options.host.nemoclaw([options.sandboxName, "stop"], {
    artifactName: `${options.artifactPrefix}-stop`,
    env: options.env,
    redactionValues: [...options.redactionValues],
    timeoutMs: 5 * 60_000,
  });
  if (stop.exitCode !== 0) {
    await captureDiagnostics(options, "stop-failed");
  }
  expect(stop.exitCode, resultText(stop)).toBe(0);

  const stopped = await captureStage(options, "stopped", false);
  assertImmutableContainer(before.container, stopped.container, "stop");
  expect(stopped.container.running, "public stop left the container running").toBe(false);
  expect(stopped.container.restarting, "public stop left the container restarting").toBe(false);
  expect(stopped.registry).toEqual(before.registry);
  expect(stopped.shields).toEqual(before.shields);
  await captureDiagnostics(options, "after-stop-before-start");

  const start = await options.host.nemoclaw([options.sandboxName, "start"], {
    artifactName: `${options.artifactPrefix}-start`,
    env: options.env,
    redactionValues: [...options.redactionValues],
    timeoutMs: 5 * 60_000,
  });
  if (start.exitCode !== 0) {
    await captureDiagnostics(options, "start-failed");
  }
  expect(start.exitCode, resultText(start)).toBe(0);

  let returnBarrier: Awaited<ReturnType<typeof captureStartReturnBarrier>>;
  let after: StageEvidence;
  try {
    returnBarrier = await captureStartReturnBarrier(options);
    after = await captureStage(options, "after", true);
  } catch (error) {
    await captureDiagnostics(options, "after-start-evidence-failed");
    throw error;
  }

  const status = await options.host.nemoclaw([options.sandboxName, "status"], {
    artifactName: `${options.artifactPrefix}-status`,
    env: options.env,
    redactionValues: [...options.redactionValues],
    timeoutMs: 5 * 60_000,
  });
  expect(status.exitCode, resultText(status)).toBe(0);
  expect(stripAnsi(resultText(status))).toMatch(/Phase:\s*Ready/i);
  const shields = await options.readShieldsStatus(`${options.artifactPrefix}-shields-status`);
  expect(shields.exitCode, resultText(shields)).toBe(0);
  expect(resultText(shields)).toContain(`Shields: ${options.posture}`);

  assertImmutableContainer(before.container, after.container, "start");
  expect(after.container.running, "public start did not leave the container running").toBe(true);
  expect(after.container.restarting, "public start left the container restarting").toBe(false);
  expect(after.container.pid).toBeGreaterThan(1);
  expect(after.container.startedAt).not.toBe(before.container.startedAt);
  expect(after.openshellPhase).toMatch(/^Ready$/i);
  expect(after.registry).toEqual(before.registry);
  expect(after.shields).toEqual(before.shields);
  assertRestartFileInvariants(before.runtime!, after.runtime!, options);
  assertRuntimeReady(after.runtime!, options.agent, requiredFilePaths, requiredDirectoryPaths);
  expect(
    after.runtime!.runDirectory.mode,
    "public start returned without reaching the managed-control runtime boundary",
  ).toBe("0711");
  expect(leaseIdentity(after.runtime!), "restart reused the prior PID 1 readiness lease").not.toBe(
    leaseIdentity(before.runtime!),
  );

  for (const required of options.requiredForwards) {
    assertRequiredForward(after.forwardList, options.sandboxName, required.port);
  }

  let managedControl: ManagedControlEvidence;
  let processChain: ManagedProcessChainEvidence;
  try {
    managedControl = await postStartManagedControlProbe(options, before.container.id);
    processChain = await managedProcessChainEvidence(
      options,
      after.container.id,
      managedControl.newPid,
    );
    assertManagedControlReady(managedControl, processChain, after.runtime!.pid1);
  } catch (error) {
    await captureDiagnostics(options, "post-start-managed-control-failed");
    throw error;
  }
  await captureDiagnostics(options, "after-start");

  await options.artifacts.writeJson(`${options.artifactPrefix}-restart-recovery-summary.json`, {
    agent: options.agent,
    configurationSealHash: after.shields.configurationSealHash,
    containerId: after.container.id,
    publicStartExitCode: start.exitCode,
    postStartManagedControlProbe: {
      disposition: managedControl.disposition,
      newPid: managedControl.newPid,
      nonceSha256: managedControl.nonceSha256,
      oldPid: managedControl.oldPid,
    },
    openshellPhaseHistory: [
      {
        exitCode: before.openshellExitCode,
        phase: before.openshellPhase,
        stage: before.stage,
      },
      {
        exitCode: stopped.openshellExitCode,
        phase: stopped.openshellPhase,
        stage: stopped.stage,
      },
      {
        exitCode: after.openshellExitCode,
        phase: after.openshellPhase,
        stage: after.stage,
      },
    ],
    posture: options.posture,
    readinessLeaseAfterHash: sha256(leaseIdentity(after.runtime!)),
    readinessLeaseBeforeHash: sha256(leaseIdentity(before.runtime!)),
    returnBarrier: {
      forwardListHash: sha256(returnBarrier.forwardList),
      openshellPhase: returnBarrier.openshellPhase,
    },
    registryEntryHash: after.registry.entryHash,
    registryInferenceHash: after.registry.inferenceHash,
    requiredForwards: options.requiredForwards.map(({ port }) => port),
    shieldsStateHash: after.shields.stateFileHash,
    workspaceMarkerHash: after.runtime!.files.find(
      (entry) => entry.path === options.workspaceMarkerPath,
    )?.sha256,
  });
}
