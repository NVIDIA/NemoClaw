// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import { isDeepStrictEqual } from "node:util";

import { resolveTrustedSnapshotSanitizerPythonPath } from "../../../../nemoclaw/dist/shared/snapshot-sanitizer-boundary.cjs";
import type { CheckpointPortableRuntimeAuthority } from "../../state/onboard-checkpoint-types";
import { hasPortableUninstallAuthority } from "../../onboard/portable-retirement-authority";
import { withMcpLifecycleLockSync } from "../../state/mcp-lifecycle-lock-acquisition";
import {
  assertNoPortableConfigurationCleanupRecovery,
  inspectPortableRetirementRecovery,
  PORTABLE_CONFIGURATION_CLEANUP_RECOVERY_PREFIX,
  PORTABLE_RETIREMENT_STATE_ENTRIES,
  preparePortableRetirement,
  publishAndRetirePortableEvidence,
  readPortableAuthorityDirectory,
  resumePortableEvidenceRetirement,
  samePortableAuthorityDirectory,
  withPortableHostFence,
  type PreparedPortableRetirement,
  type PortableRetirementRecovery,
} from "../../state/portable-uninstall-retirement";

export {
  assertNoPortableConfigurationCleanupRecovery,
  PORTABLE_RETIREMENT_STATE_ENTRIES,
  withPortableHostFence,
};
import { withProcessBoundRegistryLockAt } from "../../state/registry/lock";
import {
  readGatewayRegistryFile,
  registryEntryGatewayPort,
  type GatewayRegistryEntry,
} from "../../state/gateway-registry";
import {
  createPortablePodmanLifecycleTransport,
  listPortableDemoSandboxLifecycleReceipts,
  preparePortableDemoSandboxRemoval,
  type PortableDemoLifecycleDeps,
  type PortableDemoLifecycleReceiptRecord,
  type PortablePodmanLifecycleCommandResult,
  type PortablePodmanLifecycleTransport,
} from "../../onboard/experimental/portable-demo-lifecycle";
import { portablePodmanCommandEnvironment } from "../../onboard/experimental/portable-runtime-readiness";
import {
  inspectHermesPortableUninstallSandboxNames,
  runHermesPortableUninstall,
  type HermesPortableUninstallDeps,
} from "./hermes-portable-uninstall";
import { HERMES_PORTABLE_UNINSTALL_JOURNAL_FILE } from "./hermes-portable-uninstall-transaction";

export { HERMES_PORTABLE_UNINSTALL_JOURNAL_FILE };

const REGISTRY_CONTAINER_NAME = "nemoclaw-portable-registry";
const REGISTRY_LABEL_NAME = "com.nvidia.nemoclaw.portable";
const REGISTRY_LABEL_VALUE = "1";
const CONTAINER_ID_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_SYSTEMD_ENVIRONMENT_BYTES = 1024 * 1024;
const PORTABLE_SELECTOR_NAMES = [
  "CONTAINERS_CONF",
  "NETAVARK_FW",
  "CONTAINER_HOST",
  "CONTAINER_CONNECTION",
  "CONTAINER_SSHKEY",
] as const;
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const PORTABLE_CONFIGURATION_RECOVERY_PATTERN =
  /^\.portable-cleanup-v1-(pending|bound|removed)-([0-9]+)-([0-9]+)-([0-9]+)-([A-Za-z0-9]{6})$/u;
let portableConfigurationPythonUnavailableForTest = false;

type PortableConfigurationRecoveryPhase = "pending" | "bound" | "removed";

interface PortableConfigurationRecovery {
  readonly dev: bigint;
  readonly entry: string;
  readonly ino: bigint;
  readonly path: string;
  readonly phase: PortableConfigurationRecoveryPhase;
  readonly snapshot: ReturnType<typeof readPortableAuthorityDirectory>;
  readonly suffix: string;
  readonly uid: bigint;
}

