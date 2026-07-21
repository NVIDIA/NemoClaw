// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { buildVllmSshTransportEnv } from "./vllm-docker-env";
import { DUAL_STATION_VLLM_RUNTIME, type DualStationVllmPlan } from "./vllm-station-cluster";
import { dualStationPinnedSshArgs } from "./vllm-station-ssh-binding";

const MANIFEST_SCHEMA_VERSION = 1;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 256 * 1024;
const SNAPSHOT_AUDIT_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const RSYNC_TIMEOUT_MS = 12 * 60 * 60 * 1000;
const RSYNC_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const LOCAL_STAGING_MIN_HEADROOM_BYTES = 5n * 1024n * 1024n * 1024n;
const MAX_SNAPSHOT_BYTES = 1024 * 1024 * 1024 * 1024;
const SAFE_POSIX_PATH_PATTERN = /^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/;

export interface ModelStagingCommandOptions {
  env: Record<string, string>;
  input?: string;
  timeoutMs: number;
  idleTimeoutMs?: number;
  streamOutput?: boolean;
}

export interface ModelStagingCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
  timedOut?: boolean;
}

export interface DualStationModelStagingDeps {
  runCommand(
    file: string,
    args: readonly string[],
    options: ModelStagingCommandOptions,
  ): Promise<ModelStagingCommandResult>;
  statfs?(
    filePath: string,
  ): Promise<{ bavail: bigint; bsize: bigint }> | { bavail: bigint; bsize: bigint };
}

export type DualStationModelStagingResult =
  | { ok: true; transferred: boolean }
  | { ok: false; reason: string };

interface SnapshotManifest {
  schemaVersion: 1;
  files: Array<{ path: string; size: number; sha256: string }>;
  directories: string[];
  totalBytes: number;
}

interface StagingPaths {
  localModelRoot: string;
  localSnapshot: string;
  peerSnapshot: string;
  peerStaging: string;
}

function appendBounded(current: string, chunk: string, limit: number): string {
  const next = current + chunk;
  return next.length <= limit ? next : next.slice(next.length - limit);
}

function defaultRunCommand(
  file: string,
  args: readonly string[],
  options: ModelStagingCommandOptions,
): Promise<ModelStagingCommandResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(file, [...args], {
        env: options.env,
        shell: false,
        stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      resolve({ status: null, stdout: "", stderr: "", error: (err as Error).message });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let idleTimer: NodeJS.Timeout | undefined;
    const absoluteTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);
    absoluteTimer.unref?.();

    const resetIdleTimer = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      if (options.idleTimeoutMs === undefined) return;
      idleTimer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, options.idleTimeoutMs);
      idleTimer.unref?.();
    };
    resetIdleTimer();

    child.stdout?.on("data", (value: Buffer | string) => {
      const chunk = String(value);
      stdout = appendBounded(stdout, chunk, MAX_MANIFEST_BYTES);
      resetIdleTimer();
      if (options.streamOutput) process.stdout.write(chunk);
    });
    child.stderr?.on("data", (value: Buffer | string) => {
      const chunk = String(value);
      stderr = appendBounded(stderr, chunk, MAX_COMMAND_OUTPUT_BYTES);
      resetIdleTimer();
      if (options.streamOutput) process.stderr.write(chunk);
    });
    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(absoluteTimer);
      if (idleTimer) clearTimeout(idleTimer);
      resolve({ status: null, stdout, stderr, error: err.message, timedOut });
    });
    child.once("close", (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(absoluteTimer);
      if (idleTimer) clearTimeout(idleTimer);
      resolve({ status, stdout, stderr, timedOut });
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(options.input);
  });
}

const defaultDeps: DualStationModelStagingDeps = {
  runCommand: defaultRunCommand,
  statfs(filePath) {
    const stats = fs.statfsSync(filePath, { bigint: true });
    return { bavail: stats.bavail, bsize: stats.bsize };
  },
};

function snapshotPath(home: string): string {
  return path.posix.join(
    home,
    ".cache",
    "huggingface",
    "hub",
    `models--${DUAL_STATION_VLLM_RUNTIME.modelId.replace("/", "--")}`,
    "snapshots",
    DUAL_STATION_VLLM_RUNTIME.modelRevision,
  );
}

