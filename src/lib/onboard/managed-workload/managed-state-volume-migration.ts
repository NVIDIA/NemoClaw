// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureConfigDir, rejectSymlinksOnPath, writeConfigFile } from "../../state/config-io";
import { resolveNemoclawStateDir } from "../../state/paths";
import { withMcpLifecycleLockSync } from "../../state/mcp-lifecycle-lock-acquisition";
import type { ManagedStartupStateRoot } from "../managed-startup/state-roots";
import {
  MANAGED_STATE_COPY_IMAGE,
  managedStateVolumeCopyProgram,
} from "./managed-state-volume-copy";

type Root = Pick<ManagedStartupStateRoot, "resourceIdentity" | "ownershipLabels" | "mountTarget">;
export type MigrationEngine = (
  args: readonly string[],
  timeoutMs?: number,
) => {
  readonly status: number | null;
  readonly stdout?: string | Buffer;
  readonly stderr?: string | Buffer;
  readonly error?: Error;
};
export interface ManagedVolumeMigrationContext {
  readonly providerId: string;
  readonly workspace: string;
  readonly stateDir?: string;
}
type Journal = {
  schemaVersion: 1;
  binding: string;
  source: string;
  destination: string;
  phase: "copying" | "verified" | "retired";
  helper: string;
  sourceFingerprint: string;
  destinationFingerprint: string | null;
  copySha256: string | null;
};
const HASH = /^[a-f0-9]{64}$/u;
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/u;
const MIGRATION_LABEL = "io.nvidia.nemoclaw.state-migration";
const COPY_TIMEOUT_MS = 15 * 60_000;

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function fail(reason: string): never {
  throw new Error(`Managed state migration stopped: ${reason}. Original volume retained.`);
}
function identity(root: Root, context: ManagedVolumeMigrationContext) {
  if (!NAME.test(root.resourceIdentity) || !context.providerId || !context.workspace)
    fail("invalid scope");
  const binding = hash(
    JSON.stringify([
      context.providerId,
      context.workspace,
      root.resourceIdentity,
      root.mountTarget,
      Object.entries(root.ownershipLabels).sort(([a], [b]) => a.localeCompare(b)),
    ]),
  );
  return {
    binding,
    destination: `${root.resourceIdentity.slice(0, 160)}-os012-${binding.slice(0, 16)}`,
    file: path.join(
      context.stateDir ?? resolveNemoclawStateDir(),
      "managed-volume-migrations",
      `${binding}.json`,
    ),
  };
}
function readJournal(root: Root, context: ManagedVolumeMigrationContext): Journal | null {
  const expected = identity(root, context);
  rejectSymlinksOnPath(expected.file);
  requirePrivateDirectory(path.dirname(expected.file));
  let descriptor: number;
  try {
    descriptor = fs.openSync(expected.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > 8192 ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      fail("unsafe migration journal");
    const value = JSON.parse(fs.readFileSync(descriptor, "utf8")) as Journal;
    if (
      !value ||
      value.schemaVersion !== 1 ||
      value.binding !== expected.binding ||
      value.source !== root.resourceIdentity ||
      value.destination !== expected.destination ||
      !["copying", "verified", "retired"].includes(value.phase) ||
      typeof value.helper !== "string" ||
      !NAME.test(value.helper) ||
      typeof value.sourceFingerprint !== "string" ||
      !HASH.test(value.sourceFingerprint) ||
      !(
        value.destinationFingerprint === null ||
        (typeof value.destinationFingerprint === "string" &&
          HASH.test(value.destinationFingerprint))
      ) ||
      !(
        value.copySha256 === null ||
        (typeof value.copySha256 === "string" && HASH.test(value.copySha256))
      ) ||
      (value.phase === "verified" && value.destinationFingerprint === null) ||
      (value.phase !== "verified" && value.destinationFingerprint !== null)
    )
      fail("invalid migration journal");
    return value;
  } finally {
    fs.closeSync(descriptor);
  }
}
function requirePrivateDirectory(directory: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    fail("unsafe migration journal directory");
}
function save(root: Root, context: ManagedVolumeMigrationContext, journal: Journal): void {
  const { file } = identity(root, context);
  requirePrivateDirectory(path.dirname(file));
  ensureConfigDir(path.dirname(file));
  rejectSymlinksOnPath(file);
  writeConfigFile(file, journal);
}
function checked(run: MigrationEngine, args: readonly string[], timeoutMs = 30_000): string {
  const result = run(args, timeoutMs);
  if (result.status !== 0 || result.error)
    fail(`command ${args[0]} failed; inspect retained migration state before retrying`);
  return String(result.stdout ?? "").trim();
}
function inspectVolume(run: MigrationEngine, name: string): Record<string, unknown> {
  const value: unknown = JSON.parse(
    checked(run, ["volume", "inspect", "--format", "{{json .}}", name]),
  );
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("invalid volume observation");
  const volume = value as Record<string, unknown>;
  if (
    volume.Name !== name ||
    volume.Driver !== "local" ||
    volume.Scope !== "local" ||
    typeof volume.CreatedAt !== "string" ||
    !Number.isFinite(Date.parse(volume.CreatedAt)) ||
    typeof volume.Mountpoint !== "string" ||
    !path.posix.isAbsolute(volume.Mountpoint) ||
    !(
      volume.Options == null ||
      (typeof volume.Options === "object" &&
        !Array.isArray(volume.Options) &&
        Object.keys(volume.Options).length === 0)
    )
  ) {
    fail("only an inspected local volume without driver options can migrate");
  }
  return volume;
}
function fingerprint(volume: Record<string, unknown>): string {
  return hash(
    JSON.stringify([
      volume.Name,
      volume.Driver,
      volume.Scope,
      volume.CreatedAt,
      volume.Mountpoint,
      Object.entries((volume.Labels ?? {}) as Record<string, unknown>).sort(([a], [b]) =>
        a.localeCompare(b),
      ),
    ]),
  );
}
function requireLabels(
  volume: Record<string, unknown>,
  expected: Readonly<Record<string, string>>,
): void {
  const labels = volume.Labels as Record<string, unknown> | null;
  if (
    !labels ||
    typeof labels !== "object" ||
    Array.isArray(labels) ||
    !Object.entries(expected).every(([key, value]) => labels[key] === value)
  )
    fail("volume ownership or attachment approval changed");
}
function approval(context: ManagedVolumeMigrationContext) {
  return {
    "openshell.ai/sandbox-attachable": "true",
    "openshell.ai/sandbox-attachable-workspace": context.workspace,
  };
}
function requireUnused(run: MigrationEngine, name: string): void {
  if (
    checked(run, [
      "ps",
      "--all",
      "--no-trunc",
      "--filter",
      `volume=${name}`,
      "--format",
      "{{.ID}}",
    ]) !== ""
  ) {
    fail(
      "volume is still attached to a container; finish the owned sandbox deletion before migrating",
    );
  }
}

/** Shared by copy, selection and destruction; nested lifecycle calls reuse the lease. */
export function withManagedStateVolumeLock<T>(
  root: Root,
  context: ManagedVolumeMigrationContext,
  operation: () => T,
): T {
  return withMcpLifecycleLockSync(
    `volume-migration-${identity(root, context).binding}`,
    operation,
    {
      stateDir: context.stateDir ?? resolveNemoclawStateDir(),
    },
  );
}

/** Before deleting an owned source sandbox, reject unsupported legacy storage. */
export function preflightLegacyManagedStateVolume(root: Root, run: MigrationEngine): void {
  const source = inspectVolume(run, root.resourceIdentity);
  requireLabels(source, root.ownershipLabels);
}

/** Read-only selection used by create, rebuild, snapshot and destruction. */
export function resolveMigratedManagedStateRoot<T extends Root>(
  root: T,
  context: ManagedVolumeMigrationContext,
  allowRetired = false,
): T {
  const journal = readJournal(root, context);
  if (!journal) return root;
  if (journal.phase === "copying")
    fail("an incomplete copy requires reconciliation; it will not be adopted or retried");
  if (journal.phase === "retired" && !allowRetired) fail("the migrated volume was retired");
  return {
    ...root,
    resourceIdentity: journal.destination,
    ownershipLabels: { ...root.ownershipLabels, [MIGRATION_LABEL]: journal.binding },
  };
}

export function managedStateVolumeMigrationPhase(
  root: Root,
  context: ManagedVolumeMigrationContext,
): Journal["phase"] | null {
  return readJournal(root, context)?.phase ?? null;
}

/** Destruction retires only the selected copy; the original remains a rollback resource. */
export function retireManagedStateVolumeMigration(
  root: Root,
  context: ManagedVolumeMigrationContext,
): void {
  withManagedStateVolumeLock(root, context, () => {
    const journal = readJournal(root, context);
    if (!journal || journal.phase !== "verified") fail("no verified migration can be retired");
    save(root, context, { ...journal, phase: "retired", destinationFingerprint: null });
  });
}

/** After explicit destruction, fresh onboarding must not resurrect the old backup. */
export function commitManagedStateVolumeReplacement(
  root: Root,
  context: ManagedVolumeMigrationContext,
  run: MigrationEngine,
): void {
  withManagedStateVolumeLock(root, context, () => {
    const journal = readJournal(root, context);
    if (!journal || journal.phase !== "retired")
      fail("no retired migration can accept a replacement");
    const destination = inspectVolume(run, journal.destination);
    requireLabels(destination, {
      ...root.ownershipLabels,
      ...approval(context),
      [MIGRATION_LABEL]: journal.binding,
    });
    save(root, context, {
      ...journal,
      phase: "verified",
      destinationFingerprint: fingerprint(destination),
      copySha256: null,
    });
  });
}

export function verifyMigratedManagedStateRoot(
  root: Root,
  context: ManagedVolumeMigrationContext,
  run: MigrationEngine,
): void {
  const journal = readJournal(root, context);
  if (!journal) return;
  if (journal.phase !== "verified") fail("migration is not active");
  const destination = inspectVolume(run, journal.destination);
  requireLabels(destination, {
    ...root.ownershipLabels,
    ...approval(context),
    [MIGRATION_LABEL]: journal.binding,
  });
  if (fingerprint(destination) !== journal.destinationFingerprint)
    fail("migrated volume identity changed");
}

/** Called only after source-container absence and before candidate attachment. */
export function migrateManagedStateVolume(
  root: Root,
  context: ManagedVolumeMigrationContext,
  run: MigrationEngine,
): Root {
  const scope = identity(root, context);
  return withManagedStateVolumeLock(root, context, () => {
    const prior = readJournal(root, context);
    if (prior) {
      if (prior.phase !== "verified") fail("prior migration requires reconciliation");
      verifyMigratedManagedStateRoot(root, context, run);
      return resolveMigratedManagedStateRoot(root, context);
    }
    const source = inspectVolume(run, root.resourceIdentity);
    requireLabels(source, root.ownershipLabels);
    const labels = source.Labels as Record<string, unknown>;
    if (
      labels["openshell.ai/sandbox-attachable"] !== undefined ||
      labels["openshell.ai/sandbox-attachable-workspace"] !== undefined
    )
      fail("conflicting legacy approval labels");
    requireUnused(run, root.resourceIdentity);
    const existing = checked(run, ["volume", "ls", "--format", "{{.Name}}"]);
    if (existing.split(/\r?\n/u).includes(scope.destination))
      fail("migration destination already exists without a receipt");
    // Pull by the existing immutable helper digest, before creating destination data.
    const image = run(["image", "inspect", MANAGED_STATE_COPY_IMAGE], 30_000);
    if (image.status !== 0 || image.error)
      checked(run, ["pull", "--quiet", MANAGED_STATE_COPY_IMAGE], 120_000);
    const helper = `nemoclaw-volume-copy-${randomUUID()}`;
    const journal: Journal = {
      schemaVersion: 1,
      binding: scope.binding,
      source: root.resourceIdentity,
      destination: scope.destination,
      phase: "copying",
      helper,
      sourceFingerprint: fingerprint(source),
      destinationFingerprint: null,
      copySha256: null,
    };
    save(root, context, journal);
    const destinationLabels = {
      ...root.ownershipLabels,
      ...approval(context),
      [MIGRATION_LABEL]: scope.binding,
    };
    checked(run, [
      "volume",
      "create",
      ...Object.entries(destinationLabels).flatMap(([key, value]) => [
        "--label",
        `${key}=${value}`,
      ]),
      scope.destination,
    ]);
    const destination = inspectVolume(run, scope.destination);
    requireLabels(destination, destinationLabels);
    requireUnused(run, root.resourceIdentity);
    requireUnused(run, scope.destination);
    if (fingerprint(inspectVolume(run, root.resourceIdentity)) !== journal.sourceFingerprint)
      fail("source identity changed");
    const helperId = checked(run, [
      "create",
      "--name",
      helper,
      "--pull",
      "never",
      "--network",
      "none",
      "--read-only",
      "--user",
      "0:0",
      "--security-opt",
      "no-new-privileges",
      "--cap-drop",
      "ALL",
      "--cap-add",
      "DAC_OVERRIDE",
      "--cap-add",
      "CHOWN",
      "--cap-add",
      "FOWNER",
      "--cap-add",
      "FSETID",
      "--pids-limit",
      "64",
      "--label",
      `${MIGRATION_LABEL}=${scope.binding}`,
      "--mount",
      `type=volume,src=${root.resourceIdentity},dst=/source,readonly,volume-nocopy`,
      "--mount",
      `type=volume,src=${scope.destination},dst=/destination,volume-nocopy`,
      "--entrypoint",
      "/usr/local/bin/node",
      MANAGED_STATE_COPY_IMAGE,
      "-e",
      managedStateVolumeCopyProgram(),
    ]);
    if (!HASH.test(helperId)) fail("helper creation returned an ambiguous identity");
    let result: ReturnType<MigrationEngine>;
    try {
      result = run(["start", "--attach", helperId], COPY_TIMEOUT_MS);
    } finally {
      // Remove only the full helper ID returned by this creation, never a shared name or volume.
      checked(run, ["rm", "--force", helperId]);
      const remaining = checked(run, [
        "ps",
        "--all",
        "--no-trunc",
        "--filter",
        `id=${helperId}`,
        "--format",
        "{{.ID}}",
      ]);
      if (remaining !== "") fail("helper absence was not established");
    }
    if (result.status !== 0 || result.error)
      fail("copy did not finish; partial destination remains unselected");
    const copied = JSON.parse(String(result.stdout ?? "")) as {
      schemaVersion?: unknown;
      sha256?: unknown;
    };
    if (
      copied.schemaVersion !== 1 ||
      typeof copied.sha256 !== "string" ||
      !HASH.test(copied.sha256)
    )
      fail("copy verification receipt is invalid");
    requireUnused(run, root.resourceIdentity);
    requireUnused(run, scope.destination);
    if (
      fingerprint(inspectVolume(run, root.resourceIdentity)) !== journal.sourceFingerprint ||
      fingerprint(inspectVolume(run, scope.destination)) !== fingerprint(destination)
    )
      fail("volume identity changed during copying");
    save(root, context, {
      ...journal,
      phase: "verified",
      destinationFingerprint: fingerprint(destination),
      copySha256: copied.sha256,
    });
    return resolveMigratedManagedStateRoot(root, context);
  });
}
