// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type * as TypeBoxModule from "typebox" with { "resolution-mode": "import" };
import type * as TypeBoxValueModule from "typebox/value" with { "resolution-mode": "import" };

const { Type } = require("typebox") as typeof TypeBoxModule;
const { Check } = require("typebox/value") as typeof TypeBoxValueModule;

const FileIdentityNumberSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const StagingReferenceSchema = Type.Object({
  name: Type.String({
    pattern: "^\\.nemoclaw-export\\.[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\\.tmp$",
  }),
  directoryDevice: FileIdentityNumberSchema,
  directoryInode: FileIdentityNumberSchema,
  fileDevice: FileIdentityNumberSchema,
  fileInode: FileIdentityNumberSchema,
});

type ErrnoException = Error & { code?: string };

function isErrnoException(error: unknown): error is ErrnoException {
  return error instanceof Error && "code" in error;
}

export type YamlExportFailureKind = "output-conflict" | "unsafe-output";
export type YamlExportStagingReference = Readonly<
  TypeBoxModule.Type.Static<typeof StagingReferenceSchema>
>;
export type YamlExportFileState =
  | {
      readonly publication: "not-published";
      readonly stagingCleanup: "complete" | "incomplete";
    }
  | {
      readonly publication: "unknown";
      readonly stagingCleanup: "complete" | "incomplete";
    }
  | {
      readonly publication: "published";
      readonly durability: "confirmed" | "unknown";
      readonly location: "confirmed" | "unknown";
      readonly stagingCleanup: "complete" | "incomplete";
    };

export type YamlExportFailure = Readonly<{
  category: YamlExportFailureKind;
  fileState: YamlExportFileState;
  stagingReference: YamlExportStagingReference | null;
}>;
export type YamlExportPublication =
  | Readonly<{ ok: true; outputPath: string }>
  | Readonly<{ ok: false; failure: YamlExportFailure }>;

class OutputConflict extends Error {}

function sameFile(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function inspectDestination(destination: string, force: boolean): void {
  let pathStat: fs.Stats;
  try {
    pathStat = fs.lstatSync(destination);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return;
    throw error;
  }
  if (!pathStat.isFile()) {
    throw new Error("Refusing to replace an output path that is not a regular file.");
  }
  if (!force) {
    throw new OutputConflict("The output path already exists.");
  }
}

function writeComplete(descriptor: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = fs.writeSync(descriptor, bytes, offset, bytes.byteLength - offset);
    if (written === 0) throw new Error("Could not write YAML export bytes");
    offset += written;
  }
}

function openParent(outputPath: string) {
  if (process.platform !== "linux") {
    throw new Error("Safe export publication requires Linux retained-directory descriptors.");
  }
  const directoryPath = path.dirname(outputPath);
  const before = fs.lstatSync(directoryPath);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error("Refusing to publish through an output parent that is not a real directory.");
  }
  const descriptor = fs.openSync(
    directoryPath,
    fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isDirectory() || !sameFile(before, stat)) {
      throw new Error("Refusing to publish because the output parent changed.");
    }
    return { descriptor, directoryPath, retainedPath: `/proc/self/fd/${descriptor}`, stat };
  } catch (error) {
    try {
      fs.closeSync(descriptor);
    } catch {
      /* Preserve the identity-check failure. */
    }
    throw error;
  }
}

function assertParentStable(parent: ExportParent): void {
  let current: fs.Stats;
  try {
    current = fs.lstatSync(parent.directoryPath);
  } catch {
    throw new Error("Refusing to publish because the output parent changed.");
  }
  if (!current.isDirectory() || !sameFile(parent.stat, current)) {
    throw new Error("Refusing to publish because the output parent changed.");
  }
}

function publishNew(temporary: string, destination: string): void {
  try {
    fs.linkSync(temporary, destination);
  } catch (error) {
    if (isErrnoException(error) && error.code === "EEXIST") {
      throw new OutputConflict("Refusing to replace an output path created during publication.");
    }
    throw error;
  }
}

function recoverPublication(
  destination: string,
  stagedFile: fs.Stats,
): "not-published" | "published" | "unknown" {
  try {
    const current = fs.lstatSync(destination);
    return current.isFile() && sameFile(current, stagedFile) ? "published" : "not-published";
  } catch (error) {
    return isErrnoException(error) && error.code === "ENOENT" ? "not-published" : "unknown";
  }
}