function stagingTransactionId(plan: DualStationVllmPlan): string {
  const identity = [
    "nemoclaw-dual-station-model-staging-v1",
    DUAL_STATION_VLLM_RUNTIME.image,
    DUAL_STATION_VLLM_RUNTIME.modelId,
    DUAL_STATION_VLLM_RUNTIME.modelRevision,
    DUAL_STATION_VLLM_RUNTIME.servedModelId,
    String(DUAL_STATION_VLLM_RUNTIME.tensorParallelSize),
    String(DUAL_STATION_VLLM_RUNTIME.pipelineParallelSize),
    String(DUAL_STATION_VLLM_RUNTIME.nodeCount),
    plan.local.gpu.uuid,
    plan.peer.gpu.uuid,
  ].join("\0");
  return createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 32);
}

function stagingPaths(plan: DualStationVllmPlan): StagingPaths {
  for (const [label, home] of [
    ["local", plan.local.home],
    ["peer", plan.peer.home],
  ] as const) {
    if (
      !SAFE_POSIX_PATH_PATTERN.test(home) ||
      path.posix.normalize(home) !== home ||
      home.split("/").some((component) => component === "." || component === "..")
    ) {
      throw new Error(`${label} home is unsafe for model staging`);
    }
  }
  dualStationPinnedSshArgs(plan.peerSshBinding);
  if (
    plan.runtime.modelId !== DUAL_STATION_VLLM_RUNTIME.modelId ||
    plan.runtime.modelRevision !== DUAL_STATION_VLLM_RUNTIME.modelRevision ||
    plan.runtime.image !== DUAL_STATION_VLLM_RUNTIME.image
  ) {
    throw new Error("dual-Station plan does not identify the pinned runtime");
  }

  const localSnapshot = snapshotPath(plan.local.home);
  const peerSnapshot = snapshotPath(plan.peer.home);
  return {
    localModelRoot: path.posix.dirname(path.posix.dirname(localSnapshot)),
    localSnapshot,
    peerSnapshot,
    peerStaging: path.posix.join(
      path.posix.dirname(peerSnapshot),
      `.nemoclaw-staging-${stagingTransactionId(plan)}`,
    ),
  };
}

