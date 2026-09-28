#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);

export const SUPPORTED_OPENCLAW_VERSION = "2026.9.1";
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
  if (source.includes(MARKER)) {
    requireCount(source, MARKER, 1, `${filePath}: compatibility marker count`);
    requireCount(source, MAIN_SESSION_REPLACEMENT, 1, `${filePath}: patched agent selector count`);
    requireCount(source, GUARD_REPLACEMENT, 1, `${filePath}: patched delete guard count`);
    requireCount(source, GUARD_PATTERN, 0, `${filePath}: unpatched delete guard count`);
    return { patched: false, status: "already-patched", text: source };
  }

  requireCount(source, MAIN_SESSION_PATTERN, 1, `${filePath}: reviewed agent selector count`);
  requireCount(source, GUARD_PATTERN, 1, `${filePath}: reviewed delete guard count`);

  const text = source
    .replace(MAIN_SESSION_PATTERN, MAIN_SESSION_REPLACEMENT)
    .replace(GUARD_PATTERN, GUARD_REPLACEMENT);

  requireCount(text, MARKER, 1, `${filePath}: patched compatibility marker count`);
  requireCount(text, MAIN_SESSION_REPLACEMENT, 1, `${filePath}: patched agent selector count`);
  requireCount(text, GUARD_REPLACEMENT, 1, `${filePath}: patched delete guard count`);
  requireCount(text, GUARD_PATTERN, 0, `${filePath}: residual unpatched delete guard count`);
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

function resolveTargets(distDir: string): [string, string] {
  const targets = fs
    .readdirSync(distDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^sessions-delete-.*\.js$/u.test(entry.name))
    .map((entry) => path.join(distDir, entry.name))
    .filter((file) => fs.readFileSync(file, "utf8").includes("Cannot delete the main session ("));
  if (targets.length !== 1) {
    throw new Error(
      `Expected exactly one OpenClaw sessions.delete runtime in ${distDir}, found ${targets.length}`,
    );
  }
  const worker = path.join(distDir, "worker", "worker.mjs");
  if (!fs.statSync(worker, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Expected OpenClaw worker runtime at ${worker}`);
  }
  return [targets[0]!, worker];
}

export function patchOpenClawSecondaryAgentMainSessionDelete(distDir: string): PatchRunResult {
  const resolvedDist = path.resolve(distDir);
  const version = readVersion(resolvedDist);
  if (version !== SUPPORTED_OPENCLAW_VERSION) {
    if (["2026.3.11", "2026.4.24"].includes(version)) {
      return { status: "skipped-unsupported-version", version };
    }
    throw new Error(
      `OpenClaw ${version} is not reviewed for the secondary-agent main-session delete compatibility patch`,
    );
  }
  const [sessionsDeleteFile, workerFile] = resolveTargets(resolvedDist);
  const sessionsDeleteResult = patchSecondaryAgentMainSessionDeleteText(
    fs.readFileSync(sessionsDeleteFile, "utf8"),
    sessionsDeleteFile,
  );
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
