// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { moduleTagDeclarations } from "../../tools/e2e/module-tags.mts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const DEFAULT_PARITY_MANIFEST = "test/e2e/mock-parity.json";

export type MockParityEntry = {
  live: string;
  liveSources?: string[];
  fast?: string[];
  liveOnlyReason?: string;
};

export type MockParityManifest = {
  version: 1;
  entries: MockParityEntry[];
};

const LIVE_TEST = /^test\/e2e\/live\/.+\.test\.ts$/u;
const LIVE_HELPER = /^test\/e2e\/live\/(?!.*\.test\.ts$).+\.ts$/u;
const FAST_TESTS = [
  /^src\/.+\.test\.ts$/u,
  /^nemoclaw\/src\/.+\.test\.ts$/u,
  /^test\/e2e\/support\/.+\.test\.ts$/u,
  /^test\/(?!e2e\/|package-contract\/).+\.test\.(?:js|ts)$/u,
] as const;

function sourceTokens(source: string): string {
  const sourceFile = ts.createSourceFile(
    "source.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const tokens: Array<[ts.SyntaxKind, string]> = [];
  const visit = (node: ts.Node): void => {
    const children = node.getChildren(sourceFile);
    if (children.length === 0) {
      if (node.kind !== ts.SyntaxKind.EndOfFileToken) {
        tokens.push([node.kind, node.getText(sourceFile)]);
      }
      return;
    }
    for (const child of children) visit(child);
  };
  visit(sourceFile);
  return JSON.stringify({
    moduleTags: moduleTagDeclarations(source).map(({ tag }) => tag),
    tokens,
  });
}

export function isMockParityRelevantSourceChange(
  baseSource: string | null,
  headSource: string | null,
): boolean {
  if (baseSource === null || headSource === null) return true;
  return sourceTokens(baseSource) !== sourceTokens(headSource);
}

function isSafeRepoPath(file: string): boolean {
  return (
    file.length > 0 &&
    !path.posix.isAbsolute(file) &&
    !file.includes("\\") &&
    !file.split("/").includes("..")
  );
}

function isFastPrTest(file: string): boolean {
  return isSafeRepoPath(file) && FAST_TESTS.some((pattern) => pattern.test(file));
}

export function validateMockParity(options: {
  manifest: MockParityManifest;
  changedFiles: readonly string[];
  fileExists?: (file: string) => boolean;
}): string[] {
  const {
    manifest,
    changedFiles,
    fileExists = (file) => fs.existsSync(path.join(REPO_ROOT, file)),
  } = options;
  const errors: string[] = [];

  if (manifest.version !== 1 || !Array.isArray(manifest.entries)) {
    return ["mock parity manifest must have version 1 and an entries array"];
  }

  const entries = new Map<string, MockParityEntry>();
  const sourceOwners = new Map<string, MockParityEntry[]>();
  for (const entry of manifest.entries) {
    if (!entry || typeof entry !== "object" || typeof entry.live !== "string") {
      errors.push("mock parity entries must be objects with a live path");
      continue;
    }
    if (!isSafeRepoPath(entry.live) || !LIVE_TEST.test(entry.live)) {
      errors.push(`${entry.live}: live path must be a test/e2e/live/**/*.test.ts file`);
      continue;
    }
    if (entries.has(entry.live)) {
      errors.push(`${entry.live}: duplicate mock parity entry`);
      continue;
    }
    entries.set(entry.live, entry);

    if (
      entry.liveSources !== undefined &&
      (!Array.isArray(entry.liveSources) ||
        entry.liveSources.some((file) => typeof file !== "string"))
    ) {
      errors.push(`${entry.live}: liveSources must be an array of live E2E helper paths`);
      continue;
    }
    if (
      entry.fast !== undefined &&
      (!Array.isArray(entry.fast) || entry.fast.some((file) => typeof file !== "string"))
    ) {
      errors.push(`${entry.live}: fast must be an array of test paths`);
      continue;
    }
    if (entry.liveOnlyReason !== undefined && typeof entry.liveOnlyReason !== "string") {
      errors.push(`${entry.live}: liveOnlyReason must be a string`);
      continue;
    }
    const fast = entry.fast ?? [];
    const liveOnlyReason = entry.liveOnlyReason?.trim() ?? "";
    if (fast.length > 0 && liveOnlyReason) {
      errors.push(`${entry.live}: choose fast tests or a live-only reason, not both`);
    } else if (fast.length === 0 && !liveOnlyReason) {
      errors.push(`${entry.live}: map at least one fast test or provide a live-only reason`);
    }

    if (!fileExists(entry.live)) errors.push(`${entry.live}: live test does not exist`);
    for (const sourceFile of new Set(entry.liveSources ?? [])) {
      if (!isSafeRepoPath(sourceFile) || !LIVE_HELPER.test(sourceFile)) {
        errors.push(`${entry.live}: ${sourceFile} is not a test/e2e/live/**/*.ts helper file`);
        continue;
      }
      if (!fileExists(sourceFile)) {
        errors.push(`${entry.live}: live E2E helper does not exist: ${sourceFile}`);
      }
      const owners = sourceOwners.get(sourceFile) ?? [];
      owners.push(entry);
      sourceOwners.set(sourceFile, owners);
    }
    for (const fastFile of new Set(fast)) {
      if (!isFastPrTest(fastFile)) {
        errors.push(`${entry.live}: ${fastFile} is not collected by a fast PR test project`);
      } else if (!fileExists(fastFile)) {
        errors.push(`${entry.live}: mapped fast test does not exist: ${fastFile}`);
      }
    }
  }

  const changedFileSet = new Set(changedFiles);
  const requireChangedFastTest = (entry: MockParityEntry, changedSource: string): void => {
    const mappedFastTests = Array.isArray(entry.fast)
      ? entry.fast.filter((fastFile): fastFile is string => typeof fastFile === "string")
      : [];
    if (
      mappedFastTests.length > 0 &&
      !mappedFastTests.some((fastFile) => changedFileSet.has(fastFile))
    ) {
      errors.push(
        changedSource === entry.live
          ? `${entry.live}: change at least one mapped fast PR test with the live E2E`
          : `${changedSource}: change at least one fast PR test mapped from ${entry.live}`,
      );
    }
  };

  for (const liveFile of [...changedFileSet].filter((file) => LIVE_TEST.test(file))) {
    const entry = entries.get(liveFile);
    if (!entry) {
      errors.push(`${liveFile}: changed live E2E needs an entry in ${DEFAULT_PARITY_MANIFEST}`);
      continue;
    }
    requireChangedFastTest(entry, liveFile);
  }

  for (const helperFile of [...changedFileSet].filter((file) => LIVE_HELPER.test(file))) {
    const owners = sourceOwners.get(helperFile) ?? [];
    if (owners.length === 0) {
      errors.push(
        `${helperFile}: changed live E2E helper needs an owning entry in ${DEFAULT_PARITY_MANIFEST}`,
      );
      continue;
    }
    for (const owner of owners) requireChangedFastTest(owner, helperFile);
  }

  return errors.sort();
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function sourceAtRef(ref: string, file: string): string | null {
  try {
    return execFileSync("git", ["show", `${ref}:${file}`], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/** Remove metadata-only live and fast test changes before parity validation. */
export function filterMockParityRelevantChangedFiles(
  files: readonly string[],
  sourceAtBase: (file: string) => string | null,
  sourceAtHead: (file: string) => string | null,
): string[] {
  return files.filter((file) => {
    if (!LIVE_TEST.test(file) && !LIVE_HELPER.test(file) && !isFastPrTest(file)) return true;
    return isMockParityRelevantSourceChange(sourceAtBase(file), sourceAtHead(file));
  });
}

function changedFiles(base: string, head: string): string[] {
  const files = execFileSync(
    "git",
    ["diff", "--name-only", "--diff-filter=ACMR", `${base}...${head}`],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
    },
  )
    .split(/\r?\n/u)
    .filter(Boolean);
  return filterMockParityRelevantChangedFiles(
    files,
    (file) => sourceAtRef(base, file),
    (file) => sourceAtRef(head, file),
  );
}

function main(): void {
  const base = argument("--base");
  const head = argument("--head") ?? "HEAD";
  if (!base) throw new Error("usage: e2e-mock-parity.mts --base <git-ref> [--head <git-ref>]");

  const manifestPath = path.join(REPO_ROOT, DEFAULT_PARITY_MANIFEST);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as MockParityManifest;
  const errors = validateMockParity({ manifest, changedFiles: changedFiles(base, head) });
  if (errors.length > 0) {
    console.error(
      ["E2E mock/live parity check failed:", ...errors.map((error) => `- ${error}`)].join("\n"),
    );
    process.exitCode = 1;
    return;
  }
  console.log("E2E mock/live parity check passed.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
