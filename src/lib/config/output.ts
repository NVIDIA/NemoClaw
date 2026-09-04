// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
type ErrnoException = Error & { code?: string };

function isErrnoException(error: unknown): error is ErrnoException {
  return error instanceof Error && "code" in error;
}

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

function inspectDestination(
  destination: string,
  outputPath: string,
  force: boolean,
): fs.Stats | null {
  let pathStat: fs.Stats;
  try {
    pathStat = fs.lstatSync(destination);
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
      destination,
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
      "Safe export publication requires Linux retained-directory descriptors",
    );
  }
  const directoryPath = path.dirname(outputPath);
  const before = fs.lstatSync(directoryPath);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new YamlExportOutputError(
      "unsafe-output",
      outputPath,
      `Refusing to publish through an output parent that is not a real directory: ${directoryPath}`,
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
        `Refusing to publish because the output parent changed: ${directoryPath}`,
      );
    }
    return { descriptor, directoryPath, retainedPath: `/proc/self/fd/${descriptor}`, stat };
  } catch (error) {
    fs.closeSync(descriptor);
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
      `Refusing to publish because the output parent changed: ${parent.directoryPath}`,
    );
  }
  if (!current.isDirectory() || !sameFile(parent.stat, current)) {
    throw new YamlExportOutputError(
      "unsafe-output",
      outputPath,
      `Refusing to publish because the output parent changed: ${parent.directoryPath}`,
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
        `Refusing to replace an output path created during publication: ${outputPath}`,
      );
    }
    throw error;
  }
}

function removeIfSame(candidate: string, expected: fs.Stats): void {
  try {
    const stat = fs.lstatSync(candidate);
    if (sameFile(stat, expected)) fs.unlinkSync(candidate);
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "ENOENT") throw error;
  }
}

function preserveRecovery(moved: string, outputPath: string): never {
  const recoverable = path.join(path.dirname(outputPath), path.basename(moved));
  throw new YamlExportOutputError(
    "unsafe-output",
    outputPath,
    `Publication failed and the destination remains recoverable at: ${recoverable}`,
  );
}

const RENAME_EXCHANGE_HELPER = `
import ctypes
import os
import sys

if len(sys.argv) != 4:
    raise SystemExit("expected two names and one rename flag")
old_name, new_name, rename_flag = sys.argv[1:]
for name in (old_name, new_name):
    if not name or name in (".", "..") or "/" in name or "\\0" in name:
        raise SystemExit("invalid exchange name")
libc = ctypes.CDLL(None, use_errno=True)
renameat2 = libc.renameat2
renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
renameat2.restype = ctypes.c_int
result = renameat2(3, os.fsencode(old_name), 3, os.fsencode(new_name), int(rename_flag))
if result != 0:
    error = ctypes.get_errno()
    raise OSError(error, os.strerror(error))
`;

function assertExchangeSupported(outputPath: string): void {
  try {
    execFileSync(
      "/usr/bin/python3",
      ["-c", "import ctypes; getattr(ctypes.CDLL(None), 'renameat2')"],
      {
        stdio: "ignore",
      },
    );
  } catch {
    throw new YamlExportOutputError(
      "unsafe-output",
      outputPath,
      "Safe forced export publication requires /usr/bin/python3 and Linux renameat2 support",
    );
  }
}

function renameNames(
  parentDescriptor: number,
  leftName: string,
  rightName: string,
  renameFlag: 1 | 2,
  outputPath: string,
): void {
  if (process.platform !== "linux") {
    throw new YamlExportOutputError(
      "unsafe-output",
      outputPath,
      "Safe forced export publication requires Linux renameat2 exchange support",
    );
  }
  for (const name of [leftName, rightName]) {
    if (
      name.length === 0 ||
      name === "." ||
      name === ".." ||
      name.includes("/") ||
      name.includes("\0")
    ) {
      throw new YamlExportOutputError("unsafe-output", outputPath, "Invalid atomic exchange name");
    }
  }
  try {
    execFileSync(
      "/usr/bin/python3",
      ["-c", RENAME_EXCHANGE_HELPER, leftName, rightName, String(renameFlag)],
      {
        stdio: ["ignore", "pipe", "pipe", parentDescriptor],
      },
    );
  } catch {
    throw new YamlExportOutputError(
      "unsafe-output",
      outputPath,
      `Atomic output exchange failed; destination was not safely published: ${outputPath}`,
    );
  }
}

function exchangeNames(
  parentDescriptor: number,
  leftName: string,
  rightName: string,
  outputPath: string,
): void {
  renameNames(parentDescriptor, leftName, rightName, 2, outputPath);
}

