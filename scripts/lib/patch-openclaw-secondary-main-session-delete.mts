#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);

export const SUPPORTED_OPENCLAW_VERSION = "2026.9.5";
export const MARKER = "/* nemoclaw secondary-agent main-session delete compatibility */";
export const WORKER_MARKER =
  "/* nemoclaw worker secondary-agent main-session delete compatibility */";

const MAIN_SESSION_PATTERN =
  'const isMainSession = target.canonicalKey !== "global" && isAgentMainSessionKey(cfg, target.canonicalKey);';
const MAIN_SESSION_REPLACEMENT = [
  MAIN_SESSION_PATTERN,
  `	${MARKER}`,
  "	const mainSessionAgentId = isMainSession ? parseAgentSessionKey(target.canonicalKey)?.agentId : void 0;",
  "	const isSelectedNonDefaultMain = mainSessionAgentId !== void 0 && normalizeAgentId(mainSessionAgentId) !== protectedGlobalAgentId;",
].join("\n");
const GUARD_PATTERN =
  'if ((target.canonicalKey === "global" || isMainSession) && !isSelectedNonDefaultGlobal) {';
const GUARD_REPLACEMENT =
  'if ((target.canonicalKey === "global" || isMainSession) && !isSelectedNonDefaultGlobal && !isSelectedNonDefaultMain) {';
const GUARD_PATTERN_20261005 =
  'if ((target.canonicalKey === "global" || isMainSession) && !isSelectedNonDefaultGlobal) return invalidSessionRequest(`Cannot delete the main session (${target.canonicalKey}).`);';
const GUARD_REPLACEMENT_20261005 = GUARD_PATTERN_20261005.replace(
  "&& !isSelectedNonDefaultGlobal)",
  "&& !isSelectedNonDefaultGlobal && !isSelectedNonDefaultMain)",
);

// Both copies are inside the native content-addressed archive. The archive owner
// applies these with the proxy patches and verifies the restored upstream hash.
export const WORKER_ARCHIVE_DELETE_PATCHES = {
  "sqlite-store.worker.mjs": [
    "wi=xr.canonicalKey!==`global`&&isAgentMainSessionKey(Ln,xr.canonicalKey);if((xr.canonicalKey===`global`||wi)&&!Si)return invalidSessionRequest(",
    "wi=xr.canonicalKey!==`global`&&isAgentMainSessionKey(Ln,xr.canonicalKey);" +
      WORKER_MARKER +
      "let nemoclawSecondaryMainAgentId=wi?parseAgentSessionKey(xr.canonicalKey)?.agentId:void 0;" +
      "let nemoclawSelectedNonDefaultMain=nemoclawSecondaryMainAgentId!==void 0&&normalizeAgentId(nemoclawSecondaryMainAgentId)!==Hr;" +
      "if((xr.canonicalKey===`global`||wi)&&!Si&&!nemoclawSelectedNonDefaultMain)return invalidSessionRequest(",
  ],
  "worker-chunk-DjEXxQHh.mjs": [
    "N=x.canonicalKey!==`global`&&ue(m,x.canonicalKey);if((x.canonicalKey===`global`||N)&&!M)return te(",
    "N=x.canonicalKey!==`global`&&ue(m,x.canonicalKey);" +
      WORKER_MARKER +
      "let nemoclawSecondaryMainAgentId=N?s(x.canonicalKey)?.agentId:void 0;" +
      "let nemoclawSelectedNonDefaultMain=nemoclawSecondaryMainAgentId!==void 0&&a(nemoclawSecondaryMainAgentId)!==O;" +
      "if((x.canonicalKey===`global`||N)&&!M&&!nemoclawSelectedNonDefaultMain)return te(",
  ],
} as const;

const WORKER_PATTERN =
  "Si=pr.canonicalKey!==`global`&&isAgentMainSessionKey(Ln,pr.canonicalKey);if((pr.canonicalKey===`global`||Si)&&!mi){";
