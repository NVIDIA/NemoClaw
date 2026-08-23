// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  isPortableUninstallMissingPathError,
  readPortableAuthorityDirectory,
} from "../portable-uninstall-retirement";

export const HERMES_PORTABLE_UNINSTALL_JOURNAL_FILE = "hermes-portable-uninstall-transaction.json";

const MAX_JOURNAL_BYTES = 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;
const FULL_ID = /^[a-f0-9]{64}$/u;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f-\u009f]{1,512}$/u;

export type HermesPortableUninstallPhase =
  | "prepared"
  | "sandboxes-retired"
  | "providers-retired"
  | "inference-retired"
  | "resources-absent"
  | "registry-retired"
  | "receipts-retired"
  | "completed";

export interface HermesPortableUninstallTargetAuthority {
  readonly sandboxName: string;
  readonly gatewayName: string;
  readonly lifecycleGeneration: string;
  readonly registryRowSha256: string;
  readonly lifecycleReceiptSha256: string;
  readonly lifecycleDirectorySha256: string;
  readonly runtimeAuthoritySha256: string;
  readonly openshellExecutableAuthoritySha256: string;
  readonly podmanExecutableAuthoritySha256: string;
  readonly socketAuthoritySha256: string;
  readonly sandboxId: string;
  readonly sandboxContainerId: string;
  readonly sandboxContainerName: string;
  readonly sandboxContainerLabelsSha256: string;
  readonly provider: {
    readonly disposition: "remove" | "preserve-shared";
    readonly id: string;
    readonly resourceVersion: number;
    readonly journalSha256: string;
    readonly sharingAuthoritySha256: string;
  };
  readonly inference: {
    readonly disposition: "remove" | "preserve-shared";
    readonly providerId: string;
    readonly receiptSha256: string;
    readonly sharingAuthoritySha256: string;
    readonly directorySha256: string;
    readonly runtimeId: string;
    readonly containerName: string;
    readonly networkId: string;
    readonly networkAuthoritySha256: string;
  };
}

export interface HermesPortableUninstallAuthority {
  readonly registryPathSha256: string;
  readonly statePathSha256: string;
  readonly targets: readonly HermesPortableUninstallTargetAuthority[];
}

export interface HermesPortableUninstallJournal {
  readonly schemaVersion: 1;
  readonly kind: "hermes-portable-uninstall";
  readonly phase: HermesPortableUninstallPhase;
  readonly authority: HermesPortableUninstallAuthority;
  readonly authoritySha256: string;
}

export interface HermesPortableUninstallJournalStore {
  readonly authoritySha256: (authority: HermesPortableUninstallAuthority) => string;
  readonly read: () => HermesPortableUninstallJournal | null;
  readonly publishPrepared: (
    authority: HermesPortableUninstallAuthority,
  ) => HermesPortableUninstallJournal;
  readonly replacePrepared: (
    current: HermesPortableUninstallJournal,
    authority: HermesPortableUninstallAuthority,
  ) => HermesPortableUninstallJournal;
  readonly replacePhase: (
    current: HermesPortableUninstallJournal,
    phase: HermesPortableUninstallPhase,
  ) => HermesPortableUninstallJournal;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonical(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactText(value: unknown, label: string): string {
  if (typeof value !== "string" || value !== value.trim() || !SAFE_TEXT.test(value)) {
    throw new Error(`Hermes Portable uninstall ${label} is malformed`);
  }
  return value;
}

function exactSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`Hermes Portable uninstall ${label} is malformed`);
  }
  return value;
}