const LOCAL_MANIFEST_SCRIPT = String.raw`
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys

if len(sys.argv) not in (3, 4):
    raise SystemExit("expected snapshot and model-root paths, plus optional materialized-snapshot path")

snapshot = Path(sys.argv[1])
model_root = Path(sys.argv[2])
materialized_snapshot = Path(sys.argv[3]) if len(sys.argv) == 4 else None
safe_component = re.compile(r"^[A-Za-z0-9._-]+$")
weight_index_name = "model.safetensors.index.json"
max_weight_index_bytes = 64 * 1024 * 1024

def fail(message):
    raise SystemExit(message)

def relative_name(candidate):
    relative = candidate.relative_to(snapshot)
    if not relative.parts or any(not safe_component.fullmatch(part) for part in relative.parts):
        raise SystemExit("snapshot contains an unsafe relative path")
    return relative.as_posix()

def resolved_regular_file(candidate):
    metadata = candidate.lstat()
    resolved = candidate.resolve(strict=True)
    try:
        common = os.path.commonpath((str(canonical_model_root), str(resolved)))
    except (OSError, ValueError):
        raise SystemExit("snapshot file could not be resolved")
    if common != str(canonical_model_root):
        raise SystemExit("snapshot symlink escapes the pinned model cache")
    if not resolved.is_file():
        raise SystemExit("snapshot contains a non-regular file")
    return resolved

def create_materialized_directory(relative):
    if materialized_snapshot is None:
        return
    destination = materialized_snapshot / relative
    try:
        destination.mkdir(mode=0o700)
    except FileExistsError:
        fail("materialized snapshot path changed during audit")

def audit_regular_file(source, relative):
    if not hasattr(os, "O_NOFOLLOW"):
        fail("snapshot audit requires O_NOFOLLOW support")
    source_flags = os.O_RDONLY | os.O_NOFOLLOW
    destination_flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
    digest = hashlib.sha256()
    index_bytes = bytearray() if relative == weight_index_name else None
    size = 0
    try:
        source_handle = os.fdopen(os.open(source, source_flags), "rb")
    except OSError:
        fail("snapshot file changed while it was being opened")
    with source_handle:
        if not stat.S_ISREG(os.fstat(source_handle.fileno()).st_mode):
            fail("snapshot contains a non-regular file")
        destination_handle = None
        if materialized_snapshot is not None:
            destination = materialized_snapshot / relative
            try:
                destination_handle = os.fdopen(
                    os.open(destination, destination_flags, 0o400),
                    "wb",
                )
            except OSError:
                fail("materialized snapshot path changed during audit")
        try:
            for chunk in iter(lambda: source_handle.read(8 * 1024 * 1024), b""):
                size += len(chunk)
                digest.update(chunk)
                if index_bytes is not None:
                    if len(index_bytes) + len(chunk) > max_weight_index_bytes:
                        fail("pinned local weight index exceeds the safety bound")
                    index_bytes.extend(chunk)
                if destination_handle is not None:
                    destination_handle.write(chunk)
            if destination_handle is not None:
                destination_handle.flush()
                os.fsync(destination_handle.fileno())
                os.fchmod(destination_handle.fileno(), 0o400)
        finally:
            if destination_handle is not None:
                destination_handle.close()
    return size, digest.hexdigest(), index_bytes

if snapshot.is_symlink() or not snapshot.is_dir():
    raise SystemExit("pinned local snapshot directory is missing or unsafe")
if model_root.is_symlink() or not model_root.is_dir():
    raise SystemExit("pinned local model cache root is missing or unsafe")
canonical_model_root = model_root.resolve(strict=True)
if materialized_snapshot is not None:
    if os.path.lexists(materialized_snapshot):
        fail("private materialized snapshot path already exists")
    try:
        materialized_snapshot.mkdir(mode=0o700)
    except OSError:
        fail("private materialized snapshot could not be created")

files = []
directories = []
total_bytes = 0
entry_count = 0
weight_index_bytes = None
for current, dirnames, filenames in os.walk(snapshot, topdown=True, followlinks=False):
    current_path = Path(current)
    dirnames.sort()
    filenames.sort()
    for dirname in dirnames:
        directory = current_path / dirname
        relative = relative_name(directory)
        mode = directory.lstat().st_mode
        if stat.S_ISLNK(mode) or not stat.S_ISDIR(mode):
            raise SystemExit("snapshot contains an unsafe directory")
        create_materialized_directory(relative)
        directories.append(relative)
        entry_count += 1
    for filename in filenames:
        candidate = current_path / filename
        relative = relative_name(candidate)
        resolved = resolved_regular_file(candidate)
        size, digest, audited_index_bytes = audit_regular_file(resolved, relative)
        if audited_index_bytes is not None:
            weight_index_bytes = audited_index_bytes
        files.append({"path": relative, "size": size, "sha256": digest})
        total_bytes += size
        entry_count += 1
        if entry_count > 4096 or total_bytes > ${String(MAX_SNAPSHOT_BYTES)}:
            raise SystemExit("snapshot exceeds the staging safety bounds")

file_paths = {item["path"] for item in files}
try:
    if weight_index_bytes is None:
        fail("pinned local weight index is missing or malformed")
    index = json.loads(weight_index_bytes.decode("utf-8"))
    weight_map = index.get("weight_map", {})
    shards = sorted(set(weight_map.values())) if isinstance(weight_map, dict) else []
except (OSError, UnicodeError, json.JSONDecodeError):
    fail("pinned local weight index is missing or malformed")
if len(shards) != 113 or any(
    not isinstance(item, str)
    or Path(item).name != item
    or not safe_component.fullmatch(item)
    or not item.endswith(".safetensors")
    for item in shards
):
    fail("pinned local weight index has an unexpected shard set")
if "config.json" not in file_paths:
    fail("pinned local config.json is missing")
if not any(name in file_paths for name in ("tokenizer.json", "tokenizer.model", "vocab.json")):
    fail("pinned local tokenizer assets are missing")
if not files or any(shard not in file_paths for shard in shards):
    raise SystemExit("pinned local snapshot is incomplete")
if materialized_snapshot is not None:
    for current, dirnames, _filenames in os.walk(materialized_snapshot, topdown=False):
        for dirname in dirnames:
            os.chmod(Path(current) / dirname, 0o500, follow_symlinks=False)
    os.chmod(materialized_snapshot, 0o500, follow_symlinks=False)
print(json.dumps({
    "schemaVersion": 1,
    "files": files,
    "directories": directories,
    "totalBytes": total_bytes,
}, separators=(",", ":")))
`;

