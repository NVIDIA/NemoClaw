// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual, TextDecoder } from "node:util";

import {
  acquireOnboardLock,
  assertOnboardLockOwned,
  normalizeSession,
  releaseOnboardLock,
  type LockResult,
} from "../state/onboard-session";
import { assertHermesPortableUninstallCompleteForOnboarding } from "../state/hermes-portable-uninstall/journal";
import {
  inspectPortableOnboardSupersession,
  inspectPortableRetirementRecovery,
  PORTABLE_RETIREMENT_STATE_ENTRIES,
  provePortableOnboardAuthority,
  readPortableAuthorityDirectory,
  readPortableAuthoritySnapshot,
  resumePortableEvidenceRetirement,
  resumePortableOnboardReplacementEvidence,
  samePortableAuthorityDirectory,
  supersedePortableRetirementAfterOnboard,
  withPortableHostFence,
  type PortableRetirementRecovery,
  type PortableOnboardAuthorityAdmission,
} from "../state/portable-uninstall-retirement";
import { withRegistryLockAt } from "../state/registry/lock";
import { listPortableDemoSandboxLifecycleReceipts } from "./experimental/portable-demo-lifecycle";

const UTF8 = new TextDecoder("utf-8", { fatal: true });
const PORTABLE_ARTIFACT_NAME = /portable-uninstall/u;
const GENERATION = /^[A-Za-z0-9._:-]{1,256}$/u;

export interface PortableOnboardRetirementBoundary {
  readonly homeDir: string;
  readonly registryFile: string;
  readonly sessionFile: string;
  readonly stateDir: string;
}
type Profile = "default" | "portable";
interface Registry {
  readonly defaultSandbox: string | null;
  readonly sandboxes: Record<
    string,
    {
      readonly agent?: string | null;
      readonly dashboardPort?: number | null;
      readonly gatewayName?: string | null;
      readonly gatewayPort?: number | null;
      readonly lifecycleGeneration?: string;
      readonly name: string;
      readonly openshellDriver?: string | null;
      readonly pendingRouteReservation?: boolean;
    }
  >;
}
export interface PortableAuthorityAdmissionDeps {
  readonly listReceipts?: typeof listPortableDemoSandboxLifecycleReceipts;
  readonly loadRegistry: () => Registry;
}
export interface PortableRetirementAuthorityDeps extends PortableAuthorityAdmissionDeps {
  readonly withLifecycleLock: <T>(
    sandboxName: string,
    operation: () => Promise<T> | T,
  ) => Promise<T>;
}

export interface PortableOnboardRetirementEntryOptions extends PortableRetirementAuthorityDeps {
  readonly alreadyHeld: boolean;
  readonly command: string;
  readonly displayName: string;
  readonly homeDir: string;
  readonly registryFile: string;
  readonly sessionFile: string;
}

function strictJson(bytes: Buffer, description: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(UTF8.decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new Error(`${description} is malformed`);
  }
}

function completedSession(bytes: Buffer, expected?: Profile) {
  const raw = strictJson(bytes, "Completed onboarding session");
  const session = normalizeSession(raw as never);
  const checkpoint = session?.checkpoint;
  const rawMachine = raw.machine;
  const rawCheckpoint = raw.checkpoint;
  const rawMetadata = raw.metadata;
  if (
    raw.version !== 1 ||
    typeof raw.sessionId !== "string" ||
    raw.sessionId.length === 0 ||
    typeof raw.sandboxName !== "string" ||
    raw.sandboxName.length === 0 ||
    (raw.agent !== null && typeof raw.agent !== "string") ||
    raw.status !== "complete" ||
    raw.resumable !== false ||
    !rawMachine ||
    typeof rawMachine !== "object" ||
    Array.isArray(rawMachine) ||
    (rawMachine as Record<string, unknown>).version !== 1 ||
    (rawMachine as Record<string, unknown>).state !== "complete" ||
    !Number.isSafeInteger((rawMachine as Record<string, unknown>).revision) ||
    ((rawMachine as Record<string, unknown>).revision as number) < 0 ||
    !rawCheckpoint ||
    typeof rawCheckpoint !== "object" ||
    Array.isArray(rawCheckpoint) ||
    (rawCheckpoint as Record<string, unknown>).schemaVersion !== 4 ||
    (rawCheckpoint as Record<string, unknown>).sessionId !== raw.sessionId ||
    (rawCheckpoint as Record<string, unknown>).machineState !== "complete" ||
    !session ||
    session.sessionId !== raw.sessionId ||
    session.status !== "complete" ||
    session.resumable !== false ||
    session.machine.state !== "complete" ||
    session.machine.revision !== (rawMachine as Record<string, unknown>).revision ||
    session.sandboxName !== raw.sandboxName ||
    !checkpoint ||
    checkpoint.machineState !== "complete" ||
    checkpoint.sessionId !== session.sessionId ||
    checkpoint.profile.kind !== "selected" ||
    (checkpoint.profile.value !== "default" && checkpoint.profile.value !== "portable") ||
    (expected !== undefined && checkpoint.profile.value !== expected) ||
    checkpoint.sandboxIdentity.kind !== "selected" ||
    checkpoint.sandboxIdentity.value.name !== session.sandboxName ||
    checkpoint.sandboxIdentity.value.agent !== (session.agent ?? "openclaw") ||
    checkpoint.gatewayAuthority.kind !== "selected" ||
    !rawMetadata ||
    typeof rawMetadata !== "object" ||
    Array.isArray(rawMetadata) ||
    typeof (rawMetadata as Record<string, unknown>).gatewayName !== "string" ||
    session.metadata.gatewayName !== checkpoint.gatewayAuthority.value.gatewayName
  )
    throw new Error("Completed onboarding session authority is incomplete");
  return session;
}

