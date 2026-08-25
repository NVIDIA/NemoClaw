// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import { chmod, lstat, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REGISTRY_ORIGIN = "https://registry.npmjs.org";
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const DOWNLOAD_CONCURRENCY = 6;
const DOWNLOAD_TIMEOUT_MS = 30_000;

export interface ReviewedNpmArchivePin {
  archive: string;
  sha256: string;
  url: string;
}

export type ReviewedNpmArchiveDownloader = (archive: ReviewedNpmArchivePin) => Promise<Uint8Array>;

function validatePin(pin: ReviewedNpmArchivePin): ReviewedNpmArchivePin {
  if (!/^[a-f0-9]{64}$/u.test(pin.sha256)) {
    throw new Error("reviewed npm archive SHA-256 must be 64 lowercase hexadecimal characters");
  }
  if (!/^[A-Za-z0-9@._+-][A-Za-z0-9@._+-]*[.]tgz$/u.test(pin.archive)) {
    throw new Error("reviewed npm archive name must be one literal .tgz filename");
  }
  const url = new URL(pin.url);
  if (
    url.origin !== REGISTRY_ORIGIN ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !url.pathname.endsWith(".tgz") ||
    url.pathname.toLowerCase().includes("%2f")
  ) {
    throw new Error(`reviewed npm archive URL must use ${REGISTRY_ORIGIN}`);
  }
  return pin;
}

function validatePins(pins: readonly ReviewedNpmArchivePin[]): ReviewedNpmArchivePin[] {
  if (pins.length === 0) throw new Error("at least one reviewed npm archive is required");
  const validated = pins.map(validatePin);
  const archives = new Set(validated.map(({ archive }) => archive));
  const urls = new Set(validated.map(({ url }) => url));
  if (archives.size !== validated.length || urls.size !== validated.length) {
    throw new Error("reviewed npm archive names and URLs must be unique");
  }
  return validated;
}

async function exactOutputParent(output: string): Promise<string> {
  if (!path.isAbsolute(output) || path.resolve(output) !== output || output.includes("\n")) {
    throw new Error("reviewed npm archive output must be one normalized absolute path");
  }
  const parent = path.dirname(output);
  const status = await lstat(parent);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error("reviewed npm archive output parent must be one non-symlink directory");
  }
  return realpath(parent);
}

async function defaultDownloadArchive(pin: ReviewedNpmArchivePin): Promise<Uint8Array> {
  const response = await fetch(pin.url, {
    redirect: "manual",
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (response.status !== 200) {
    throw new Error(`npm registry returned HTTP ${response.status} for ${pin.archive}`);
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (
      !Number.isSafeInteger(declaredLength) ||
      declaredLength < 1 ||
      declaredLength > MAX_ARCHIVE_BYTES
    ) {
      throw new Error(`npm registry returned an invalid size for ${pin.archive}`);
    }
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error(`downloaded npm archive size is invalid: ${pin.archive}`);
  }
  return bytes;
}

async function mapConcurrent<T>(
  values: readonly T[],
  limit: number,
  operation: (value: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        await operation(values[index]);
      }
    }),
  );
}

export async function downloadReviewedNpmArchives(options: {
  downloadArchive?: ReviewedNpmArchiveDownloader;
  output: string;
  pins: readonly ReviewedNpmArchivePin[];
}): Promise<void> {
  const pins = validatePins(options.pins);
  const parent = await exactOutputParent(options.output);
  const output = path.join(parent, path.basename(options.output));
  try {
    await lstat(output);
    throw new Error("reviewed npm archive output must not already exist");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = await mkdtemp(path.join(parent, ".reviewed-npm-archives."));
  const downloadArchive = options.downloadArchive ?? defaultDownloadArchive;
  try {
    await chmod(temporary, 0o755);
    await mapConcurrent(pins, DOWNLOAD_CONCURRENCY, async (pin) => {
      const bytes = await downloadArchive(pin);
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_ARCHIVE_BYTES) {
        throw new Error(`downloaded npm archive size is invalid: ${pin.archive}`);
      }
      const actual = crypto.createHash("sha256").update(bytes).digest("hex");
      if (actual !== pin.sha256) {
        throw new Error(`downloaded npm archive failed SHA-256 validation: ${pin.archive}`);
      }
      await writeFile(path.join(temporary, pin.archive), bytes, { flag: "wx", mode: 0o444 });
    });
    await rename(temporary, output);
  } catch (error) {
    await rm(temporary, { force: true, recursive: true });
    throw error;
  }
}

function parseArguments(argv: string[]): {
  output: string;
  pins: ReviewedNpmArchivePin[];
} {
  const [output, ...values] = argv;
  if (!output || values.length === 0 || values.length % 3 !== 0) {
    throw new Error(
      "usage: download-reviewed-npm-archives.mts <output> <sha256> <url> <archive> [...]",
    );
  }
  const pins: ReviewedNpmArchivePin[] = [];
  for (let index = 0; index < values.length; index += 3) {
    pins.push({
      sha256: values[index]!,
      url: values[index + 1]!,
      archive: values[index + 2]!,
    });
  }
  return { output, pins };
}

async function main(): Promise<void> {
  await downloadReviewedNpmArchives(parseArguments(process.argv.slice(2)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