function parseManifest(result: ModelStagingCommandResult): SnapshotManifest {
  if (result.status !== 0 || result.timedOut || result.error) {
    throw new Error(commandFailure("local pinned snapshot audit", result));
  }
  if (Buffer.byteLength(result.stdout, "utf8") > MAX_MANIFEST_BYTES) {
    throw new Error("local pinned snapshot manifest exceeded the safety bound");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error("local pinned snapshot audit returned invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("local pinned snapshot audit returned an invalid manifest");
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.schemaVersion !== MANIFEST_SCHEMA_VERSION ||
    !Array.isArray(record.files) ||
    !Array.isArray(record.directories) ||
    !Number.isSafeInteger(record.totalBytes) ||
    Number(record.totalBytes) <= 0 ||
    Number(record.totalBytes) > MAX_SNAPSHOT_BYTES ||
    record.files.length === 0 ||
    record.files.length + record.directories.length > 4096
  ) {
    throw new Error("local pinned snapshot audit returned an invalid manifest");
  }
  const files = record.files.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("local pinned snapshot manifest contains an invalid file");
    }
    const file = value as Record<string, unknown>;
    if (
      typeof file.path !== "string" ||
      !/^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(file.path) ||
      !Number.isSafeInteger(file.size) ||
      Number(file.size) < 0 ||
      typeof file.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    ) {
      throw new Error("local pinned snapshot manifest contains an invalid file");
    }
    return { path: file.path, size: Number(file.size), sha256: file.sha256 };
  });
  const directories = record.directories.map((value) => {
    if (typeof value !== "string" || !/^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(value)) {
      throw new Error("local pinned snapshot manifest contains an invalid directory");
    }
    return value;
  });
  const filePaths = files.map((file) => file.path);
  if (
    new Set(filePaths).size !== files.length ||
    new Set(directories).size !== directories.length ||
    directories.some((directory) => filePaths.includes(directory)) ||
    files.reduce((total, file) => total + file.size, 0) !== Number(record.totalBytes)
  ) {
    throw new Error("local pinned snapshot manifest is internally inconsistent");
  }
  return {
    schemaVersion: 1,
    files,
    directories,
    totalBytes: Number(record.totalBytes),
  };
}

