// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isErrnoException } from "../core/errno";

export type YamlExportFailureKind = "output-conflict" | "unsafe-output";

export class YamlExportOutputError extends Error {
  constructor(
    public readonly category: YamlExportFailureKind,
    public readonly outputPath: string,
    message: string,
  ) {
    super(message);
    this.name = "YamlExportOutputError";
  }
}

export interface PublishExportFileResult {
  readonly path: string;
}

interface PublishYamlExportOptions {
  readonly outputPath: string;
  readonly yaml: string | Uint8Array;
  readonly force?: boolean;
}

function sameFile(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function inspectDestination(outputPath: string, force: boolean): fs.Stats | null {
  let pathStat: fs.Stats;
  try {
    pathStat = fs.lstatSync(outputPath);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return null;
    throw error;
  }

  if (!pathStat.isFile()) {
    throw new YamlExportOutputError(
      "unsafe-output",
      outputPath,
      `Refusing to replace an output path that is not a regular file: ${outputPath}`,
    );
  }
  if (!force) {
    throw new YamlExportOutputError(
      "output-conflict",
      outputPath,
      `Output already exists: ${outputPath}`,
    );
  }

  let descriptor: number;
  try {
    descriptor = fs.openSync(
      outputPath,
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if (isErrnoException(error) && ["ENOENT", "ELOOP"].includes(error.code ?? "")) {
      throw new YamlExportOutputError(
        "unsafe-output",
        outputPath,
        `Refusing to replace an output path that changed during validation: ${outputPath}`,
      );
    }
    throw error;
  }
  try {
    const descriptorStat = fs.fstatSync(descriptor);
    if (!descriptorStat.isFile() || !sameFile(pathStat, descriptorStat)) {
      throw new YamlExportOutputError(
        "unsafe-output",
        outputPath,
        `Refusing to replace an output path that changed during validation: ${outputPath}`,
      );
    }
    return descriptorStat;
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertDestinationIsStable(outputPath: string, expected: fs.Stats | null): void {
  let current: fs.Stats;
  try {
    current = fs.lstatSync(outputPath);
  } catch (error) {
    if (expected === null && isErrnoException(error) && error.code === "ENOENT") return;
    throw new YamlExportOutputError(
      "unsafe-output",
      outputPath,
      `Refusing to publish because the output path changed: ${outputPath}`,
    );
  }

  if (expected === null) {
    throw new YamlExportOutputError(
      current.isFile() ? "output-conflict" : "unsafe-output",
      outputPath,
      `Refusing to replace an output path created during publication: ${outputPath}`,
    );
  }
  if (!current.isFile() || !sameFile(expected, current)) {
    throw new YamlExportOutputError(
      "unsafe-output",
      outputPath,
      `Refusing to replace an output path that changed during publication: ${outputPath}`,
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

function fsyncParent(directoryPath: string): void {
  let descriptor: number;
  try {
    descriptor = fs.openSync(directoryPath, fs.constants.O_RDONLY);
  } catch (error) {
    if (process.platform === "win32" && isErrnoException(error)) return;
    throw error;
  }
  try {
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (
      !isErrnoException(error) ||
      !["EINVAL", "ENOTSUP", "EOPNOTSUPP", "EBADF"].includes(error.code ?? "")
    ) {
      throw error;
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function publishYamlExport(options: PublishYamlExportOptions): PublishExportFileResult {
  const outputPath = path.resolve(options.outputPath);
  const directoryPath = path.dirname(outputPath);
  const expectedDestination = inspectDestination(outputPath, options.force === true);
  const temporaryPath = path.join(
    directoryPath,
    `.${path.basename(outputPath)}.${String(process.pid)}.${randomUUID()}.tmp`,
  );
  let descriptor: number | null = null;

  try {
    descriptor = fs.openSync(
      temporaryPath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const temporaryStat = fs.fstatSync(descriptor);
    if (!temporaryStat.isFile() || temporaryStat.nlink !== 1) {
      throw new YamlExportOutputError(
        "unsafe-output",
        outputPath,
        `Could not create a safe temporary file for: ${outputPath}`,
      );
    }
    fs.fchmodSync(descriptor, 0o600);
    const bytes =
      typeof options.yaml === "string" ? Buffer.from(options.yaml, "utf8") : options.yaml;
    writeComplete(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;

    assertDestinationIsStable(outputPath, expectedDestination);
    fs.renameSync(temporaryPath, outputPath);
    fsyncParent(directoryPath);
    return { path: outputPath };
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporaryPath);
    } catch (error) {
      if (!isErrnoException(error) || error.code !== "ENOENT") {
        // Cleanup cannot replace the publication result or its original error.
      }
    }
  }
}

export function publishExportFile(
  outputPath: string,
  contents: string | Uint8Array,
  force = false,
): PublishExportFileResult {
  return publishYamlExport({ outputPath, yaml: contents, force });
}