function publishForced(
  parentDescriptor: number,
  temporary: string,
  destination: string,
  moved: string,
  expected: fs.Stats,
  temporaryStat: fs.Stats,
  outputPath: string,
): fs.Stats {
  assertExchangeSupported(outputPath);
  publishNew(temporary, moved, outputPath);
  try {
    exchangeNames(parentDescriptor, path.basename(moved), path.basename(destination), outputPath);
  } catch (error) {
    removeIfSame(moved, temporaryStat);
    throw error;
  }
  const movedStat = fs.lstatSync(moved);
  if (!movedStat.isFile() || !sameFile(expected, movedStat)) {
    try {
      exchangeNames(parentDescriptor, path.basename(moved), path.basename(destination), outputPath);
      const restored = fs.lstatSync(destination);
      const unpublished = fs.lstatSync(moved);
      if (!sameFile(restored, movedStat) || !sameFile(unpublished, temporaryStat)) {
        preserveRecovery(moved, outputPath);
      }
      fs.unlinkSync(moved);
    } catch {
      preserveRecovery(moved, outputPath);
    }
    throw new YamlExportOutputError(
      "unsafe-output",
      outputPath,
      `Refusing to replace an output path that changed during publication: ${outputPath}`,
    );
  }
  return fs.lstatSync(destination);
}

function rollbackPublication(
  parentDescriptor: number,
  destination: string,
  quarantine: string,
  published: fs.Stats,
  moved: string | null,
  outputPath: string,
): void {
  try {
    renameNames(
      parentDescriptor,
      path.basename(destination),
      path.basename(quarantine),
      1,
      outputPath,
    );
  } catch {
    throw new YamlExportOutputError(
      "unsafe-output",
      outputPath,
      "Publication rollback could not claim the output without replacing concurrent state.",
    );
  }
  const quarantined = fs.lstatSync(quarantine);
  if (!sameFile(quarantined, published)) {
    try {
      renameNames(
        parentDescriptor,
        path.basename(quarantine),
        path.basename(destination),
        1,
        outputPath,
      );
    } catch {
      preserveRecovery(quarantine, outputPath);
    }
    throw new YamlExportOutputError(
      "unsafe-output",
      outputPath,
      "A concurrent output change was preserved during publication rollback.",
    );
  }
  fs.unlinkSync(quarantine);
  if (moved !== null) {
    try {
      fs.linkSync(moved, destination);
      fs.unlinkSync(moved);
    } catch {
      preserveRecovery(moved, outputPath);
    }
  }
}

function publishYamlExport(options: PublishYamlExportOptions): PublishExportFileResult {
  const outputPath = path.resolve(options.outputPath);
  const parent = openParent(outputPath);
  const name = path.basename(outputPath);
  const destination = path.join(parent.retainedPath, name);
  const suffix = `${String(process.pid)}.${randomUUID()}`;
  const temporary = path.join(parent.retainedPath, `.${name}.${suffix}.tmp`);
  const moved = path.join(parent.retainedPath, `.${name}.${suffix}.previous`);
  const quarantine = path.join(parent.retainedPath, `.${name}.${suffix}.rollback`);
  let descriptor: number | null = null;
  try {
    const expected = inspectDestination(destination, outputPath, options.force === true);
    descriptor = fs.openSync(
      temporary,
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
    writeComplete(
      descriptor,
      typeof options.yaml === "string" ? Buffer.from(options.yaml, "utf8") : options.yaml,
    );
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    assertParentStable(parent, outputPath);
    let published: fs.Stats;
    if (expected === null) {
      publishNew(temporary, destination, outputPath);
      published = temporaryStat;
    } else {
      published = publishForced(
        parent.descriptor,
        temporary,
        destination,
        moved,
        expected,
        temporaryStat,
        outputPath,
      );
    }
    try {
      assertParentStable(parent, outputPath);
    } catch (error) {
      rollbackPublication(
        parent.descriptor,
        destination,
        quarantine,
        published,
        expected === null ? null : moved,
        outputPath,
      );
      throw error;
    }
    fs.unlinkSync(temporary);
    fs.fsyncSync(parent.descriptor);
    if (expected !== null) {
      try {
        fs.unlinkSync(moved);
      } catch {
        throw new YamlExportOutputError(
          "unsafe-output",
          outputPath,
          `The new export is published at ${outputPath}; the prior output remains recoverable at: ${path.join(path.dirname(outputPath), path.basename(moved))}`,
        );
      }
    }
    fs.fsyncSync(parent.descriptor);
    return { path: outputPath };
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if (!isErrnoException(error) || error.code !== "ENOENT") {
        /* Preserve the publication result. */
      }
    }
    fs.closeSync(parent.descriptor);
  }
}

export function publishExportFile(
  outputPath: string,
  contents: string | Uint8Array,
  force = false,
): PublishExportFileResult {
  return publishYamlExport({ outputPath, yaml: contents, force });
}