function remoteScript(
  plan: DualStationVllmPlan,
  paths: StagingPaths,
  manifest: SnapshotManifest,
  operation: "prepare" | "finalize" | "cleanup",
): string {
  const manifestBase64 = Buffer.from(JSON.stringify(manifest), "utf8").toString("base64");
  return String.raw`
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat

EXPECTED_HOME = Path(${JSON.stringify(plan.peer.home)})
FINAL = Path(${JSON.stringify(paths.peerSnapshot)})
STAGING = Path(${JSON.stringify(paths.peerStaging)})
OPERATION = ${JSON.stringify(operation)}
EXPECTED = json.loads(base64.b64decode(${JSON.stringify(manifestBase64)}, validate=True))
SAFE_COMPONENT = re.compile(r"^[A-Za-z0-9._-]+$")

def fail(message):
    raise SystemExit(message)

def relative_name(root, candidate):
    relative = candidate.relative_to(root)
    if not relative.parts or any(not SAFE_COMPONENT.fullmatch(part) for part in relative.parts):
        fail("peer snapshot contains an unsafe relative path")
    return relative.as_posix()

def manifest(root):
    if root.is_symlink() or not root.is_dir():
        fail("peer snapshot path is missing or unsafe")
    files = []
    directories = []
    total_bytes = 0
    entry_count = 0
    for current, dirnames, filenames in os.walk(root, topdown=True, followlinks=False):
        current_path = Path(current)
        dirnames.sort()
        filenames.sort()
        for dirname in dirnames:
            directory = current_path / dirname
            relative = relative_name(root, directory)
            mode = directory.lstat().st_mode
            if stat.S_ISLNK(mode) or not stat.S_ISDIR(mode):
                fail("peer snapshot contains an unsafe directory")
            directories.append(relative)
            entry_count += 1
        for filename in filenames:
            candidate = current_path / filename
            relative = relative_name(root, candidate)
            mode = candidate.lstat().st_mode
            if not stat.S_ISREG(mode):
                fail("peer snapshot contains a symlink or non-regular file")
            digest = hashlib.sha256()
            size = 0
            with candidate.open("rb") as handle:
                for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
                    size += len(chunk)
                    digest.update(chunk)
            files.append({"path": relative, "size": size, "sha256": digest.hexdigest()})
            total_bytes += size
            entry_count += 1
            if entry_count > 4096 or total_bytes > 1024 * 1024 * 1024 * 1024:
                fail("peer snapshot exceeds the staging safety bounds")
    return {"schemaVersion": 1, "files": files, "directories": directories, "totalBytes": total_bytes}

def path_exists(candidate):
    return os.path.lexists(candidate)

def verify_parent_chain():
    observed_home = Path.home()
    if observed_home != EXPECTED_HOME or EXPECTED_HOME.is_symlink() or not EXPECTED_HOME.is_dir():
        fail("peer home identity changed during model staging")
    current = EXPECTED_HOME
    relative_parent = FINAL.parent.relative_to(EXPECTED_HOME)
    for component in relative_parent.parts:
        if not SAFE_COMPONENT.fullmatch(component):
            fail("peer snapshot parent contains an unsafe component")
        current = current / component
        if path_exists(current):
            mode = current.lstat().st_mode
            if stat.S_ISLNK(mode) or not stat.S_ISDIR(mode):
                fail("peer snapshot parent is a symlink or non-directory")
        else:
            current.mkdir(mode=0o700)

def verify_partial(root):
    if root.is_symlink() or not root.is_dir():
        fail("peer staging path is unsafe")
    expected_files = {item["path"]: item for item in EXPECTED["files"]}
    expected_directories = set(EXPECTED["directories"])
    entry_count = 0
    reusable_bytes = 0
    for current, dirnames, filenames in os.walk(root, topdown=True, followlinks=False):
        current_path = Path(current)
        for name in sorted(dirnames):
            candidate = current_path / name
            relative = relative_name(root, candidate)
            mode = candidate.lstat().st_mode
            if stat.S_ISLNK(mode) or not stat.S_ISDIR(mode) or relative not in expected_directories:
                fail("peer staging path contains an unsafe entry")
            entry_count += 1
            if entry_count > 8192:
                fail("peer staging path exceeds the safety bound")
        for name in sorted(filenames):
            candidate = current_path / name
            relative = relative_name(root, candidate)
            mode = candidate.lstat().st_mode
            size = candidate.stat().st_size
            expected = expected_files.get(relative)
            if (
                stat.S_ISLNK(mode)
                or not stat.S_ISREG(mode)
                or expected is None
                or size > expected["size"]
            ):
                fail("peer staging path contains an unsafe entry")
            if size == expected["size"]:
                digest = hashlib.sha256()
                with candidate.open("rb") as handle:
                    for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
                        digest.update(chunk)
                if digest.hexdigest() == expected["sha256"]:
                    reusable_bytes += size
            entry_count += 1
            if entry_count > 8192:
                fail("peer staging path exceeds the safety bound")
    return reusable_bytes

verify_parent_chain()
if OPERATION == "prepare":
    if path_exists(FINAL):
        if manifest(FINAL) != EXPECTED:
            fail("peer pinned snapshot already exists with different content")
        if path_exists(STAGING):
            verify_partial(STAGING)
            shutil.rmtree(STAGING)
        print(json.dumps({"state": "ready"}, separators=(",", ":")))
    else:
        if path_exists(STAGING):
            reusable_bytes = verify_partial(STAGING)
        else:
            reusable_bytes = 0
        remaining_bytes = max(0, EXPECTED["totalBytes"] - reusable_bytes)
        headroom_bytes = max(5 * 1024 * 1024 * 1024, EXPECTED["totalBytes"] // 20)
        if shutil.disk_usage(STAGING.parent).free < remaining_bytes + headroom_bytes:
            fail("peer model cache does not have enough free space for the pinned snapshot")
        if not path_exists(STAGING):
            STAGING.mkdir(mode=0o700)
        print(json.dumps({"state": "transfer"}, separators=(",", ":")))
elif OPERATION == "finalize":
    if path_exists(FINAL):
        if manifest(FINAL) != EXPECTED:
            fail("peer pinned snapshot appeared with different content")
        if path_exists(STAGING):
            verify_partial(STAGING)
            shutil.rmtree(STAGING)
    else:
        if manifest(STAGING) != EXPECTED:
            fail("peer staged snapshot failed byte-integrity verification")
        staged_identity = (STAGING.stat().st_dev, STAGING.stat().st_ino)
        os.rename(STAGING, FINAL)
        installed_identity = (FINAL.stat().st_dev, FINAL.stat().st_ino)
        if installed_identity != staged_identity:
            fail("peer pinned snapshot identity changed during atomic install")
    print(json.dumps({"state": "ready"}, separators=(",", ":")))
elif OPERATION == "cleanup":
    if path_exists(STAGING):
        verify_partial(STAGING)
        shutil.rmtree(STAGING)
    print(json.dumps({"state": "cleaned"}, separators=(",", ":")))
else:
    fail("unsupported model staging operation")
`;
}