// Node does not expose unlinkat(2). Pass the already-open recovery and Portable
// directory descriptors to isolated Python so removal never resolves the
// quarantined pathname again. Final directory removals are non-recursive.
const PORTABLE_CONFIGURATION_DELETE_HELPER = String.raw`
import os
import stat
import sys

O_DIRECTORY = getattr(os, "O_DIRECTORY", 0)
O_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
O_CLOEXEC = getattr(os, "O_CLOEXEC", 0)
DIR_FLAGS = os.O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC


def fail() -> None:
    sys.exit(1)


def same_identity(left: os.stat_result, right: os.stat_result) -> bool:
    return (
        left.st_dev == right.st_dev
        and left.st_ino == right.st_ino
        and left.st_uid == right.st_uid
    )


def remove_portable() -> None:
    recovery_fd = 3
    portable_fd = 4
    held = os.fstat(portable_fd)
    named = os.lstat("portable", dir_fd=recovery_fd)
    if not same_identity(held, named):
        fail()
    entries = sorted(entry.name for entry in os.scandir(portable_fd))
    if entries not in ([], ["containers.conf"]):
        fail()
    if entries:
        configuration = os.lstat("containers.conf", dir_fd=portable_fd)
        if (
            not stat.S_ISREG(configuration.st_mode)
            or configuration.st_uid != os.getuid()
            or configuration.st_nlink != 1
        ):
            fail()
        os.unlink("containers.conf", dir_fd=portable_fd)
    os.fsync(portable_fd)
    named_after = os.lstat("portable", dir_fd=recovery_fd)
    if not same_identity(held, named_after):
        fail()
    try:
        os.rmdir("portable", dir_fd=recovery_fd)
        os.fsync(recovery_fd)
    except OSError:
        fail()


def remove_recovery() -> None:
    parent_fd = 3
    recovery_fd = 4
    name = sys.argv[2]
    if (
        not name
        or name in (".", "..")
        or os.sep in name
        or (os.altsep is not None and os.altsep in name)
    ):
        fail()
    held = os.fstat(recovery_fd)
    named = os.lstat(name, dir_fd=parent_fd)
    if not same_identity(held, named) or list(os.scandir(recovery_fd)):
        fail()
    try:
        os.rmdir(name, dir_fd=parent_fd)
        os.fsync(parent_fd)
    except OSError:
        fail()


if __name__ == "__main__":
    try:
        if len(sys.argv) < 2:
            fail()
        if sys.argv[1] == "portable" and len(sys.argv) == 2:
            remove_portable()
        elif sys.argv[1] == "recovery" and len(sys.argv) == 3:
            remove_recovery()
        else:
            fail()
    except Exception:
        fail()
`;

function sameDirectoryObject(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return ["dev", "ino", "uid", "nlink"].every(
    (key) => left[key as keyof fs.BigIntStats] === right[key as keyof fs.BigIntStats],
  );
}

/** @visibleForTesting Force the prerequisite failure without depending on the host installation. */
export function setPortableConfigurationPythonUnavailableForTest(unavailable: boolean): void {
  if (process.env.VITEST !== "true") {
    throw new Error("Portable configuration Python failure is only configurable under Vitest");
  }
  portableConfigurationPythonUnavailableForTest = unavailable;
}

function portableConfigurationPython(): string | null {
  return process.env.VITEST === "true" && portableConfigurationPythonUnavailableForTest
    ? null
    : resolveTrustedSnapshotSanitizerPythonPath();
}

function assertPortableConfigurationFile(directory: string): void {
  if (typeof fs.constants.O_NOFOLLOW !== "number") {
    throw new Error("Portable configuration cleanup requires O_NOFOLLOW");
  }
  const configuration = path.join(directory, "containers.conf");
  const nonblock = typeof fs.constants.O_NONBLOCK === "number" ? fs.constants.O_NONBLOCK : 0;
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(
      configuration,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | nonblock,
    );
    const held = fs.fstatSync(descriptor, { bigint: true });
    const named = fs.lstatSync(configuration, { bigint: true });
    const currentUid = process.getuid?.();
    if (
      currentUid === undefined ||
      !held.isFile() ||
      named.isSymbolicLink() ||
      !named.isFile() ||
      held.uid !== BigInt(currentUid) ||
      held.nlink !== 1n ||
      !sameDirectoryObject(held, named)
    )
      throw new Error("Portable containers.conf is not a current-user single-link regular file");
  } catch {
    throw new Error("Portable containers.conf is not a current-user single-link regular file");
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function sameStableDirectoryIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    left.isDirectory() &&
    right.isDirectory() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid
  );
}

function isErrnoException(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function sameRecordedDirectory(
  identity: fs.BigIntStats,
  recovery: Pick<PortableConfigurationRecovery, "dev" | "ino" | "uid">,
): boolean {
  return (
    identity.isDirectory() &&
    identity.dev === recovery.dev &&
    identity.ino === recovery.ino &&
    identity.uid === recovery.uid
  );
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(
    directory,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY,
  );
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function recoveryEntry(
  phase: PortableConfigurationRecoveryPhase,
  identity: Pick<fs.BigIntStats, "dev" | "ino" | "uid">,
  suffix: string,
): string {
  return `${PORTABLE_CONFIGURATION_CLEANUP_RECOVERY_PREFIX}${phase}-${String(identity.dev)}-${String(identity.ino)}-${String(identity.uid)}-${suffix}`;
}

function inspectPortableConfigurationRecovery(
  parent: string,
): PortableConfigurationRecovery | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(parent);
  } catch (error) {
    if (isErrnoException(error, "ENOENT")) return null;
    throw error;
  }
  const candidates = entries.filter((entry) =>
    entry.startsWith(PORTABLE_CONFIGURATION_CLEANUP_RECOVERY_PREFIX),
  );
  if (candidates.length === 0) return null;
  if (candidates.length !== 1)
    throw new Error("Portable configuration has ambiguous ordinary cleanup recovery");
  const entry = candidates[0]!;
  const match = PORTABLE_CONFIGURATION_RECOVERY_PATTERN.exec(entry);
  if (!match) throw new Error("Portable configuration has invalid ordinary cleanup recovery");
  const recoveryPath = path.join(parent, entry);
  return {
    dev: BigInt(match[2]!),
    entry,
    ino: BigInt(match[3]!),
    path: recoveryPath,
    phase: match[1] as PortableConfigurationRecoveryPhase,
    snapshot: readPortableAuthorityDirectory(recoveryPath, true),
    suffix: match[5]!,
    uid: BigInt(match[4]!),
  };
}

