// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { type ArtifactSink, slugifyArtifactName } from "./artifacts.ts";

const MAX_RETAINED_FILE_BYTES = 512_000;
const MAX_RETAINED_FILES = 24;
const MAX_RETAINED_TOTAL_BYTES = 2_000_000;
const REPORTED_DIAGNOSTIC_PREFIXES = [
  "Pre-rollback diagnostics saved:",
  "Pre-cleanup diagnostics saved:",
] as const;
const ALLOWED_DIAGNOSTIC_FILES = new Set([
  "summary.txt",
  "patched-container-state.json",
  "docker-top.txt",
  "lifecycle-history.json",
  "forward-start.txt",
  "forward-list.txt",
  "docker-ps.txt",
  "docker-inspect.json",
  "docker-network-summary.txt",
  "docker-logs.txt",
  "managed-startup.log",
  "openclaw-gateway.log",
  "openshell-sandbox-get.txt",
  "openshell-version.txt",
  "openshell-sandbox-list.txt",
  "openshell-forward-list.txt",
  "openshell-logs.txt",
]);

function containedRealPath(candidate: string, stateRootRealPath: string): string | null {
  try {
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink()) return null;
    const resolved = fs.realpathSync(candidate);
    return resolved.startsWith(`${stateRootRealPath}${path.sep}`) ? resolved : null;
  } catch {
    return null;
  }
}

function reportedDiagnosticDirectory(output: string): string | null {
  const reported = output
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "")
    .split(/\r?\n/u)
    .map((line) => {
      const trimmed = line.trimStart();
      const prefix = REPORTED_DIAGNOSTIC_PREFIXES.find((candidate) =>
        trimmed.startsWith(candidate),
      );
      return prefix ? trimmed.slice(prefix.length).trim() : "";
    })
    .filter(Boolean);
  return reported.at(-1) ?? null;
}

function readBoundedRegularFile(
  candidate: string,
  stateRootRealPath: string,
  remainingBytes: number,
): { content: string; size: number } | null {
  const source = containedRealPath(candidate, stateRootRealPath);
  if (!source) return null;
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const openedStat = fs.fstatSync(descriptor);
    if (
      !openedStat.isFile() ||
      openedStat.size > MAX_RETAINED_FILE_BYTES ||
      openedStat.size > remainingBytes
    ) {
      return null;
    }
    const verifiedSource = containedRealPath(source, stateRootRealPath);
    if (verifiedSource !== source) return null;
    const verifiedStat = fs.statSync(verifiedSource);
    if (verifiedStat.dev !== openedStat.dev || verifiedStat.ino !== openedStat.ino) return null;
    const buffer = Buffer.alloc(openedStat.size);
    const bytesRead = fs.readSync(descriptor, buffer, 0, openedStat.size, 0);
    return { content: buffer.subarray(0, bytesRead).toString("utf8"), size: bytesRead };
  } catch {
    return null;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

export async function retainOnboardFailureArtifacts(options: {
  artifacts: ArtifactSink;
  artifactName: string;
  diagnosticOutput: string;
  homeDir: string;
  sandboxName: string;
}): Promise<string[]> {
  const stateRoot = path.join(options.homeDir, ".nemoclaw");
  let stateRootRealPath: string;
  try {
    stateRootRealPath = fs.realpathSync(stateRoot);
  } catch {
    return [];
  }
  const reportedDir = reportedDiagnosticDirectory(options.diagnosticOutput);
  if (!reportedDir || !path.isAbsolute(reportedDir)) return [];
  const expectedSuffix = `-${options.sandboxName}-docker-gpu-patch`;
  const diagnosticDir = containedRealPath(reportedDir, stateRootRealPath);
  if (!diagnosticDir || !path.basename(diagnosticDir).endsWith(expectedSuffix)) return [];

  const retained: string[] = [];
  let totalBytes = 0;
  let files: fs.Dirent[];
  try {
    files = fs.readdirSync(diagnosticDir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const file of files.sort((left, right) => left.name.localeCompare(right.name))) {
    if (retained.length >= MAX_RETAINED_FILES) break;
    if (!file.isFile() || file.isSymbolicLink() || !ALLOWED_DIAGNOSTIC_FILES.has(file.name)) {
      continue;
    }
    const bounded = readBoundedRegularFile(
      path.join(diagnosticDir, file.name),
      stateRootRealPath,
      MAX_RETAINED_TOTAL_BYTES - totalBytes,
    );
    if (!bounded) continue;
    const relativePath = path.join(
      "onboard-failures",
      slugifyArtifactName(options.artifactName),
      path.basename(diagnosticDir),
      file.name,
    );
    await options.artifacts.writeText(relativePath, bounded.content);
    retained.push(relativePath);
    totalBytes += bounded.size;
  }
  return retained.sort();
}
