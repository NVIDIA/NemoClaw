#!/usr/bin/env -S node --experimental-strip-types
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const NPM_OUTPUT_MAX_BUFFER = 16 * 1024 * 1024;
const EXACT_NPM_PACKAGE_SPEC = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)@[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;

export type ReviewedNpmArchiveRequest = Readonly<{
  env?: NodeJS.ProcessEnv;
  expectedIntegrity: string;
  label: string;
  npmExecutable?: string;
  packageSpec: string;
  tarballUrl: string;
  tempDirectory?: string;
}>;

export type ReviewedNpmMetadata = Readonly<{
  integrity: string;
  tarballUrl: string;
}>;

export type ReviewedNpmArchive = Readonly<{
  archivePath: string;
  rootDirectory: string;
}>;

type NpmRunner = (args: readonly string[], request: ReviewedNpmArchiveRequest) => string;

function runNpm(args: readonly string[], request: ReviewedNpmArchiveRequest): string {
  const result = spawnSync(request.npmExecutable ?? "npm", args, {
    encoding: "utf-8",
    env: request.env,
    maxBuffer: NPM_OUTPUT_MAX_BUFFER,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    throw new Error(
      `${request.label} npm ${args[0] ?? "command"} failed${detail ? `: ${detail}` : ""}`,
    );
  }
  return String(result.stdout ?? "");
}

function requireReviewedRequest(request: ReviewedNpmArchiveRequest): void {
  if (!EXACT_NPM_PACKAGE_SPEC.test(request.packageSpec)) {
    throw new Error(`${request.label} must use an exact npm package spec: ${request.packageSpec}`);
  }
  if (!request.expectedIntegrity.startsWith("sha512-")) {
    throw new Error(`${request.label} must use a committed sha512 npm integrity value`);
  }
  if (!request.tarballUrl) {
    throw new Error(`${request.label} must use a committed npm tarball URL`);
  }
}

export function verifyReviewedNpmMetadata(
  request: ReviewedNpmArchiveRequest,
  npmRunner: NpmRunner = runNpm,
): ReviewedNpmMetadata {
  requireReviewedRequest(request);
  const integrity = npmRunner(["view", request.packageSpec, "dist.integrity"], request).trim();
  if (integrity !== request.expectedIntegrity) {
    throw new Error(
      `${request.label} npm integrity mismatch\nExpected: ${request.expectedIntegrity}\nActual:   ${integrity}`,
    );
  }

  const tarballUrl = npmRunner(["view", request.packageSpec, "dist.tarball"], request).trim();
  if (tarballUrl !== request.tarballUrl) {
    throw new Error(
      `${request.label} npm tarball URL mismatch\nExpected: ${request.tarballUrl}\nActual:   ${tarballUrl}`,
    );
  }
  return { integrity, tarballUrl };
}

export function resolveReviewedNpmArchivePath(
  packageSpec: string,
  rootDirectory: string,
  filename: string,
): string {
  if (
    !filename ||
    isAbsolute(filename) ||
    filename === "." ||
    filename === ".." ||
    filename.includes("/") ||
    filename.includes("\\")
  ) {
    throw new Error(`npm pack ${packageSpec} reported unsafe archive filename: ${filename}`);
  }

  const root = resolve(rootDirectory);
  const archivePath = resolve(root, filename);
  if (!archivePath.startsWith(`${root}${sep}`)) {
    throw new Error(
      `npm pack ${packageSpec} reported archive path outside pack directory: ${filename}`,
    );
  }
  if (!existsSync(archivePath)) {
    throw new Error(`npm pack ${packageSpec} did not create reported archive: ${filename}`);
  }
  const archive = lstatSync(archivePath);
  if (!archive.isFile() || archive.isSymbolicLink()) {
    throw new Error(`npm pack ${packageSpec} reported a non-file archive: ${filename}`);
  }
  return archivePath;
}

export function packReviewedNpmArchive(
  request: ReviewedNpmArchiveRequest,
  npmRunner: NpmRunner = runNpm,
): ReviewedNpmArchive {
  verifyReviewedNpmMetadata(request, npmRunner);
  const rootDirectory = mkdtempSync(
    join(request.tempDirectory ?? tmpdir(), "nemoclaw-reviewed-npm-pack-"),
  );
  try {
    const packJson = npmRunner(
      ["pack", request.tarballUrl, "--pack-destination", rootDirectory, "--json"],
      request,
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(packJson);
    } catch (error) {
      throw new Error(`npm pack ${request.packageSpec} did not return JSON: ${String(error)}`);
    }
    const entry = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : undefined;
    const filename =
      typeof entry === "object" && entry !== null && "filename" in entry
        ? String(entry.filename ?? "")
        : "";
    const actualIntegrity =
      typeof entry === "object" && entry !== null && "integrity" in entry
        ? String(entry.integrity ?? "")
        : "";
    if (!filename || !actualIntegrity) {
      throw new Error(`npm pack ${request.packageSpec} did not report filename and integrity`);
    }
    if (actualIntegrity !== request.expectedIntegrity) {
      throw new Error(
        `${request.label} downloaded tarball integrity mismatch\nExpected: ${request.expectedIntegrity}\nActual:   ${actualIntegrity}`,
      );
    }
    return {
      archivePath: resolveReviewedNpmArchivePath(
        request.packageSpec,
        rootDirectory,
        filename,
      ),
      rootDirectory,
    };
  } catch (error) {
    rmSync(rootDirectory, { recursive: true, force: true });
    throw error;
  }
}

export function removeReviewedNpmArchive(archive: ReviewedNpmArchive): void {
  rmSync(archive.rootDirectory, { recursive: true, force: true });
}

type CliOptions = ReviewedNpmArchiveRequest & Readonly<{ verifyOnly: boolean }>;

function parseCliOptions(argv: readonly string[]): CliOptions {
  const values = new Map<string, string>();
  let verifyOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--verify-only") {
      verifyOnly = true;
      continue;
    }
    if (!arg?.startsWith("--")) throw new Error(`Unknown argument: ${arg ?? ""}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    values.set(arg, value);
    index += 1;
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  return {
    expectedIntegrity: required("--integrity"),
    label: required("--label"),
    npmExecutable: process.env.NEMOCLAW_REVIEWED_NPM_EXECUTABLE,
    packageSpec: required("--package-spec"),
    tarballUrl: required("--tarball-url"),
    tempDirectory: values.get("--temp-directory"),
    verifyOnly,
  };
}

function isMainModule(): boolean {
  return process.argv[1] ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href : false;
}

if (isMainModule()) {
  try {
    const options = parseCliOptions(process.argv.slice(2));
    if (options.verifyOnly) {
      verifyReviewedNpmMetadata(options);
    } else {
      process.stdout.write(`${packReviewedNpmArchive(options).archivePath}\n`);
    }
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