function renamePortableConfigurationRecovery(
  parent: string,
  recovery: PortableConfigurationRecovery,
  phase: PortableConfigurationRecoveryPhase,
): PortableConfigurationRecovery {
  const entry = recoveryEntry(phase, recovery, recovery.suffix);
  const target = path.join(parent, entry);
  fs.renameSync(recovery.path, target);
  fsyncDirectory(parent);
  const renamed = inspectPortableConfigurationRecovery(parent);
  if (
    !renamed ||
    renamed.entry !== entry ||
    !recovery.snapshot.identity ||
    !renamed.snapshot.identity ||
    !sameStableDirectoryIdentity(recovery.snapshot.identity, renamed.snapshot.identity)
  )
    throw new Error("Portable configuration cleanup recovery changed while advancing");
  return renamed;
}

function runPortableConfigurationDeleteHelper(
  action: "portable" | "recovery",
  parentDescriptor: number,
  heldDescriptor: number,
  entry?: string,
): boolean {
  const python = portableConfigurationPython();
  if (!python) return false;
  const result = spawnSync(
    python,
    ["-I", "-c", PORTABLE_CONFIGURATION_DELETE_HELPER, action, ...(entry ? [entry] : [])],
    {
      encoding: "utf-8",
      env: {},
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe", parentDescriptor, heldDescriptor],
      timeout: 30_000,
    },
  );
  return result.status === 0 && !result.error;
}

function createPortableConfigurationRecovery(
  parent: string,
  identity: fs.BigIntStats,
): PortableConfigurationRecovery {
  const recoveryPath = fs.mkdtempSync(path.join(parent, recoveryEntry("pending", identity, "")));
  fsyncDirectory(parent);
  const recovery = inspectPortableConfigurationRecovery(parent);
  if (!recovery || recovery.path !== recoveryPath || recovery.snapshot.entries.length !== 0)
    throw new Error("Portable configuration cleanup recovery changed while creating it");
  return recovery;
}

function removeBoundPortableConfiguration(recovery: PortableConfigurationRecovery): void {
  const portableDirectory = path.join(recovery.path, "portable");
  const portable = readPortableAuthorityDirectory(portableDirectory, true);
  if (
    !portable.identity ||
    !sameRecordedDirectory(portable.identity, recovery) ||
    (!isDeepStrictEqual(portable.entries, ["containers.conf"]) && portable.entries.length !== 0)
  )
    throw new Error("Portable configuration cleanup recovery does not match its identity");
  if (isDeepStrictEqual(portable.entries, ["containers.conf"])) {
    assertPortableConfigurationFile(portableDirectory);
  }
  const recoveryDescriptor = fs.openSync(
    recovery.path,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY,
  );
  const portableDescriptor = fs.openSync(
    portableDirectory,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY,
  );
  try {
    const heldRecovery = fs.fstatSync(recoveryDescriptor, { bigint: true });
    const heldPortable = fs.fstatSync(portableDescriptor, { bigint: true });
    if (
      !recovery.snapshot.identity ||
      !sameStableDirectoryIdentity(recovery.snapshot.identity, heldRecovery) ||
      !sameRecordedDirectory(heldPortable, recovery) ||
      !runPortableConfigurationDeleteHelper("portable", recoveryDescriptor, portableDescriptor)
    )
      throw new Error("Portable configuration could not be removed by verified identity");
  } finally {
    fs.closeSync(portableDescriptor);
    fs.closeSync(recoveryDescriptor);
  }
  const after = readPortableAuthorityDirectory(recovery.path, true);
  if (
    !recovery.snapshot.identity ||
    !after.identity ||
    !sameStableDirectoryIdentity(recovery.snapshot.identity, after.identity) ||
    after.entries.length !== 0
  )
    throw new Error("Portable configuration remained after identity-bound removal");
}