function commandFailure(label: string, result: ModelStagingCommandResult): string {
  if (result.timedOut) return `${label} timed out`;
  const detail = (
    result.error ||
    result.stderr.trim().split("\n").at(-1) ||
    "command failed"
  ).slice(0, 512);
  return `${label} failed: ${detail}`;
}

function parseRemoteState(
  label: string,
  result: ModelStagingCommandResult,
  expected: "cleaned" | "ready" | "transfer",
): void {
  if (result.status !== 0 || result.timedOut || result.error) {
    throw new Error(commandFailure(label, result));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    (parsed as Record<string, unknown>).state !== expected
  ) {
    throw new Error(`${label} returned an unexpected state`);
  }
}

function parseRemotePrepareState(result: ModelStagingCommandResult): "ready" | "transfer" {
  if (result.status !== 0 || result.timedOut || result.error) {
    throw new Error(commandFailure("peer snapshot preflight", result));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error("peer snapshot preflight returned invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("peer snapshot preflight returned an unexpected state");
  }
  const state = (parsed as Record<string, unknown>).state;
  if (state !== "ready" && state !== "transfer") {
    throw new Error("peer snapshot preflight returned an unexpected state");
  }
  return state;
}

function sshArgs(plan: DualStationVllmPlan): string[] {
  return [
    ...dualStationPinnedSshArgs(plan.peerSshBinding),
    "--",
    plan.peerSshBinding.peerTarget,
    "python3 -",
  ];
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function rsyncRsh(plan: DualStationVllmPlan): string {
  return ["ssh", ...dualStationPinnedSshArgs(plan.peerSshBinding)].map(shellQuote).join(" ");
}

function createLocalStagingRoot(modelRoot: string): { root: string; snapshot: string } {
  const modelRootMetadata = fs.lstatSync(modelRoot);
  if (modelRootMetadata.isSymbolicLink() || !modelRootMetadata.isDirectory()) {
    throw new Error("pinned local model cache root is missing or unsafe");
  }
  // Keep the potentially large immutable copy on the model-cache filesystem;
  // the OS temporary filesystem is commonly too small for the Ultra snapshot.
  const root = fs.mkdtempSync(path.join(modelRoot, ".nemoclaw-vllm-model-staging-"));
  try {
    fs.chmodSync(root, 0o700);
  } catch (err) {
    try {
      fs.rmSync(root, { force: false, recursive: true });
    } catch (cleanupError) {
      throw new Error(
        `${(err as Error).message}; local staging setup cleanup failed: ${(cleanupError as Error).message}`,
      );
    }
    throw err;
  }
  return { root, snapshot: path.join(root, "snapshot") };
}

function makeLocalStagingTreeRemovable(candidate: string): void {
  const metadata = fs.lstatSync(candidate);
  if (metadata.isSymbolicLink()) {
    throw new Error("local audited snapshot cleanup encountered a symbolic link");
  }
  if (metadata.isDirectory()) {
    fs.chmodSync(candidate, 0o700);
    for (const entry of fs.readdirSync(candidate)) {
      makeLocalStagingTreeRemovable(path.join(candidate, entry));
    }
    return;
  }
  if (!metadata.isFile()) {
    throw new Error("local audited snapshot cleanup encountered a non-file entry");
  }
}

function clearLocalStagingRoot(root: string): void {
  makeLocalStagingTreeRemovable(root);
  fs.rmSync(root, { force: false, recursive: true });
}

async function cleanupPeerStaging(
  plan: DualStationVllmPlan,
  paths: StagingPaths,
  manifest: SnapshotManifest,
  deps: DualStationModelStagingDeps,
  env: Record<string, string>,
): Promise<string | null> {
  try {
    const cleanup = await deps.runCommand("ssh", sshArgs(plan), {
      env,
      input: remoteScript(plan, paths, manifest, "cleanup"),
      timeoutMs: SNAPSHOT_AUDIT_TIMEOUT_MS,
    });
    parseRemoteState("peer snapshot cleanup", cleanup, "cleaned");
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

async function failAfterPeerCleanup(
  reason: string,
  plan: DualStationVllmPlan,
  paths: StagingPaths,
  manifest: SnapshotManifest,
  deps: DualStationModelStagingDeps,
  env: Record<string, string>,
): Promise<DualStationModelStagingResult> {
  const cleanupFailure = await cleanupPeerStaging(plan, paths, manifest, deps, env);
  return {
    ok: false,
    reason: cleanupFailure ? `${reason}; ${cleanupFailure}` : reason,
  };
}

async function auditLocalSnapshot(
  paths: StagingPaths,
  deps: DualStationModelStagingDeps,
  env: Record<string, string>,
  localMaterializedSnapshot?: string,
): Promise<SnapshotManifest> {
  const args = ["-", paths.localSnapshot, paths.localModelRoot];
  if (localMaterializedSnapshot !== undefined) args.push(localMaterializedSnapshot);
  const audit = await deps.runCommand("python3", args, {
    env,
    input: LOCAL_MANIFEST_SCRIPT,
    timeoutMs: SNAPSHOT_AUDIT_TIMEOUT_MS,
  });
  return parseManifest(audit);
}

async function preparePeerSnapshot(
  plan: DualStationVllmPlan,
  paths: StagingPaths,
  manifest: SnapshotManifest,
  deps: DualStationModelStagingDeps,
  env: Record<string, string>,
): Promise<"ready" | "transfer"> {
  const prepare = await deps.runCommand("ssh", sshArgs(plan), {
    env,
    input: remoteScript(plan, paths, manifest, "prepare"),
    timeoutMs: SNAPSHOT_AUDIT_TIMEOUT_MS,
  });
  return parseRemotePrepareState(prepare);
}

function manifestsEqual(left: SnapshotManifest, right: SnapshotManifest): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.totalBytes === right.totalBytes &&
    left.directories.length === right.directories.length &&
    left.directories.every((directory, index) => directory === right.directories[index]) &&
    left.files.length === right.files.length &&
    left.files.every((file, index) => {
      const other = right.files[index];
      return (
        other !== undefined &&
        file.path === other.path &&
        file.size === other.size &&
        file.sha256 === other.sha256
      );
    })
  );
}

async function requireLocalStagingCapacity(
  modelRoot: string,
  manifest: SnapshotManifest,
  deps: DualStationModelStagingDeps,
): Promise<void> {
  let stats: { bavail: bigint; bsize: bigint };
  try {
    const statfs = deps.statfs ?? defaultDeps.statfs;
    if (!statfs) throw new Error("statfs dependency is unavailable");
    stats = await statfs(modelRoot);
  } catch (err) {
    throw new Error(`local model cache capacity check failed: ${(err as Error).message}`);
  }
  if (
    typeof stats.bavail !== "bigint" ||
    typeof stats.bsize !== "bigint" ||
    stats.bavail < 0n ||
    stats.bsize <= 0n
  ) {
    throw new Error("local model cache capacity check returned invalid filesystem data");
  }
  const snapshotBytes = BigInt(manifest.totalBytes);
  const proportionalHeadroom = (snapshotBytes + 19n) / 20n;
  const headroom =
    proportionalHeadroom > LOCAL_STAGING_MIN_HEADROOM_BYTES
      ? proportionalHeadroom
      : LOCAL_STAGING_MIN_HEADROOM_BYTES;
  if (stats.bavail * stats.bsize < snapshotBytes + headroom) {
    throw new Error(
      "local model cache does not have enough free space for the audited snapshot copy",
    );
  }
}

async function stagePreparedSnapshot(
  plan: DualStationVllmPlan,
  paths: StagingPaths,
  auditedManifest: SnapshotManifest,
  localMaterializedSnapshot: string,
  deps: DualStationModelStagingDeps,
  env: Record<string, string>,
): Promise<DualStationModelStagingResult> {
  let transferManifest: SnapshotManifest;
  try {
    transferManifest = await auditLocalSnapshot(paths, deps, env, localMaterializedSnapshot);
  } catch (err) {
    return failAfterPeerCleanup((err as Error).message, plan, paths, auditedManifest, deps, env);
  }
  if (!manifestsEqual(auditedManifest, transferManifest)) {
    return failAfterPeerCleanup(
      "local pinned snapshot changed between audit and materialization",
      plan,
      paths,
      auditedManifest,
      deps,
      env,
    );
  }

  let prepareState: "ready" | "transfer";
  try {
    prepareState = await preparePeerSnapshot(plan, paths, transferManifest, deps, env);
  } catch (err) {
    return failAfterPeerCleanup((err as Error).message, plan, paths, transferManifest, deps, env);
  }
  if (prepareState === "ready") {
    return { ok: true, transferred: false };
  }

  let rsync: ModelStagingCommandResult;
  try {
    rsync = await deps.runCommand(
      "rsync",
      [
        "--recursive",
        "--times",
        "--checksum",
        "--partial",
        "--protect-args",
        "--no-owner",
        "--no-group",
        "--chmod=Du=rwx,Dgo=,Fu=rw,Fgo=",
        "--info=progress2",
        `--rsh=${rsyncRsh(plan)}`,
        "--",
        `${localMaterializedSnapshot}/`,
        `${plan.peerSshBinding.peerTarget}:${paths.peerStaging}/`,
      ],
      {
        env,
        timeoutMs: RSYNC_TIMEOUT_MS,
        idleTimeoutMs: RSYNC_IDLE_TIMEOUT_MS,
        streamOutput: true,
      },
    );
  } catch (err) {
    return failAfterPeerCleanup((err as Error).message, plan, paths, transferManifest, deps, env);
  }
  if (rsync.status !== 0 || rsync.timedOut || rsync.error) {
    return failAfterPeerCleanup(
      commandFailure("peer snapshot transfer", rsync),
      plan,
      paths,
      transferManifest,
      deps,
      env,
    );
  }

  let finalize: ModelStagingCommandResult;
  try {
    finalize = await deps.runCommand("ssh", sshArgs(plan), {
      env,
      input: remoteScript(plan, paths, transferManifest, "finalize"),
      timeoutMs: SNAPSHOT_AUDIT_TIMEOUT_MS,
    });
  } catch (err) {
    return failAfterPeerCleanup((err as Error).message, plan, paths, transferManifest, deps, env);
  }
  try {
    parseRemoteState("peer snapshot verification", finalize, "ready");
  } catch (err) {
    return failAfterPeerCleanup((err as Error).message, plan, paths, transferManifest, deps, env);
  }
  return { ok: true, transferred: true };
}

/**
 * Audit before peer preflight so an already-ready peer avoids the large local
 * copy. Transfers use only a second, immutable audit that exactly matches the
 * first manifest, so no token or unrelated blob cache crosses the SSH boundary.
 */
export async function stageDualStationModelSnapshot(
  plan: DualStationVllmPlan,
  deps: DualStationModelStagingDeps = defaultDeps,
): Promise<DualStationModelStagingResult> {
  let paths: StagingPaths;
  try {
    paths = stagingPaths(plan);
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
  const env = buildVllmSshTransportEnv({ LC_ALL: "C" });

  let auditedManifest: SnapshotManifest;
  try {
    auditedManifest = await auditLocalSnapshot(paths, deps, env);
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }

  let prepareState: "ready" | "transfer";
  try {
    prepareState = await preparePeerSnapshot(plan, paths, auditedManifest, deps, env);
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
  if (prepareState === "ready") {
    return { ok: true, transferred: false };
  }

  try {
    await requireLocalStagingCapacity(paths.localModelRoot, auditedManifest, deps);
  } catch (err) {
    return failAfterPeerCleanup((err as Error).message, plan, paths, auditedManifest, deps, env);
  }

  let localStaging: { root: string; snapshot: string };
  try {
    localStaging = createLocalStagingRoot(paths.localModelRoot);
  } catch (err) {
    return failAfterPeerCleanup(
      `local audited snapshot setup failed: ${(err as Error).message}`,
      plan,
      paths,
      auditedManifest,
      deps,
      env,
    );
  }

  let result: DualStationModelStagingResult;
  try {
    result = await stagePreparedSnapshot(
      plan,
      paths,
      auditedManifest,
      localStaging.snapshot,
      deps,
      env,
    );
  } catch (err) {
    result = await failAfterPeerCleanup(
      (err as Error).message,
      plan,
      paths,
      auditedManifest,
      deps,
      env,
    );
  }
  try {
    clearLocalStagingRoot(localStaging.root);
  } catch (err) {
    const cleanupFailure = `local audited snapshot cleanup failed: ${(err as Error).message}`;
    return {
      ok: false,
      reason: result.ok ? cleanupFailure : `${result.reason}; ${cleanupFailure}`,
    };
  }
  return result;
}