function verifyAuthority(
  boundary: PortableOnboardRetirementBoundary,
  expected: Profile,
  snapshots: ReadonlyMap<string, Buffer>,
  deps: PortableAuthorityAdmissionDeps,
  recovery: PortableRetirementRecovery | null,
): void {
  const sessionBytes = snapshots.get(boundary.sessionFile);
  const registryBytes = snapshots.get(boundary.registryFile);
  if (!sessionBytes || !registryBytes) throw new Error("Completed onboarding files are missing");
  const session = completedSession(sessionBytes, expected);
  const checkpoint = session.checkpoint!;
  const sandboxName = session.sandboxName!;
  const identity =
    checkpoint.sandboxIdentity.kind === "selected" ? checkpoint.sandboxIdentity.value : null;
  const gateway =
    checkpoint.gatewayAuthority.kind === "selected" ? checkpoint.gatewayAuthority.value : null;
  const rawRegistry = strictJson(registryBytes, "Completed onboarding registry");
  const rawSandboxes = rawRegistry.sandboxes;
  const rawRow =
    rawSandboxes && typeof rawSandboxes === "object" && !Array.isArray(rawSandboxes)
      ? (rawSandboxes as Record<string, unknown>)[sandboxName]
      : null;
  const rawEntry =
    rawRow && typeof rawRow === "object" && !Array.isArray(rawRow)
      ? (rawRow as Record<string, unknown>)
      : null;
  if (!fs.readFileSync(boundary.registryFile).equals(registryBytes))
    throw new Error("Completed onboarding registry bytes changed before normalization");
  const registry = deps.loadRegistry();
  if (!fs.readFileSync(boundary.registryFile).equals(registryBytes))
    throw new Error("Completed onboarding registry changed while normalizing");
  const row = registry.sandboxes[sandboxName];
  const matchesRegistryAgent = (agent: unknown) =>
    agent === identity?.agent || (identity?.agent === "openclaw" && agent === null);
  if (
    identity &&
    rawEntry &&
    row &&
    (rawEntry.agent !== row.agent || !matchesRegistryAgent(row.agent))
  )
    throw new Error(
      `Completed onboarding registry field "agent" does not match trusted onboarding for sandbox ${JSON.stringify(sandboxName)}. Restore the registry entry from trusted completed-onboarding state, then retry uninstall.`,
    );
  if (
    !identity ||
    !gateway ||
    !rawEntry ||
    rawRegistry.defaultSandbox !== sandboxName ||
    registry.defaultSandbox !== sandboxName ||
    row?.name !== sandboxName ||
    rawEntry.name !== sandboxName ||
    row.pendingRouteReservation === true ||
    row.openshellDriver !== "docker" ||
    rawEntry.openshellDriver !== "docker" ||
    row.gatewayName !== gateway.gatewayName ||
    rawEntry.gatewayName !== gateway.gatewayName ||
    row.gatewayPort !== gateway.gatewayPort ||
    rawEntry.gatewayPort !== gateway.gatewayPort ||
    typeof row.lifecycleGeneration !== "string" ||
    !GENERATION.test(row.lifecycleGeneration) ||
    rawEntry.lifecycleGeneration !== row.lifecycleGeneration ||
    rawEntry.dashboardPort !== row.dashboardPort ||
    (row.dashboardPort !== null && !Number.isInteger(row.dashboardPort))
  )
    throw new Error("Completed onboarding registry authority is incomplete");
  const portableStateRoot = path.join(boundary.homeDir, ".nemoclaw");
  const receiptDirectory = path.join(portableStateRoot, "portable-demo-lifecycle");
  const configDirectory = readPortableAuthorityDirectory(
    path.join(boundary.homeDir, ".config/nemoclaw/portable"),
    expected === "portable",
  );
  const receiptDirectoryBefore = readPortableAuthorityDirectory(
    receiptDirectory,
    expected === "portable",
  );
  const admittedArtifacts = (root: "config" | "receipt" | "registry") =>
    new Set(
      recovery?.artifacts
        .filter((artifact) => artifact.root === root)
        .map((artifact) => artifact.basename) ?? [],
    );
  const receiptArtifacts = admittedArtifacts("receipt");
  const configArtifacts = admittedArtifacts("config");
  if (receiptArtifacts.size || configArtifacts.size)
    throw new Error("Completed onboarding still has staged portable uninstall evidence");
  const receipts = (deps.listReceipts ?? listPortableDemoSandboxLifecycleReceipts)(
    portableStateRoot,
  );
  const receiptDirectoryAfter = readPortableAuthorityDirectory(
    receiptDirectory,
    expected === "portable",
  );
  if (!samePortableAuthorityDirectory(receiptDirectoryBefore, receiptDirectoryAfter))
    throw new Error("Portable lifecycle receipt directory changed while normalizing");
  const receiptEntries = receiptDirectoryBefore.entries.filter(
    (entry) => !receiptArtifacts.has(entry),
  );
  const configEntries = configDirectory.entries.filter((entry) => !configArtifacts.has(entry));
  if (expected === "default") {
    if (checkpoint.runtimeAuthority.kind !== "unset" || receiptEntries.length || receipts.length)
      throw new Error("Completed ordinary onboarding has portable receipt authority");
    if (configEntries.length)
      throw new Error("Completed ordinary onboarding has portable configuration authority");
  } else {
    const basename = `${createHash("sha256").update(sandboxName).digest("hex")}.json`;
    const receipt = receipts.find((candidate) => candidate.sandboxName === sandboxName);
    const receiptBytes = snapshots.get(path.join(receiptDirectory, basename));
    const rawReceipt = receiptBytes ? strictJson(receiptBytes, "Portable lifecycle receipt") : null;
    if (
      checkpoint.runtimeAuthority.kind !== "selected" ||
      identity.agent !== "openclaw" ||
      checkpoint.runtimeAuthority.value.uid !== process.getuid?.() ||
      checkpoint.runtimeAuthority.value.homeDir !== boundary.homeDir ||
      !isDeepStrictEqual(configEntries, ["containers.conf"]) ||
      !readPortableAuthoritySnapshot(
        path.join(boundary.homeDir, ".config/nemoclaw/portable/containers.conf"),
        64 * 1_024,
      ) ||
      receiptEntries.length !== 1 ||
      receiptEntries[0] !== basename ||
      receipts.length !== 1 ||
      !receipt ||
      !rawReceipt ||
      Object.keys(rawReceipt).sort().join() !==
        "containerId,dashboardPort,registryGeneration,runtimeAuthority,sandboxId,sandboxName,schemaVersion" ||
      rawReceipt.schemaVersion !== 4 ||
      rawReceipt.sandboxName !== receipt.sandboxName ||
      rawReceipt.sandboxId !== receipt.sandboxId ||
      rawReceipt.containerId !== receipt.containerId ||
      rawReceipt.dashboardPort !== receipt.dashboardPort ||
      rawReceipt.registryGeneration !== receipt.registryGeneration ||
      !isDeepStrictEqual(rawReceipt.runtimeAuthority, receipt.runtimeAuthority) ||
      !isDeepStrictEqual(receipt.runtimeAuthority, checkpoint.runtimeAuthority.value) ||
      receipt.registryGeneration !== row.lifecycleGeneration ||
      receipt.dashboardPort !== row.dashboardPort
    )
      throw new Error("Completed portable onboarding authority is incomplete");
  }
  rejectUnknownRetirementArtifacts(boundary.homeDir, recovery);
}