function exactFullId(value: unknown, label: string): string {
  if (typeof value !== "string" || !FULL_ID.test(value)) {
    throw new Error(`Hermes Portable uninstall ${label} is malformed`);
  }
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Hermes Portable uninstall ${label} is malformed`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  if (Object.keys(value).sort().join("\n") !== [...expected].sort().join("\n")) {
    throw new Error(`Hermes Portable uninstall ${label} has unexpected fields`);
  }
}

function normalizeTarget(value: unknown): HermesPortableUninstallTargetAuthority {
  const target = record(value, "target authority");
  exactKeys(
    target,
    [
      "sandboxName",
      "gatewayName",
      "lifecycleGeneration",
      "registryRowSha256",
      "lifecycleReceiptSha256",
      "lifecycleDirectorySha256",
      "runtimeAuthoritySha256",
      "openshellExecutableAuthoritySha256",
      "podmanExecutableAuthoritySha256",
      "socketAuthoritySha256",
      "sandboxId",
      "sandboxContainerId",
      "sandboxContainerName",
      "sandboxContainerLabelsSha256",
      "provider",
      "inference",
    ],
    "target authority",
  );
  const provider = record(target.provider, "provider authority");
  exactKeys(
    provider,
    ["disposition", "id", "resourceVersion", "journalSha256", "sharingAuthoritySha256"],
    "provider authority",
  );
  if (provider.disposition !== "remove" && provider.disposition !== "preserve-shared") {
    throw new Error("Hermes Portable uninstall provider disposition is malformed");
  }
  if (!Number.isSafeInteger(provider.resourceVersion) || Number(provider.resourceVersion) < 1) {
    throw new Error("Hermes Portable uninstall provider revision is malformed");
  }
  const inference = record(target.inference, "inference authority");
  exactKeys(
    inference,
    [
      "disposition",
      "providerId",
      "receiptSha256",
      "sharingAuthoritySha256",
      "directorySha256",
      "runtimeId",
      "containerName",
      "networkId",
      "networkAuthoritySha256",
    ],
    "inference authority",
  );
  if (inference.disposition !== "remove" && inference.disposition !== "preserve-shared") {
    throw new Error("Hermes Portable uninstall inference disposition is malformed");
  }
  return Object.freeze({
    sandboxName: exactText(target.sandboxName, "sandbox name"),
    gatewayName: exactText(target.gatewayName, "gateway name"),
    lifecycleGeneration: exactText(target.lifecycleGeneration, "lifecycle generation"),
    registryRowSha256: exactSha(target.registryRowSha256, "registry row digest"),
    lifecycleReceiptSha256: exactSha(target.lifecycleReceiptSha256, "lifecycle receipt digest"),
    lifecycleDirectorySha256: exactSha(
      target.lifecycleDirectorySha256,
      "lifecycle directory digest",
    ),
    runtimeAuthoritySha256: exactSha(target.runtimeAuthoritySha256, "runtime authority digest"),
    openshellExecutableAuthoritySha256: exactSha(
      target.openshellExecutableAuthoritySha256,
      "OpenShell executable authority digest",
    ),
    podmanExecutableAuthoritySha256: exactSha(
      target.podmanExecutableAuthoritySha256,
      "Podman executable authority digest",
    ),
    socketAuthoritySha256: exactSha(target.socketAuthoritySha256, "socket authority digest"),
    sandboxId: exactText(target.sandboxId, "sandbox ID"),
    sandboxContainerId: exactFullId(target.sandboxContainerId, "sandbox container ID"),
    sandboxContainerName: exactText(target.sandboxContainerName, "sandbox container name"),
    sandboxContainerLabelsSha256: exactSha(
      target.sandboxContainerLabelsSha256,
      "sandbox label digest",
    ),
    provider: Object.freeze({
      disposition: provider.disposition,
      id: exactText(provider.id, "provider ID"),
      resourceVersion: Number(provider.resourceVersion),
      journalSha256: exactSha(provider.journalSha256, "provider journal digest"),
      sharingAuthoritySha256: exactSha(provider.sharingAuthoritySha256, "provider sharing digest"),
    }),
    inference: Object.freeze({
      disposition: inference.disposition,
      providerId: exactText(inference.providerId, "inference provider ID"),
      receiptSha256: exactSha(inference.receiptSha256, "inference receipt digest"),
      sharingAuthoritySha256: exactSha(
        inference.sharingAuthoritySha256,
        "inference sharing digest",
      ),
      directorySha256: exactSha(inference.directorySha256, "inference directory digest"),
      runtimeId: exactFullId(inference.runtimeId, "inference runtime ID"),
      containerName: exactText(inference.containerName, "inference container name"),
      networkId: exactFullId(inference.networkId, "inference network ID"),
      networkAuthoritySha256: exactSha(
        inference.networkAuthoritySha256,
        "inference network authority digest",
      ),
    }),
  });
}

function normalizeAuthority(value: unknown): HermesPortableUninstallAuthority {
  const authority = record(value, "authority");
  exactKeys(authority, ["registryPathSha256", "statePathSha256", "targets"], "authority");
  if (!Array.isArray(authority.targets) || authority.targets.length === 0) {
    throw new Error("Hermes Portable uninstall requires at least one exact target");
  }
  const targets = authority.targets.map(normalizeTarget);
  const names = targets.map(({ sandboxName }) => sandboxName);
  if (
    new Set(names).size !== names.length ||
    names.some((name, index) => index > 0 && compareCodeUnits(names[index - 1]!, name) >= 0)
  ) {
    throw new Error("Hermes Portable uninstall targets are not unique and sorted");
  }
  return Object.freeze({
    registryPathSha256: exactSha(authority.registryPathSha256, "registry path digest"),
    statePathSha256: exactSha(authority.statePathSha256, "state path digest"),
    targets: Object.freeze(targets),
  });
}

function normalizeJournal(value: unknown): HermesPortableUninstallJournal {
  const journal = record(value, "journal");
  exactKeys(journal, ["schemaVersion", "kind", "phase", "authority", "authoritySha256"], "journal");
  if (
    journal.schemaVersion !== 1 ||
    journal.kind !== "hermes-portable-uninstall" ||
    typeof journal.phase !== "string" ||
    ![
      "prepared",
      "sandboxes-retired",
      "providers-retired",
      "inference-retired",
      "resources-absent",
      "registry-retired",
      "receipts-retired",
      "completed",
    ].includes(journal.phase)
  ) {
    throw new Error("Hermes Portable uninstall journal phase is malformed");
  }
  const authority = normalizeAuthority(journal.authority);
  const authoritySha256 = exactSha(journal.authoritySha256, "authority digest");
  if (sha256(JSON.stringify(authority)) !== authoritySha256) {
    throw new Error("Hermes Portable uninstall journal authority changed");
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: "hermes-portable-uninstall" as const,
    phase: journal.phase as HermesPortableUninstallPhase,
    authority,
    authoritySha256,
  });
}

function journalPath(stateDir: string): string {
  return path.join(stateDir, HERMES_PORTABLE_UNINSTALL_JOURNAL_FILE);
}

function readJournalFile(stateDir: string): HermesPortableUninstallJournal | null {
  readPortableAuthorityDirectory(stateDir, true);
  const target = journalPath(stateDir);
  let descriptor: number;
  try {
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (isPortableUninstallMissingPathError(error)) return null;
    throw error;
  }
  try {
    const stat = fs.fstatSync(descriptor, { bigint: true });
    const uid = process.getuid?.();
    if (
      uid === undefined ||
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.uid !== BigInt(uid) ||
      (stat.mode & 0o777n) !== 0o600n ||
      stat.nlink !== 1n ||
      stat.size > BigInt(MAX_JOURNAL_BYTES)
    ) {
      throw new Error("Hermes Portable uninstall journal file is unsafe");
    }
    const serialized = fs.readFileSync(descriptor, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      throw new Error("Hermes Portable uninstall journal is malformed");
    }
    const journal = normalizeJournal(parsed);
    if (canonical(journal) !== serialized) {
      throw new Error("Hermes Portable uninstall journal is not canonical");
    }
    return journal;
  } finally {
    fs.closeSync(descriptor);
  }
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(
    directory,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | fs.constants.O_DIRECTORY,
  );
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function publishJournal(stateDir: string, journal: HermesPortableUninstallJournal): void {
  const target = journalPath(stateDir);
  const descriptor = fs.openSync(
    target,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      (fs.constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    fs.writeFileSync(descriptor, canonical(journal), "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fsyncDirectory(stateDir);
  if (canonical(readJournalFile(stateDir)) !== canonical(journal)) {
    throw new Error("Hermes Portable uninstall journal publication could not be verified");
  }
}

function replaceExactJournal(
  stateDir: string,
  current: HermesPortableUninstallJournal,
  next: HermesPortableUninstallJournal,
): HermesPortableUninstallJournal {
  const target = journalPath(stateDir);
  const temporary = `${target}.${String(process.pid)}.${next.phase}.${randomUUID()}.next`;
  try {
    const descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      fs.writeFileSync(descriptor, canonical(next), "utf8");
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    if (canonical(readJournalFile(stateDir)) !== canonical(current)) {
      throw new Error("Hermes Portable uninstall journal changed before phase publication");
    }
    fs.renameSync(temporary, target);
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Preserve the publication failure when cleanup also fails.
    }
    throw error;
  }
  fsyncDirectory(stateDir);
  const verified = readJournalFile(stateDir);
  if (canonical(verified) !== canonical(next)) {
    throw new Error("Hermes Portable uninstall journal phase could not be verified");
  }
  return next;
}

function preparedJournal(
  authorityValue: HermesPortableUninstallAuthority,
): HermesPortableUninstallJournal {
  const authority = normalizeAuthority(authorityValue);
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: "hermes-portable-uninstall" as const,
    phase: "prepared" as const,
    authority,
    authoritySha256: sha256(JSON.stringify(authority)),
  });
}

export function createHermesPortableUninstallJournalStore(
  stateDir: string,
): HermesPortableUninstallJournalStore {
  return Object.freeze({
    authoritySha256: (authority: HermesPortableUninstallAuthority) =>
      preparedJournal(authority).authoritySha256,
    read: () => readJournalFile(stateDir),
    publishPrepared: (authority: HermesPortableUninstallAuthority) => {
      const journal = preparedJournal(authority);
      publishJournal(stateDir, journal);
      return journal;
    },
    replacePrepared: (
      current: HermesPortableUninstallJournal,
      authority: HermesPortableUninstallAuthority,
    ) => replaceExactJournal(stateDir, current, preparedJournal(authority)),
    replacePhase: (current: HermesPortableUninstallJournal, phase: HermesPortableUninstallPhase) =>
      replaceExactJournal(stateDir, current, Object.freeze({ ...current, phase })),
  });
}

export function inspectHermesPortableUninstallJournal(
  stateDir: string,
): HermesPortableUninstallJournal | null {
  return readJournalFile(stateDir);
}

/** Stop a new lifecycle from replacing authority that an interrupted uninstall still owns. */
export function assertHermesPortableUninstallCompleteForOnboarding(stateDir: string): void {
  if (readPortableAuthorityDirectory(stateDir, false).identity === null) return;
  const journal = readJournalFile(stateDir);
  if (journal && journal.phase !== "completed") {
    throw new Error(
      `Hermes Portable onboarding cannot replace lifecycle authority while the uninstall journal is at phase '${journal.phase}'; rerun uninstall before onboarding`,
    );
  }
}

export function hermesPortableUninstallJournalPath(stateDir: string): string {
  return journalPath(stateDir);
}

export const hermesPortableUninstallJournalInternals = Object.freeze({
  normalizeAuthority,
  normalizeJournal,
});