const WORKER_REPLACEMENT = [
  "Si=pr.canonicalKey!==`global`&&isAgentMainSessionKey(Ln,pr.canonicalKey);",
  WORKER_MARKER,
  "let nemoclawSecondaryMainAgentId=Si?parseAgentSessionKey(pr.canonicalKey)?.agentId:void 0;",
  "let nemoclawSelectedNonDefaultMain=nemoclawSecondaryMainAgentId!==void 0&&normalizeAgentId(nemoclawSecondaryMainAgentId)!==Br;",
  "if((pr.canonicalKey===`global`||Si)&&!mi&&!nemoclawSelectedNonDefaultMain){",
].join("");

type PatchTextResult = {
  patched: boolean;
  status: "patched" | "already-patched";
  text: string;
};

type PatchRunResult =
  | { status: "patched" | "already-patched"; files: string[]; version: string }
  | { status: "skipped-unsupported-version"; version: string };

function countOccurrences(source: string, pattern: string): number {
  return source.split(pattern).length - 1;
}

function requireCount(source: string, pattern: string, expected: number, label: string): void {
  const count = countOccurrences(source, pattern);
  if (count !== expected) {
    throw new Error(`${label}: expected ${expected}, found ${count}`);
  }
}

export function patchSecondaryAgentMainSessionDeleteText(
  source: string,
  filePath: string,
): PatchTextResult {
  const guard =
    source.includes(GUARD_PATTERN_20261005) || source.includes(GUARD_REPLACEMENT_20261005)
      ? { upstream: GUARD_PATTERN_20261005, patched: GUARD_REPLACEMENT_20261005 }
      : { upstream: GUARD_PATTERN, patched: GUARD_REPLACEMENT };
  if (source.includes(MARKER)) {
    requireCount(source, MARKER, 1, `${filePath}: compatibility marker count`);
    requireCount(source, MAIN_SESSION_REPLACEMENT, 1, `${filePath}: patched agent selector count`);
    requireCount(source, guard.patched, 1, `${filePath}: patched delete guard count`);
    requireCount(source, guard.upstream, 0, `${filePath}: unpatched delete guard count`);
    return { patched: false, status: "already-patched", text: source };
  }

  requireCount(source, MAIN_SESSION_PATTERN, 1, `${filePath}: reviewed agent selector count`);
  requireCount(source, guard.upstream, 1, `${filePath}: reviewed delete guard count`);

  const text = source
    .replace(MAIN_SESSION_PATTERN, MAIN_SESSION_REPLACEMENT)
    .replace(guard.upstream, guard.patched);

  requireCount(text, MARKER, 1, `${filePath}: patched compatibility marker count`);
  requireCount(text, MAIN_SESSION_REPLACEMENT, 1, `${filePath}: patched agent selector count`);
  requireCount(text, guard.patched, 1, `${filePath}: patched delete guard count`);
  requireCount(text, guard.upstream, 0, `${filePath}: residual unpatched delete guard count`);
  return { patched: true, status: "patched", text };
}

export function patchSecondaryAgentMainSessionDeleteWorkerText(
  source: string,
  filePath: string,
): PatchTextResult {
  if (source.includes(WORKER_MARKER)) {
    requireCount(source, WORKER_MARKER, 1, `${filePath}: worker compatibility marker count`);
    requireCount(source, WORKER_REPLACEMENT, 1, `${filePath}: patched worker guard count`);
    requireCount(source, WORKER_PATTERN, 0, `${filePath}: unpatched worker guard count`);
    return { patched: false, status: "already-patched", text: source };
  }
  requireCount(source, WORKER_PATTERN, 1, `${filePath}: reviewed worker guard count`);
  const text = source.replace(WORKER_PATTERN, WORKER_REPLACEMENT);
  requireCount(text, WORKER_REPLACEMENT, 1, `${filePath}: patched worker guard count`);
  requireCount(text, WORKER_PATTERN, 0, `${filePath}: residual unpatched worker guard count`);
  return { patched: true, status: "patched", text };
}