function artifactDirectory(homeDir: string, root: "config" | "receipt" | "registry"): string {
  return root === "config"
    ? path.join(homeDir, ".config/nemoclaw/portable")
    : root === "receipt"
      ? path.join(homeDir, ".nemoclaw/portable-demo-lifecycle")
      : path.join(homeDir, ".nemoclaw");
}

function rejectUnknownRetirementArtifacts(
  homeDir: string,
  recovery: PortableRetirementRecovery | null,
  required = true,
  permitAnyMode = false,
): void {
  const directories = new Map<string, Set<string>>([
    [path.join(homeDir, ".nemoclaw"), new Set(PORTABLE_RETIREMENT_STATE_ENTRIES)],
    [path.join(homeDir, ".nemoclaw/portable-demo-lifecycle"), new Set()],
    [path.join(homeDir, ".config/nemoclaw/portable"), new Set()],
  ]);
  for (const artifact of recovery?.artifacts ?? [])
    directories.get(artifactDirectory(homeDir, artifact.root))!.add(artifact.basename);
  for (const [directory, allowed] of directories) {
    if (
      readPortableAuthorityDirectory(
        directory,
        required && directory === path.join(homeDir, ".nemoclaw"),
        permitAnyMode,
      ).entries.some((name) => PORTABLE_ARTIFACT_NAME.test(name) && !allowed.has(name))
    )
      throw new Error("Onboarding state contains an unknown portable uninstall artifact");
  }
}

