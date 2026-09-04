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
  constructor(
    public readonly category: YamlExportFailureKind,
    public readonly outputPath: string,
    message: string,
    public readonly fileState: YamlExportFileState = {
      publication: "not-published",
      stagingCleanup: "complete",
    },
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "YamlExportOutputError";
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

function assertPublishedLocation(
  parent: ReturnType<typeof openParent>,
  destination: string,
  stagedFile: fs.Stats,
  outputPath: string,
): void {
  assertParentStable(parent, outputPath);
  let current: fs.Stats;
  try {
    current = fs.lstatSync(destination);
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

export function publishExportFile(
  requestedPath: string,
  contents: string | Uint8Array,
  force = false,
): string {
  const outputPath = path.resolve(requestedPath);
  let parent: ReturnType<typeof openParent> | null = null;
  let destination: string | null = null;
  let temporary: string | null = null;
  let descriptor: number | null = null;
  let stagedFile: fs.Stats | null = null;
  let stagingPresent = false;
  let publication: "not-published" | "published" | "unknown" = "not-published";
  let durabilityConfirmed = false;
  let locationConfirmed = false;
  let stagingCleanupIncomplete = false;
  let publicationCallFailed = false;
  let primaryError: unknown;
  try {
    const name = path.basename(outputPath);
    const temporaryName = `.${name}.${String(process.pid)}.${randomUUID()}.tmp`;
    parent = openParent(outputPath);
    destination = path.join(parent.retainedPath, name);
    temporary = path.join(parent.retainedPath, temporaryName);
    inspectDestination(destination, outputPath, force);
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    stagingPresent = true;
    stagedFile = fs.fstatSync(descriptor);
    if (!stagedFile.isFile() || stagedFile.nlink !== 1) {
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
    const stagedDescriptor = descriptor;
    descriptor = null;
    fs.closeSync(stagedDescriptor);
    assertParentStable(parent, outputPath);
    publication = "unknown";
    try {
      if (force) {
        fs.renameSync(temporary, destination);
        stagingPresent = false;
      } else {
        publishNew(temporary, destination, outputPath);
      }
      publication = "published";
    } catch (error) {
      publicationCallFailed = true;
      primaryError ??= error;
      publication = recoverPublication(destination, stagedFile);
    }
    for (let attempt = 0; attempt < 2 && stagingPresent; attempt += 1) {
      if (removeOwnedStagingPath(temporary, stagedFile)) {
        stagingPresent = false;
        stagingCleanupIncomplete = false;
      } else {
        stagingCleanupIncomplete = true;
      }
    }
    if (publication === "published") {
      try {
        fs.fsyncSync(parent.descriptor);
        durabilityConfirmed = true;
      } catch (error) {
        primaryError ??= new YamlExportOutputError(
          "unsafe-output",
          outputPath,
          "The new export is published, but parent-directory durability could not be confirmed.",
          undefined,
          { cause: error },
        );
      }
      try {
        assertPublishedLocation(parent, destination, stagedFile, outputPath);
        locationConfirmed = true;
      } catch (error) {
        primaryError ??= error;
      }
      if (
        publicationCallFailed &&
        durabilityConfirmed &&
        locationConfirmed &&
        !stagingCleanupIncomplete
      ) {
        primaryError = undefined;
      }
    }
  } catch (error) {
    primaryError ??= error;
  } finally {
    if (descriptor !== null) {
      const ownedDescriptor = descriptor;
      descriptor = null;
      try {
        fs.closeSync(ownedDescriptor);
      } catch (error) {
        if (primaryError === undefined) primaryError = error;
      }
    }
    if (publication !== "published" && stagingPresent && temporary !== null) {
      if (stagedFile === null) {
        stagingCleanupIncomplete = true;
      } else {
        for (let attempt = 0; attempt < 2 && stagingPresent; attempt += 1) {
          if (removeOwnedStagingPath(temporary, stagedFile)) {
            stagingPresent = false;
            stagingCleanupIncomplete = false;
          } else {
            stagingCleanupIncomplete = true;
          }
        }
      }
    }
    if (parent !== null) {
      try {
        fs.closeSync(parent.descriptor);
      } catch (error) {
        primaryError ??= error;
      }
    }
  }

  const fileState: YamlExportFileState =
    publication === "published"
    ? {
        publication: "published",
        durability: durabilityConfirmed ? "confirmed" : "unknown",
        location: locationConfirmed ? "confirmed" : "unknown",
        stagingCleanup: stagingCleanupIncomplete ? "incomplete" : "complete",
      }
      : {
        publication,
        stagingCleanup: stagingCleanupIncomplete ? "incomplete" : "complete",
      };
  if (primaryError !== undefined || stagingCleanupIncomplete) {
    const category =
      primaryError instanceof YamlExportOutputError &&
      primaryError.category === "output-conflict" &&
      publication === "not-published" &&
      !stagingCleanupIncomplete
        ? "output-conflict"
        : "unsafe-output";
    throw new YamlExportOutputError(
      category,
      outputPath,
      stagingCleanupIncomplete
        ? publication === "published"
          ? "The new export is published, but its temporary link could not be removed."
          : publication === "unknown"
            ? "The export may have been published, and its temporary file could not be removed."
            : "The export was not published, and its temporary file could not be removed."
        : primaryError instanceof YamlExportOutputError
          ? primaryError.message
          : "The export could not be published safely.",
      fileState,
      { cause: primaryError },
    );
  }
  return outputPath;
}