function removeOwnedStagingPath(temporary: string, stagedFile: fs.Stats): boolean {
  let current: fs.Stats;
  try {
    current = fs.lstatSync(temporary);
  } catch (error) {
    return isErrnoException(error) && error.code === "ENOENT";
  }
  if (!current.isFile() || !sameFile(current, stagedFile)) return true;
  try {
    fs.unlinkSync(temporary);
    return true;
  } catch (error) {
    return isErrnoException(error) && error.code === "ENOENT";
  }
}

function assertPublishedLocation(stagedFile: fs.Stats, outputPath: string): void {
  let current: fs.Stats;
  try {
    current = fs.lstatSync(outputPath);
  } catch {
    throw new Error("The published export could not be verified at the final output location.");
  }
  if (!current.isFile() || !sameFile(current, stagedFile)) {
    throw new Error("The published export could not be verified at the final output location.");
  }
}

type ExportParent = ReturnType<typeof openParent>;
type StagedExport = Readonly<{ path: string; descriptor: number; stat: fs.Stats }>;
type PreparedExport = Readonly<{
  parent: ExportParent;
  staged: StagedExport;
  destination: string;
}>;
type FileOperation = { ok: true } | { ok: false; error: unknown };
type ExportOutcome = {
  fileState: YamlExportFileState;
  error?: unknown;
  stagingReference?: YamlExportStagingReference;
};
type Preparation<Value> = { ok: true; value: Value } | { ok: false; outcome: ExportOutcome };
type PublicationAttempt = {
  publication: YamlExportFileState["publication"];
  stagingPresent: boolean;
  error?: unknown;
};

function attemptFileOperation(operation: () => void): FileOperation {
  try {
    operation();
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error ?? new Error("Filesystem operation failed without an error value."),
    };
  }
}

function operationError(result: FileOperation): unknown {
  return result.ok ? undefined : result.error;
}

function cleanStaging(staged: StagedExport, attempts: number): "complete" | "incomplete" {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (removeOwnedStagingPath(staged.path, staged.stat)) return "complete";
  }
  return "incomplete";
}

function stagingReference(
  parent: ExportParent,
  temporary: string,
  stat: fs.Stats | undefined,
): YamlExportStagingReference | undefined {
  if (!stat?.isFile()) return undefined;
  const reference = {
    name: path.basename(temporary),
    directoryDevice: parent.stat.dev,
    directoryInode: parent.stat.ino,
    fileDevice: stat.dev,
    fileInode: stat.ino,
  };
  return Check(StagingReferenceSchema, reference) ? reference : undefined;
}