function recordedSandboxNames(registryBytes: Buffer): string[] {
  const registry = strictJson(registryBytes, "Recorded portable registry");
  const sandboxes = registry.sandboxes;
  if (!sandboxes || typeof sandboxes !== "object" || Array.isArray(sandboxes))
    throw new Error("Recorded portable registry authority is incomplete");
  const names = Object.entries(sandboxes).map(([name, value]) => {
    if (
      name.length < 1 ||
      name.length > 256 ||
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      (value as Record<string, unknown>).name !== name
    )
      throw new Error("Recorded portable registry sandbox identity is invalid");
    return name;
  });
  if (!names.length) throw new Error("Recorded portable registry has no sandbox authority");
  return names.sort();
}

async function resumeBeforeOnboard(
  boundary: PortableOnboardRetirementBoundary,
  recovery: PortableRetirementRecovery,
  deps: PortableRetirementAuthorityDeps,
  replacement = false,
): Promise<void> {
  if (!recovery.registryBytes) return;
  const names = recordedSandboxNames(recovery.registryBytes);
  const lock = (index: number): Promise<void> =>
    index === names.length
      ? Promise.resolve(
          withRegistryLockAt(boundary.registryFile, () => {
            const current = replacement
              ? inspectPortableOnboardSupersession(boundary.homeDir)
              : inspectPortableRetirementRecovery(boundary.homeDir);
            rejectUnknownRetirementArtifacts(boundary.homeDir, current);
            if (!current) throw new Error("Portable uninstall recovery authority disappeared");
            (replacement
              ? resumePortableOnboardReplacementEvidence
              : resumePortableEvidenceRetirement)(boundary.homeDir);
          }),
        )
      : deps.withLifecycleLock(names[index]!, () => lock(index + 1));
  await lock(0);
}

function admission(
  boundary: PortableOnboardRetirementBoundary,
  expected: Profile,
  deps: PortableAuthorityAdmissionDeps,
  recovery: PortableRetirementRecovery | null = null,
): PortableOnboardAuthorityAdmission {
  const sessionBytes = readPortableAuthoritySnapshot(boundary.sessionFile);
  if (!sessionBytes) throw new Error("Completed onboarding session is missing");
  const session = completedSession(sessionBytes, expected);
  const receipt =
    expected === "portable"
      ? path.join(
          path.join(boundary.homeDir, ".nemoclaw"),
          "portable-demo-lifecycle",
          `${createHash("sha256").update(session.sandboxName!).digest("hex")}.json`,
        )
      : null;
  const files = [boundary.sessionFile, boundary.registryFile, ...(receipt ? [receipt] : [])];
  return {
    files,
    verify: (snapshots) => verifyAuthority(boundary, expected, snapshots, deps, recovery),
  };
}

