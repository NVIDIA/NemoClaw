// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

type ErrnoException = Error & { code?: string };

function isErrnoException(error: unknown): error is ErrnoException {
  return error instanceof Error && "code" in error;
}

export type YamlExportFailureKind = "output-conflict" | "unsafe-output";
export type YamlExportStagingReference = Readonly<{
  name: string;
  directoryDevice: number;
  directoryInode: number;
  fileDevice: number;
  fileInode: number;
}>;
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

export class YamlExportOutputError extends Error {
  readonly stagingReference: YamlExportStagingReference | null;

  constructor(
    public readonly category: YamlExportFailureKind,
    public readonly outputPath: string,
    message: string,
    public readonly fileState: YamlExportFileState = {
      publication: "not-published",
      stagingCleanup: "complete",
    },
    options?: ErrorOptions & { stagingReference?: YamlExportStagingReference },
  ) {
    super(message, options);
    this.name = "YamlExportOutputError";
    this.stagingReference = options?.stagingReference
      ? Object.freeze({ ...options.stagingReference })
      : null;
  }
}

function sameFile(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function inspectDestination(destination: string, outputPath: string, force: boolean): void {
  let pathStat: fs.Stats;
  try {
    pathStat = fs.lstatSync(destination);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return;
    throw error;
  }
  if (!pathStat.isFile()) {
    throw new YamlExportOutputError(
      "unsafe-output",
      outputPath,
      "Refusing to replace an output path that is not a regular file.",
    );
  }
  if (!force) {
    throw new YamlExportOutputError(
      "output-conflict",
      outputPath,
      "The output path already exists.",
    );
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
    throw new YamlExportOutputError(
      "unsafe-output",
      outputPath,
      "Safe export publication requires Linux retained-directory descriptors.",
    );
  }
  const directoryPath = path.dirname(outputPath);
  const before = fs.lstatSync(directoryPath);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new YamlExportOutputError(
      "unsafe-output",
      outputPath,
      "Refusing to publish through an output parent that is not a real directory.",
    );
  }
  const descriptor = fs.openSync(
    directoryPath,
    fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isDirectory() || !sameFile(before, stat)) {
      throw new YamlExportOutputError(
        "unsafe-output",
        outputPath,
        "Refusing to publish because the output parent changed.",
      );
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

function assertParentStable(parent: ReturnType<typeof openParent>, outputPath: string): void {
  let current: fs.Stats;
  try {
    current = fs.lstatSync(parent.directoryPath);
  } catch {
    throw new YamlExportOutputError(
      "unsafe-output",
      outputPath,
      "Refusing to publish because the output parent changed.",
    );
  }
  if (!current.isDirectory() || !sameFile(parent.stat, current)) {
    throw new YamlExportOutputError(
      "unsafe-output",
      outputPath,
      "Refusing to publish because the output parent changed.",
    );
  }
}

function publishNew(temporary: string, destination: string, outputPath: string): void {
  try {
    fs.linkSync(temporary, destination);
  } catch (error) {
    if (isErrnoException(error) && error.code === "EEXIST") {
      throw new YamlExportOutputError(
        "output-conflict",
        outputPath,
        "Refusing to replace an output path created during publication.",
      );
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
    throw new YamlExportOutputError(
      "unsafe-output",
      outputPath,
      "The published export could not be verified at the final output location.",
    );
  }
  if (!current.isFile() || !sameFile(current, stagedFile)) {
    throw new YamlExportOutputError(
      "unsafe-output",
      outputPath,
      "The published export could not be verified at the final output location.",
    );
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
    return { ok: false, error };
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
  return {
    name: path.basename(temporary),
    directoryDevice: parent.stat.dev,
    directoryInode: parent.stat.ino,
    fileDevice: stat.dev,
    fileInode: stat.ino,
  };
}

function stageExport(
  parent: ExportParent,
  outputPath: string,
  contents: string | Uint8Array,
): StagedExport {
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
      throw new YamlExportOutputError(
        "unsafe-output",
        outputPath,
        "Could not create a safe temporary file.",
      );
    }
    fs.fchmodSync(descriptor, 0o600);
    writeComplete(
      descriptor,
      typeof contents === "string" ? Buffer.from(contents, "utf8") : contents,
    );
    fs.fsyncSync(descriptor);
    return { path: temporary, descriptor, stat };
  } catch (error) {
    const stagingCleanup = stat
      ? cleanStaging({ path: temporary, descriptor, stat }, 2)
      : "incomplete";
    attemptFileOperation(() => fs.closeSync(descriptor));
    throw exportFailure(outputPath, {
      fileState: { publication: "not-published", stagingCleanup },
      error,
      stagingReference: stagingReference(parent, temporary, stat),
    });
  }
}

function prepareExport(
  outputPath: string,
  contents: string | Uint8Array,
  force: boolean,
): PreparedExport {
  const parent = openParent(outputPath);
  try {
    const destination = path.join(parent.retainedPath, path.basename(outputPath));
    inspectDestination(destination, outputPath, force);
    return { parent, destination, staged: stageExport(parent, outputPath, contents) };
  } catch (error) {
    attemptFileOperation(() => fs.closeSync(parent.descriptor));
    throw error;
  }
}

function attemptPublication(
  prepared: PreparedExport,
  outputPath: string,
  force: boolean,
): PublicationAttempt {
  const { staged, destination } = prepared;
  const result = attemptFileOperation(() => {
    if (force) fs.renameSync(staged.path, destination);
    else publishNew(staged.path, destination, outputPath);
  });
  if (result.ok) return { publication: "published", stagingPresent: !force };
  return {
    publication: recoverPublication(destination, staged.stat),
    stagingPresent: true,
    error: result.error,
  };
}

function confirmationError(
  outputPath: string,
  durability: FileOperation,
  location: FileOperation,
): unknown {
  if (!durability.ok) {
    return new YamlExportOutputError(
      "unsafe-output",
      outputPath,
      "The new export is published, but parent-directory durability could not be confirmed.",
      undefined,
      { cause: durability.error },
    );
  }
  return operationError(location);
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
      : (publicationError ?? confirmationError(outputPath, durability, location)),
  };
}

function publishPrepared(
  prepared: PreparedExport,
  outputPath: string,
  force: boolean,
): ExportOutcome {
  const stable = attemptFileOperation(() => assertParentStable(prepared.parent, outputPath));
  if (!stable.ok) {
    return {
      fileState: { publication: "not-published", stagingCleanup: cleanStaging(prepared.staged, 2) },
      error: stable.error,
    };
  }
  const result = attemptPublication(prepared, outputPath, force);
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

function failureMessage({ fileState, error }: ExportOutcome): string {
  if (fileState.stagingCleanup === "complete") {
    return error instanceof YamlExportOutputError
      ? error.message
      : "The export could not be published safely.";
  }
  const messages = {
    published: "The new export is published, but its temporary link could not be removed.",
    unknown: "The export may have been published, and its temporary file could not be removed.",
    "not-published": "The export was not published, and its temporary file could not be removed.",
  };
  return messages[fileState.publication];
}

function exportFailure(outputPath: string, outcome: ExportOutcome): YamlExportOutputError {
  const { fileState, error } = outcome;
  const category =
    error instanceof YamlExportOutputError &&
    error.category === "output-conflict" &&
    fileState.publication === "not-published" &&
    fileState.stagingCleanup === "complete"
      ? "output-conflict"
      : "unsafe-output";
  return new YamlExportOutputError(category, outputPath, failureMessage(outcome), fileState, {
    cause: error,
    stagingReference:
      fileState.stagingCleanup === "incomplete" ? outcome.stagingReference : undefined,
  });
}

export function publishExportFile(
  requestedPath: string,
  contents: string | Uint8Array,
  force = false,
): string {
  const outputPath = path.resolve(requestedPath);
  let prepared: PreparedExport;
  try {
    prepared = prepareExport(outputPath, contents, force);
  } catch (error) {
    if (error instanceof YamlExportOutputError) throw error;
    throw exportFailure(outputPath, {
      fileState: { publication: "not-published", stagingCleanup: "complete" },
      error,
    });
  }
  const outcome = finalizeExport(prepared, publishPrepared(prepared, outputPath, force));
  if (outcome.error !== undefined || outcome.fileState.stagingCleanup === "incomplete") {
    throw exportFailure(outputPath, outcome);
  }
  return outputPath;
}