function stageExport(
  parent: ExportParent,
  contents: string | Uint8Array,
): Preparation<StagedExport> {
  const temporary = path.join(parent.retainedPath, `.nemoclaw-export.${randomUUID()}.tmp`);
  const descriptor = fs.openSync(
    temporary,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      (fs.constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  let stat: fs.Stats | undefined;
  try {
    stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error("Could not create a safe temporary file.");
    }
    fs.fchmodSync(descriptor, 0o600);
    writeComplete(
      descriptor,
      typeof contents === "string" ? Buffer.from(contents, "utf8") : contents,
    );
    fs.fsyncSync(descriptor);
    return { ok: true, value: { path: temporary, descriptor, stat } };
  } catch (error) {
    const stagingCleanup = stat
      ? cleanStaging({ path: temporary, descriptor, stat }, 2)
      : "incomplete";
    attemptFileOperation(() => fs.closeSync(descriptor));
    return {
      ok: false,
      outcome: {
        fileState: { publication: "not-published", stagingCleanup },
        error,
        stagingReference: stagingReference(parent, temporary, stat),
      },
    };
  }
}

function prepareExport(
  outputPath: string,
  contents: string | Uint8Array,
  force: boolean,
): Preparation<PreparedExport> {
  const parent = openParent(outputPath);
  try {
    const destination = path.join(parent.retainedPath, path.basename(outputPath));
    inspectDestination(destination, force);
    const staged = stageExport(parent, contents);
    if (!staged.ok) {
      attemptFileOperation(() => fs.closeSync(parent.descriptor));
      return staged;
    }
    return { ok: true, value: { parent, destination, staged: staged.value } };
  } catch (error) {
    attemptFileOperation(() => fs.closeSync(parent.descriptor));
    throw error;
  }
}

function attemptPublication(prepared: PreparedExport, force: boolean): PublicationAttempt {
  const { staged, destination } = prepared;
  const result = attemptFileOperation(() => {
    if (force) fs.renameSync(staged.path, destination);
    else publishNew(staged.path, destination);
  });
  if (result.ok) return { publication: "published", stagingPresent: !force };
  return {
    publication: recoverPublication(destination, staged.stat),
    stagingPresent: true,
    error: result.error,
  };
}

function confirmPublication(
  prepared: PreparedExport,
  outputPath: string,
  stagingCleanup: "complete" | "incomplete",
  publicationError: unknown,
): ExportOutcome {
  const durability = attemptFileOperation(() => fs.fsyncSync(prepared.parent.descriptor));
  const location = attemptFileOperation(() =>
    assertPublishedLocation(prepared.staged.stat, outputPath),
  );
  const confirmed = durability.ok && location.ok && stagingCleanup === "complete";
  return {
    fileState: {
      publication: "published",
      durability: durability.ok ? "confirmed" : "unknown",
      location: location.ok ? "confirmed" : "unknown",
      stagingCleanup,
    },
    // A reported syscall failure is recovered only after every postcondition holds.
    error: confirmed
      ? undefined
      : (publicationError ?? operationError(durability) ?? operationError(location)),
  };
}

function publishPrepared(
  prepared: PreparedExport,
  outputPath: string,
  force: boolean,
): ExportOutcome {
  const stable = attemptFileOperation(() => assertParentStable(prepared.parent));
  if (!stable.ok) {
    return {
      fileState: { publication: "not-published", stagingCleanup: cleanStaging(prepared.staged, 2) },
      error: stable.error,
    };
  }
  const result = attemptPublication(prepared, force);
  // Preserve the existing two cleanup attempts, plus the final two after an unconfirmed publication.
  const stagingCleanup = result.stagingPresent
    ? cleanStaging(prepared.staged, result.publication === "published" ? 2 : 4)
    : "complete";
  if (result.publication === "published") {
    return confirmPublication(prepared, outputPath, stagingCleanup, result.error);
  }
  return { fileState: { publication: result.publication, stagingCleanup }, error: result.error };
}

function finalizeExport(prepared: PreparedExport, outcome: ExportOutcome): ExportOutcome {
  // Retain both descriptors through final location verification to prevent inode reuse.
  // A close that reports failure is never retried: the descriptor may already have been reused.
  const stagedClose = attemptFileOperation(() => fs.closeSync(prepared.staged.descriptor));
  const parentClose = attemptFileOperation(() => fs.closeSync(prepared.parent.descriptor));
  return {
    ...outcome,
    error: outcome.error ?? operationError(stagedClose) ?? operationError(parentClose),
    stagingReference: stagingReference(prepared.parent, prepared.staged.path, prepared.staged.stat),
  };
}

function failedPublication({
  fileState,
  error,
  stagingReference,
}: ExportOutcome): YamlExportPublication {
  const category =
    error instanceof OutputConflict &&
    fileState.publication === "not-published" &&
    fileState.stagingCleanup === "complete"
      ? "output-conflict"
      : "unsafe-output";
  return {
    ok: false,
    failure: {
      category,
      fileState,
      stagingReference:
        fileState.stagingCleanup === "incomplete" ? (stagingReference ?? null) : null,
    },
  };
}

export function publishExportFile(
  requestedPath: string,
  contents: string | Uint8Array,
  force = false,
): YamlExportPublication {
  let outputPath: string;
  let prepared: PreparedExport;
  try {
    outputPath = path.resolve(requestedPath);
    const preparation = prepareExport(outputPath, contents, force);
    if (!preparation.ok) return failedPublication(preparation.outcome);
    prepared = preparation.value;
  } catch (error) {
    return failedPublication({
      fileState: { publication: "not-published", stagingCleanup: "complete" },
      error,
    });
  }
  let outcome: ExportOutcome;
  try {
    outcome = publishPrepared(prepared, outputPath, force);
  } catch (error) {
    outcome = {
      fileState: { publication: "unknown", stagingCleanup: cleanStaging(prepared.staged, 2) },
      error,
    };
  }
  outcome = finalizeExport(prepared, outcome);
  const state = outcome.fileState;
  if (
    state.publication !== "published" ||
    state.durability !== "confirmed" ||
    state.location !== "confirmed" ||
    state.stagingCleanup !== "complete" ||
    outcome.error !== undefined
  ) {
    return failedPublication(outcome);
  }
  return { ok: true, outputPath };
}