function lockedAuthority<T>(
  boundary: PortableOnboardRetirementBoundary,
  expected: Profile,
  deps: PortableRetirementAuthorityDeps,
  operation: (authority: PortableOnboardAuthorityAdmission) => T,
): Promise<T> {
  const initial = readPortableAuthoritySnapshot(boundary.sessionFile);
  if (!initial) throw new Error("Completed onboarding session is missing");
  const sandboxName = completedSession(initial, expected).sandboxName!;
  return deps.withLifecycleLock(sandboxName, () =>
    withRegistryLockAt(boundary.registryFile, () => {
      const current = readPortableAuthoritySnapshot(boundary.sessionFile);
      if (!current || completedSession(current, expected).sandboxName !== sandboxName)
        throw new Error("Completed onboarding sandbox authority changed before locking");
      return operation(
        admission(boundary, expected, deps, inspectPortableOnboardSupersession(boundary.homeDir)),
      );
    }),
  );
}

async function recover(
  boundary: PortableOnboardRetirementBoundary,
  deps: PortableRetirementAuthorityDeps,
): Promise<void> {
  readPortableAuthorityDirectory(boundary.stateDir, false);
  let recovery: PortableRetirementRecovery | null;
  try {
    recovery = inspectPortableRetirementRecovery(boundary.homeDir);
  } catch (error) {
    const replacement = inspectPortableOnboardSupersession(boundary.homeDir);
    rejectUnknownRetirementArtifacts(boundary.homeDir, replacement, true);
    const bytes = readPortableAuthoritySnapshot(boundary.sessionFile);
    if (!bytes) throw error;
    const raw = strictJson(bytes, "Onboarding session");
    if (raw.status !== "complete" || raw.resumable !== false) {
      const session = normalizeSession(raw as never);
      if (
        replacement?.fixedState !== "1000" ||
        !session ||
        session.resumable !== true ||
        session.status === "complete"
      )
        throw error;
      await resumeBeforeOnboard(boundary, replacement, deps, true);
      const current = inspectPortableOnboardSupersession(boundary.homeDir);
      rejectUnknownRetirementArtifacts(boundary.homeDir, current, true);
      if (!current || current.artifacts.length || current.registryBytes)
        throw new Error("Portable onboarding replacement recovery is incomplete");
      return;
    }
    if (replacement?.fixedState === "1000" && replacement.registryBytes)
      await resumeBeforeOnboard(boundary, replacement, deps, true);
    const session = completedSession(bytes);
    await lockedAuthority(boundary, session.checkpoint!.profile.value, deps, (authority) =>
      supersedePortableRetirementAfterOnboard(boundary.homeDir, authority),
    );
    return;
  }
  rejectUnknownRetirementArtifacts(boundary.homeDir, recovery, recovery !== null);
  if (!recovery) return;
  await resumeBeforeOnboard(boundary, recovery, deps);
  const completed = inspectPortableRetirementRecovery(boundary.homeDir);
  rejectUnknownRetirementArtifacts(boundary.homeDir, completed);
}

/**
 * Report whether uninstall must run portable runtime cleanup.
 *
 * A retirement record or lifecycle receipt establishes portable ownership. A
 * completed onboarding session also has to remain consistent with that durable
 * evidence. With none present, the portable transaction throws before it
 * acquires its fences, so uninstall reports no portable cleanup for each of
 * these states:
 *
 * - An onboarding session that never reached a runtime.
 * - A missing onboarding session.
 * - A missing state directory.
 * - A portable configuration directory abandoned by an earlier run.
 *
 * Ordinary uninstall then removes the state directory and the portable
 * configuration directory when they exist. That answer still refuses an unknown
 * portable uninstall artifact. It still requires mode 0700 on the state
 * directory and on the receipt directory, because only the leftover check reads
 * a directory whose mode NemoClaw never set. Every read refuses a directory
 * whose entries it cannot list, through a symlink, an owner other than the
 * current user, or an entry count above the cap.
 */