export function removeAbandonedPortableConfiguration(directory: string): string | null {
  const parent = path.dirname(directory);
  let recovery = inspectPortableConfigurationRecovery(parent);
  const snapshot = readPortableAuthorityDirectory(directory, false, true);
  if (!recovery && !snapshot.identity) return null;
  if (!recovery && snapshot.identity && !isDeepStrictEqual(snapshot.entries, ["containers.conf"]))
    throw new Error("Portable configuration changed before ordinary cleanup");

  if (!recovery) {
    const descriptor = fs.openSync(
      directory,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY,
    );
    try {
      const before = fs.fstatSync(descriptor, { bigint: true });
      const namedBefore = fs.lstatSync(directory, { bigint: true });
      if (
        !samePortableAuthorityDirectory(snapshot, {
          entries: snapshot.entries,
          identity: before,
        }) ||
        !samePortableAuthorityDirectory(snapshot, {
          entries: snapshot.entries,
          identity: namedBefore,
        })
      )
        throw new Error("Portable configuration changed before ordinary cleanup");

      if ((before.mode & 0o777n) !== 0o700n) fs.fchmodSync(descriptor, 0o700);
      const after = fs.fstatSync(descriptor, { bigint: true });
      const namedAfter = fs.lstatSync(directory, { bigint: true });
      const verifiedAfter = readPortableAuthorityDirectory(directory, true);
      if (
        !after.isDirectory() ||
        namedAfter.isSymbolicLink() ||
        !sameDirectoryObject(before, after) ||
        !sameDirectoryObject(after, namedAfter) ||
        !verifiedAfter.identity ||
        !sameDirectoryObject(after, verifiedAfter.identity) ||
        !isDeepStrictEqual(verifiedAfter.entries, ["containers.conf"]) ||
        (after.mode & 0o777n) !== 0o700n
      )
        throw new Error("Portable configuration changed while preparing ordinary cleanup");
      assertPortableConfigurationFile(directory);

      recovery = createPortableConfigurationRecovery(parent, after);
      fs.renameSync(directory, path.join(recovery.path, "portable"));
      fsyncDirectory(recovery.path);
      fsyncDirectory(parent);
      const moved = readPortableAuthorityDirectory(path.join(recovery.path, "portable"), true);
      const held = fs.fstatSync(descriptor, { bigint: true });
      if (
        !moved.identity ||
        !sameDirectoryObject(after, held) ||
        !sameDirectoryObject(held, moved.identity) ||
        !sameRecordedDirectory(moved.identity, recovery) ||
        !isDeepStrictEqual(moved.entries, ["containers.conf"])
      )
        throw new Error("Portable configuration changed while binding ordinary cleanup");
      assertPortableConfigurationFile(path.join(recovery.path, "portable"));
      recovery = renamePortableConfigurationRecovery(parent, recovery, "bound");
    } finally {
      fs.closeSync(descriptor);
    }
  }

  if (recovery.phase === "pending") {
    if (recovery.snapshot.entries.length === 0) {
      if (!snapshot.identity || !sameRecordedDirectory(snapshot.identity, recovery))
        throw new Error("Portable configuration cleanup recovery is incomplete");
      assertPortableConfigurationFile(directory);
      fs.renameSync(directory, path.join(recovery.path, "portable"));
      fsyncDirectory(recovery.path);
      fsyncDirectory(parent);
    } else if (isDeepStrictEqual(recovery.snapshot.entries, ["portable"])) {
      const moved = readPortableAuthorityDirectory(path.join(recovery.path, "portable"), true);
      if (!moved.identity || !sameRecordedDirectory(moved.identity, recovery))
        throw new Error("Portable configuration cleanup recovery changed before binding");
      assertPortableConfigurationFile(path.join(recovery.path, "portable"));
    } else throw new Error("Portable configuration cleanup recovery changed before binding");
    recovery = renamePortableConfigurationRecovery(parent, recovery, "bound");
  }
  if (recovery.phase === "bound") {
    if (isDeepStrictEqual(recovery.snapshot.entries, ["portable"]))
      removeBoundPortableConfiguration(recovery);
    else if (recovery.snapshot.entries.length !== 0)
      throw new Error("Portable configuration cleanup recovery changed during removal");
    recovery = renamePortableConfigurationRecovery(parent, recovery, "removed");
  }
  if (recovery.phase !== "removed" || recovery.snapshot.entries.length !== 0)
    throw new Error("Portable configuration cleanup recovery did not complete");
  return recovery.entry;
}