function readVersion(distDir: string): string {
  const packageJsonPath = path.resolve(distDir, "..", "package.json");
  const payload = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
  if (typeof payload.version !== "string") {
    throw new Error(`OpenClaw package metadata missing string version at ${packageJsonPath}`);
  }
  return payload.version;
}

function resolveTargets(distDir: string, archived: boolean): [string, string] {
  const targets = fs
    .readdirSync(distDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^sessions-delete-.*\.m?js$/u.test(entry.name))
    .map((entry) => path.join(distDir, entry.name))
    .filter((file) => fs.readFileSync(file, "utf8").includes("Cannot delete the main session ("));
  if (targets.length !== 1) {
    throw new Error(
      `Expected exactly one OpenClaw sessions.delete runtime in ${distDir}, found ${targets.length}`,
    );
  }
  if (archived) return [targets[0]!, path.join(distDir, "worker-artifacts")];
  const worker = path.join(distDir, "worker", "worker.mjs");
  if (!fs.statSync(worker, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Expected OpenClaw worker runtime at ${worker}`);
  }
  return [targets[0]!, worker];
}

export function patchOpenClawSecondaryAgentMainSessionDelete(distDir: string): PatchRunResult {
  const resolvedDist = path.resolve(distDir);
  const version = readVersion(resolvedDist);
  if (version !== SUPPORTED_OPENCLAW_VERSION && version !== "2026.9.1" && version !== "2026.10.5") {
    if (["2026.3.11", "2026.4.24"].includes(version)) {
      return { status: "skipped-unsupported-version", version };
    }
    throw new Error(
      `OpenClaw ${version} is not reviewed for the secondary-agent main-session delete compatibility patch`,
    );
  }
  const [sessionsDeleteFile, workerFile] = resolveTargets(resolvedDist, version === "2026.10.5");
  const sessionsDeleteResult = patchSecondaryAgentMainSessionDeleteText(
    fs.readFileSync(sessionsDeleteFile, "utf8"),
    sessionsDeleteFile,
  );
  if (version === "2026.10.5") {
    // Reuse the archive's complete manifest admission and publication boundary.
    // Run it even when the main module is patched, so missing workers fail closed.
    const output = execFileSync(
      "python3",
      [
        path.join(import.meta.dirname, "patch-openclaw-worker-archive.py"),
        resolvedDist,
        process.execPath,
        path.join(import.meta.dirname, "patch-openclaw-worker-proxy.mts"),
      ],
      { encoding: "utf8", timeout: 120000, maxBuffer: 1024 * 1024 },
    );
    const archiveChanged = JSON.parse(output).changed === true;
    if (sessionsDeleteResult.patched)
      fs.writeFileSync(sessionsDeleteFile, sessionsDeleteResult.text);
    return {
      status: sessionsDeleteResult.patched || archiveChanged ? "patched" : "already-patched",
      files: [sessionsDeleteFile, workerFile],
      version,
    };
  }
  const workerResult = patchSecondaryAgentMainSessionDeleteWorkerText(
    fs.readFileSync(workerFile, "utf8"),
    workerFile,
  );
  if (sessionsDeleteResult.patched) fs.writeFileSync(sessionsDeleteFile, sessionsDeleteResult.text);
  if (workerResult.patched) fs.writeFileSync(workerFile, workerResult.text);
  return {
    status: sessionsDeleteResult.patched || workerResult.patched ? "patched" : "already-patched",
    files: [sessionsDeleteFile, workerFile],
    version,
  };
}

function main(argv: readonly string[]): number {
  const distDir = argv[2];
  if (!distDir || argv.length !== 3) {
    console.error("Usage: patch-openclaw-secondary-main-session-delete.mts <openclaw-dist-dir>");
    return 2;
  }
  try {
    const result = patchOpenClawSecondaryAgentMainSessionDelete(distDir);
    console.log(JSON.stringify(result));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(SCRIPT_PATH)) {
  process.exitCode = main(process.argv);
}