export function hasPortableUninstallAuthority(
  boundary: PortableOnboardRetirementBoundary,
  deps: PortableAuthorityAdmissionDeps,
): boolean {
  readPortableAuthorityDirectory(boundary.stateDir, false);
  const receiptDirectory = readPortableAuthorityDirectory(
    path.join(boundary.stateDir, "portable-demo-lifecycle"),
    false,
  );
  const recovery = inspectPortableRetirementRecovery(boundary.homeDir);
  if (!recovery && !receiptDirectory.entries.length) {
    rejectUnknownRetirementArtifacts(boundary.homeDir, null, false, true);
    const sessionBytes = readPortableAuthoritySnapshot(boundary.sessionFile);
    if (sessionBytes) {
      const raw = strictJson(sessionBytes, "Onboarding session");
      if (raw.status === "complete" && raw.resumable === false) {
        const session = completedSession(sessionBytes);
        const profile = session.checkpoint!.profile.value;
        provePortableOnboardAuthority(admission(boundary, profile, deps));
      }
    }
    return false;
  }
  const configDirectory = readPortableAuthorityDirectory(
    path.join(boundary.homeDir, ".config/nemoclaw/portable"),
    false,
  );
  rejectUnknownRetirementArtifacts(boundary.homeDir, recovery);
  if (recovery) return true;
  const receipts = (deps.listReceipts ?? listPortableDemoSandboxLifecycleReceipts)(
    boundary.stateDir,
  );
  const receiptDirectoryAfter = readPortableAuthorityDirectory(
    path.join(boundary.stateDir, "portable-demo-lifecycle"),
    true,
  );
  if (
    !samePortableAuthorityDirectory(receiptDirectory, receiptDirectoryAfter) ||
    receipts.length !== receiptDirectory.entries.length ||
    !isDeepStrictEqual(configDirectory.entries, ["containers.conf"]) ||
    !readPortableAuthoritySnapshot(
      path.join(boundary.homeDir, ".config/nemoclaw/portable/containers.conf"),
      64 * 1_024,
    )
  )
    throw new Error("Portable uninstall authority is incomplete");
  return true;
}

export async function withPortableOnboardRetirementBoundary<T>(
  boundary: PortableOnboardRetirementBoundary,
  operation: () => Promise<T> | T,
  deps: PortableRetirementAuthorityDeps,
): Promise<T> {
  return await withPortableHostFence(boundary.homeDir, async () => {
    assertHermesPortableUninstallCompleteForOnboarding(boundary.stateDir);
    await recover(boundary, deps);
    return await operation();
  });
}

export async function supersedePortableRetirementAfterCompletedOnboard(
  boundary: PortableOnboardRetirementBoundary,
  expected: Profile,
  deps: PortableRetirementAuthorityDeps,
): Promise<void> {
  const recovery = inspectPortableOnboardSupersession(boundary.homeDir);
  if (recovery === null) return rejectUnknownRetirementArtifacts(boundary.homeDir, recovery);
  await lockedAuthority(boundary, expected, deps, (authority) =>
    supersedePortableRetirementAfterOnboard(boundary.homeDir, authority),
  );
}

export function printPortableOnboardLockContention(
  displayName: string,
  lockResult: LockResult,
): void {
  console.error(`  Another ${displayName} onboarding run is already in progress.`);
  if (lockResult.holderPid) console.error(`  Lock holder PID: ${lockResult.holderPid}`);
  if (lockResult.holderStartedAt) console.error(`  Started: ${lockResult.holderStartedAt}`);
  console.error("  Wait for the active onboarding run to finish.");
  console.error(
    "  If the recorded process is no longer running, rerun this command; NemoClaw verifies stale ownership before removing its lock.",
  );
}

export function beginPortableOnboardRetirementEntry(
  options: PortableOnboardRetirementEntryOptions,
) {
  const ownsOnboardLock = !options.alreadyHeld;
  if (!ownsOnboardLock) assertOnboardLockOwned();
  const lockResult = ownsOnboardLock
    ? acquireOnboardLock(options.command)
    : { acquired: true as const };
  if (!lockResult.acquired) {
    printPortableOnboardLockContention(options.displayName, lockResult);
    process.exit(1);
  }
  const boundary: PortableOnboardRetirementBoundary = {
    homeDir: options.homeDir,
    registryFile: options.registryFile,
    sessionFile: options.sessionFile,
    stateDir: path.dirname(options.sessionFile),
  };
  const deps: PortableRetirementAuthorityDeps = options;
  let released = false;
  const release = () => {
    if (released || !ownsOnboardLock) return;
    released = true;
    process.removeListener("exit", release);
    releaseOnboardLock();
  };
  if (ownsOnboardLock) process.once("exit", release);
  return {
    release,
    run: <T>(operation: () => Promise<T> | T) =>
      withPortableOnboardRetirementBoundary(boundary, operation, deps),
    supersede: (expected: Profile) =>
      supersedePortableRetirementAfterCompletedOnboard(boundary, expected, deps),
  };
}