export function finalizeAbandonedPortableConfigurationRemoval(
  parent: string,
  recoveryEntryName: string,
): void {
  const recovery = inspectPortableConfigurationRecovery(parent);
  if (
    !recovery ||
    recovery.entry !== recoveryEntryName ||
    recovery.phase !== "removed" ||
    recovery.snapshot.entries.length !== 0 ||
    !recovery.snapshot.identity
  )
    throw new Error("Portable configuration cleanup recovery cannot be finalized");
  const parentDescriptor = fs.openSync(
    parent,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY,
  );
  const recoveryDescriptor = fs.openSync(
    recovery.path,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY,
  );
  try {
    if (
      !sameStableDirectoryIdentity(
        recovery.snapshot.identity,
        fs.fstatSync(recoveryDescriptor, { bigint: true }),
      ) ||
      !runPortableConfigurationDeleteHelper(
        "recovery",
        parentDescriptor,
        recoveryDescriptor,
        recovery.entry,
      )
    )
      throw new Error("Portable configuration cleanup recovery could not be finalized");
  } finally {
    fs.closeSync(recoveryDescriptor);
    fs.closeSync(parentDescriptor);
  }
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

interface PortableRegistryRemoval {
  readonly present: boolean;
  removeAndVerify(): void;
}

export interface PortableRuntimeCleanupInput {
  readonly env: NodeJS.ProcessEnv;
  readonly gatewayName: string;
  readonly gatewayPort: number;
  readonly homeDir: string;
  readonly registryFile: string;
  readonly stateDir: string;
}

export interface PortableRuntimeCleanupDeps extends PortableDemoLifecycleDeps {
  readonly systemctl?: (
    args: readonly string[],
    env: NodeJS.ProcessEnv,
  ) => PortablePodmanLifecycleCommandResult;
  readonly withLifecycleLock?: <T>(sandboxName: string, operation: () => T, stateDir: string) => T;
  readonly withRegistryLock?: <T>(registryFile: string, operation: () => T) => T;
  readonly inspectRetirement?: (homeDir: string) => PortableRetirementRecovery | null;
  readonly prepareRetirement?: (
    homeDir: string,
    receiptBasenames: readonly string[],
  ) => PreparedPortableRetirement;
  readonly publishRetirement?: (prepared: PreparedPortableRetirement) => void;
  readonly resumeRetirement?: (homeDir: string) => void;
  readonly hermesPortable?: HermesPortableUninstallDeps;
  readonly inspectHermesPortableSandboxNames?: typeof inspectHermesPortableUninstallSandboxNames;
  readonly runHermesPortableUninstall?: typeof runHermesPortableUninstall;
}

export interface PortableRuntimeCleanupResult {
  readonly registryRemoved: boolean;
  readonly sandboxContainersRemoved: number;
  readonly selectorsRemoved: readonly string[];
}

function commandDetail(result: PortablePodmanLifecycleCommandResult): string {
  if (result.error) {
    return (result.error as NodeJS.ErrnoException).code ?? result.error.message;
  }
  const stderr = String(result.stderr ?? "").trim();
  return stderr || `exit ${String(result.status)}`;
}

function requireCommand(result: PortablePodmanLifecycleCommandResult, description: string): void {
  if (result.status === 0 && !result.error) return;
  throw new Error(`${description} failed: ${commandDetail(result)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingContainer(result: PortablePodmanLifecycleCommandResult): boolean {
  if (result.status === 0 && !result.error) return false;
  const detail = `${String(result.stderr ?? "")}\n${String(result.stdout ?? "")}`;
  return /\b(?:no such (?:object|container)|no container with (?:name|id)|container .* not found)\b/iu.test(
    detail,
  );
}

function withPortableFences<T>(
  input: PortableRuntimeCleanupInput,
  sandboxNames: readonly string[],
  deps: PortableRuntimeCleanupDeps,
  operation: () => T,
): T {
  const lifecycleStateDir = path.join(input.stateDir, "state");
  const withLifecycleLock =
    deps.withLifecycleLock ??
    (<Value>(sandboxName: string, inner: () => Value, stateDir: string) =>
      withMcpLifecycleLockSync(sandboxName, inner, { stateDir }));
  const withRegistryLock = deps.withRegistryLock ?? withProcessBoundRegistryLockAt;
  const acquireNext = (index: number): T => {
    const sandboxName = sandboxNames[index];
    return sandboxName
      ? withLifecycleLock(sandboxName, () => acquireNext(index + 1), lifecycleStateDir)
      : withRegistryLock(input.registryFile, operation);
  };
  return acquireNext(0);
}

function commonRuntimeAuthority(
  receipts: readonly PortableDemoLifecycleReceiptRecord[],
): CheckpointPortableRuntimeAuthority {
  const authority = receipts[0]?.runtimeAuthority;
  if (!authority) throw new Error("Portable uninstall requires at least one lifecycle receipt");
  for (const receipt of receipts.slice(1)) {
    if (!isDeepStrictEqual(receipt.runtimeAuthority, authority)) {
      throw new Error("Portable lifecycle receipts disagree on their Podman runtime authority");
    }
  }
  return authority;
}

function requireReceiptRegistryOwnership(
  receipt: PortableDemoLifecycleReceiptRecord,
  entry: GatewayRegistryEntry | undefined,
  gatewayPort: number,
  gatewayName: string,
): void {
  if (!entry) {
    throw new Error(
      `Portable lifecycle receipt for sandbox '${receipt.sandboxName}' has no current registry ownership`,
    );
  }
  if (
    registryEntryGatewayPort(entry) !== gatewayPort ||
    entry.gatewayPort !== gatewayPort ||
    entry.gatewayName !== gatewayName ||
    entry.agent !== "openclaw" ||
    entry.openshellDriver !== "docker" ||
    entry.lifecycleGeneration !== receipt.registryGeneration
  ) {
    throw new Error(
      `Portable lifecycle receipt for sandbox '${receipt.sandboxName}' does not match its current registry ownership`,
    );
  }
}

function requireCompleteReceiptRegistryOwnership(
  receipts: readonly PortableDemoLifecycleReceiptRecord[],
  registry: ReturnType<typeof readGatewayRegistryFile>,
  gatewayPort: number,
  gatewayName: string,
): string {
  if (!registry) throw new Error("Portable lifecycle receipts have no current sandbox registry");
  const receiptNames = receipts.map((receipt) => receipt.sandboxName).sort();
  for (const receipt of receipts) {
    requireReceiptRegistryOwnership(
      receipt,
      registry.sandboxes[receipt.sandboxName],
      gatewayPort,
      gatewayName,
    );
  }
  const registryNames = Object.keys(registry.sandboxes).sort();
  if (!isDeepStrictEqual(registryNames, receiptNames)) {
    throw new Error(
      "Portable sandbox registry ownership is not represented by the complete lifecycle receipt set",
    );
  }
  return gatewayName;
}

function currentReceipts(stateDir: string): PortableDemoLifecycleReceiptRecord[] {
  return listPortableDemoSandboxLifecycleReceipts(stateDir).sort((left, right) =>
    compareCodeUnits(left.sandboxName, right.sandboxName),
  );
}

/** Detect portable uninstall from strict durable receipts, never ambient selectors or names. */
export function hasPortableRuntimeCleanup(stateDir: string): boolean {
  const homeDir = path.dirname(stateDir);
  const configRoot = path.join(homeDir, ".config/nemoclaw");
  const registryFile = path.join(stateDir, "sandboxes.json");
  if (
    inspectHermesPortableUninstallSandboxNames({
      env: process.env,
      homeDir,
      registryFile,
      stateDir,
    })
  ) {
    assertNoPortableConfigurationCleanupRecovery(configRoot);
    return true;
  }
  const portable = hasPortableUninstallAuthority(
    {
      homeDir,
      registryFile,
      sessionFile: path.join(stateDir, "onboard-session.json"),
      stateDir,
    },
    {
      loadRegistry: () => {
        const registry = readGatewayRegistryFile(homeDir, registryFile);
        if (!registry) throw new Error("Completed onboarding registry is missing");
        return registry;
      },
    },
  );
  if (portable) assertNoPortableConfigurationCleanupRecovery(configRoot);
  return portable;
}

export function portableRetirementPreservationEntries(stateDir: string): {
  config: string[];
  stateRoot: string[];
} {
  const artifacts = inspectPortableRetirementRecovery(path.dirname(stateDir))?.artifacts ?? [];
  return {
    config: artifacts.filter(({ root }) => root === "config").map(({ basename }) => basename),
    stateRoot: artifacts.filter(({ root }) => root === "registry").map(({ basename }) => basename),
  };
}

function recordedRegistrySandboxNames(registryBytes: Buffer): string[] {
  let registry: unknown;
  try {
    registry = JSON.parse(UTF8.decode(registryBytes));
  } catch {
    throw new Error("Recorded portable registry authority is malformed");
  }
  if (!isRecord(registry) || !isRecord(registry.sandboxes)) {
    throw new Error("Recorded portable registry authority is invalid");
  }
  const names = Object.entries(registry.sandboxes).map(([name, value]) => {
    if (!isRecord(value) || value.name !== name || name.length < 1 || name.length > 256) {
      throw new Error("Recorded portable registry sandbox identity is invalid");
    }
    return name;
  });
  return names.sort();
}

/** Remove receipt-owned portable resources under lifecycle and registry locks through retirement. */
export function runPortableRuntimeCleanupTransaction(
  input: PortableRuntimeCleanupInput,
  continueAfterSandboxRemoval: (
    removed: number,
    sandboxNames: readonly string[],
    gatewayName: string,
  ) => boolean,
  deps: PortableRuntimeCleanupDeps = {},
): PortableRuntimeCleanupResult | null {
  const hermesInput = {
    env: input.env,
    homeDir: input.homeDir,
    registryFile: input.registryFile,
    stateDir: input.stateDir,
  };
  const hermesSandboxNames = (
    deps.inspectHermesPortableSandboxNames ?? inspectHermesPortableUninstallSandboxNames
  )(hermesInput);
  if (hermesSandboxNames) {
    const names = [...hermesSandboxNames].sort(compareCodeUnits);
    return withPortableFences(input, names, deps, () => {
      const result = (deps.runHermesPortableUninstall ?? runHermesPortableUninstall)(
        hermesInput,
        deps.hermesPortable,
      );
      return {
        registryRemoved: false,
        sandboxContainersRemoved: result.sandboxContainersRemoved,
        selectorsRemoved: [],
      };
    });
  }
  const inspectRetirement = deps.inspectRetirement ?? inspectPortableRetirementRecovery;
  const recovery = inspectRetirement(input.homeDir);
  if (recovery) {
    const sandboxNames = recovery.registryBytes
      ? recordedRegistrySandboxNames(recovery.registryBytes)
      : [];
    return withPortableFences(input, sandboxNames, deps, () => {
      (deps.resumeRetirement ?? resumePortableEvidenceRetirement)(input.homeDir);
      return { registryRemoved: false, sandboxContainersRemoved: 0, selectorsRemoved: [] };
    });
  }
  const receipts = currentReceipts(input.stateDir);
  const registry = readGatewayRegistryFile(input.homeDir, input.registryFile);
  if (receipts.length === 0) {
    throw new Error("Portable lifecycle receipts disappeared before uninstall acquired its fences");
  }
  return withPortableFences(
    input,
    receipts.map((receipt) => receipt.sandboxName),
    deps,
    () => {
      const current = currentReceipts(input.stateDir);
      const currentRegistry = readGatewayRegistryFile(input.homeDir, input.registryFile);
      if (!isDeepStrictEqual(current, receipts) || !isDeepStrictEqual(currentRegistry, registry)) {
        throw new Error(
          "Portable lifecycle or registry state changed while uninstall acquired its fences",
        );
      }
      const authority = commonRuntimeAuthority(receipts);
      const transport = createPortablePodmanLifecycleTransport(authority, {
        ...deps,
        env: input.env,
        stateDir: input.stateDir,
      });
      const gatewayName = requireCompleteReceiptRegistryOwnership(
        receipts,
        registry,
        input.gatewayPort,
        input.gatewayName,
      );
      const receiptBasenames = receipts.map(
        (receipt) => `${createHash("sha256").update(receipt.sandboxName).digest("hex")}.json`,
      );
      const retirement = (deps.prepareRetirement ?? preparePortableRetirement)(
        input.homeDir,
        receiptBasenames,
      );
      const prepared = receipts.map((receipt) =>
        preparePortableDemoSandboxRemoval(receipt, transport, input.stateDir),
      );
      const portableRegistry = preparePortableRegistryRemoval(transport);
      inspectPortableUserManagerEnvironment(authority, input.env, deps);
      for (const target of prepared) target.removeAndVerify();
      const sandboxContainersRemoved = prepared.filter((target) => target.present).length;
      if (
        !continueAfterSandboxRemoval(
          sandboxContainersRemoved,
          receipts.map((receipt) => receipt.sandboxName),
          gatewayName,
        )
      )
        return null;
      if (
        !isDeepStrictEqual(currentReceipts(input.stateDir), receipts) ||
        !isDeepStrictEqual(readGatewayRegistryFile(input.homeDir, input.registryFile), registry)
      ) {
        throw new Error(
          "Portable lifecycle or registry state changed during exact uninstall cleanup",
        );
      }
      for (const target of prepared) target.verifyAbsent();
      portableRegistry.removeAndVerify();
      const selectorsRemoved = clearPortableUserManagerSelectors(authority, input.env, deps);
      if (
        !isDeepStrictEqual(currentReceipts(input.stateDir), receipts) ||
        !isDeepStrictEqual(readGatewayRegistryFile(input.homeDir, input.registryFile), registry)
      ) {
        throw new Error("Portable lifecycle or registry state changed before evidence retirement");
      }
      (deps.publishRetirement ?? publishAndRetirePortableEvidence)(retirement);
      return {
        registryRemoved: portableRegistry.present,
        sandboxContainersRemoved,
        selectorsRemoved,
      };
    },
  );
}

function parseContainerIds(
  result: PortablePodmanLifecycleCommandResult,
  description: string,
): string[] {
  requireCommand(result, description);
  const ids = String(result.stdout ?? "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (ids.some((id) => !CONTAINER_ID_PATTERN.test(id))) {
    throw new Error(`${description} returned an invalid container ID`);
  }
  return ids;
}

function registryLabelContainerIds(transport: PortablePodmanLifecycleTransport): string[] {
  return parseContainerIds(
    transport.podman([
      "ps",
      "-a",
      "--no-trunc",
      "--filter",
      `label=${REGISTRY_LABEL_NAME}=${REGISTRY_LABEL_VALUE}`,
      "--format",
      "{{.ID}}",
    ]),
    "Finding the managed portable registry container",
  );
}

function inspectRegistryContainer(
  transport: PortablePodmanLifecycleTransport,
  result = transport.podman(["inspect", REGISTRY_CONTAINER_NAME]),
): string | null {
  if (isMissingContainer(result)) return null;
  requireCommand(result, "Inspecting the managed portable registry container");
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(result.stdout ?? ""));
  } catch {
    throw new Error("Inspecting the managed portable registry container returned invalid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length !== 1 || !isRecord(parsed[0])) {
    throw new Error(
      "Inspecting the managed portable registry container returned an invalid record",
    );
  }
  const record = parsed[0];
  const config = isRecord(record.Config) ? record.Config : null;
  const labels = config && isRecord(config.Labels) ? config.Labels : null;
  const state = isRecord(record.State) ? record.State : null;
  if (
    typeof record.Id !== "string" ||
    !CONTAINER_ID_PATTERN.test(record.Id) ||
    record.Name !== REGISTRY_CONTAINER_NAME ||
    labels?.[REGISTRY_LABEL_NAME] !== REGISTRY_LABEL_VALUE ||
    typeof state?.Running !== "boolean"
  ) {
    throw new Error("The portable registry container does not match NemoClaw ownership");
  }
  return record.Id;
}

function preparePortableRegistryRemoval(
  transport: PortablePodmanLifecycleTransport,
): PortableRegistryRemoval {
  transport.assertRuntimeAuthority();
  const labelIds = registryLabelContainerIds(transport);
  const containerId = inspectRegistryContainer(transport);
  if (containerId === null) {
    if (labelIds.length !== 0) {
      throw new Error(
        "Portable registry ownership is ambiguous because a labeled replacement exists",
      );
    }
    return { present: false, removeAndVerify: () => transport.assertRuntimeAuthority() };
  }
  if (labelIds.length !== 1 || labelIds[0] !== containerId) {
    throw new Error("Portable registry ownership is ambiguous");
  }
  return {
    present: true,
    removeAndVerify: () => {
      transport.assertRuntimeAuthority();
      const currentId = inspectRegistryContainer(transport);
      if (currentId !== containerId) {
        throw new Error("The portable registry container changed after prevalidation");
      }
      requireCommand(
        transport.podman(["rm", "--force", containerId]),
        "Removing the managed portable registry container",
      );
      const exact = transport.podman(["inspect", containerId]);
      if (!isMissingContainer(exact)) {
        if (exact.status !== 0 || exact.error) {
          requireCommand(exact, "Verifying portable registry removal");
        }
        throw new Error("The managed portable registry container still exists after removal");
      }
      if (
        inspectRegistryContainer(transport) !== null ||
        registryLabelContainerIds(transport).length
      ) {
        throw new Error("A managed portable registry container remains after removal");
      }
      transport.assertRuntimeAuthority();
    },
  };
}

function defaultSystemctl(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): PortablePodmanLifecycleCommandResult {
  const result = spawnSync("systemctl", [...args], {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
    ...(result.error ? { error: result.error } : {}),
  };
}

function parseUserManagerEnvironment(output: string): Map<string, string> {
  if (Buffer.byteLength(output, "utf8") > MAX_SYSTEMD_ENVIRONMENT_BYTES || output.includes("\0")) {
    throw new Error("The current-user systemd manager environment is too large or invalid");
  }
  const values = new Map<string, string>();
  for (const line of output.split(/\r?\n/u)) {
    if (!line) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
    if (!match) throw new Error("The current-user systemd manager environment is malformed");
    const name = match[1]!;
    if (values.has(name)) {
      throw new Error(`The current-user systemd manager environment repeats '${name}'`);
    }
    values.set(name, match[2]!);
  }
  return values;
}

function inspectPortableUserManagerEnvironment(
  authority: CheckpointPortableRuntimeAuthority,
  env: NodeJS.ProcessEnv,
  deps: PortableRuntimeCleanupDeps,
): {
  readonly commandEnv: NodeJS.ProcessEnv;
  readonly systemctl: NonNullable<PortableRuntimeCleanupDeps["systemctl"]>;
  readonly values: ReadonlyMap<string, string | undefined>;
} {
  const systemctl = deps.systemctl ?? defaultSystemctl;
  const commandEnv = portablePodmanCommandEnvironment(authority, env);
  const show = systemctl(["--user", "show-environment"], commandEnv);
  requireCommand(show, "Inspecting the current-user systemd manager environment");
  const current = parseUserManagerEnvironment(String(show.stdout ?? ""));
  return {
    commandEnv,
    systemctl,
    values: new Map(PORTABLE_SELECTOR_NAMES.map((name) => [name, current.get(name)])),
  };
}

function clearPortableUserManagerSelectors(
  authority: CheckpointPortableRuntimeAuthority,
  env: NodeJS.ProcessEnv,
  deps: PortableRuntimeCleanupDeps,
): string[] {
  const { commandEnv, systemctl, values } = inspectPortableUserManagerEnvironment(
    authority,
    env,
    deps,
  );
  const expected = new Map<string, string>([
    ["CONTAINERS_CONF", path.join(authority.configHome, "nemoclaw", "portable", "containers.conf")],
    ["NETAVARK_FW", "iptables"],
  ]);
  const unset = [...expected.entries()]
    .filter(([name, value]) =>
      [value, `$'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`].includes(
        values.get(name) ?? "",
      ),
    )
    .map(([name]) => name);
  if (unset.length === 0) return [];
  requireCommand(
    systemctl(["--user", "unset-environment", ...unset], commandEnv),
    "Clearing NemoClaw portable selectors from the current-user systemd manager",
  );
  const verified = systemctl(["--user", "show-environment"], commandEnv);
  requireCommand(verified, "Verifying the current-user systemd manager environment");
  const remaining = parseUserManagerEnvironment(String(verified.stdout ?? ""));
  if (unset.some((name) => remaining.has(name))) {
    throw new Error("A NemoClaw portable selector remains in the current-user systemd manager");
  }
  return unset;
}
