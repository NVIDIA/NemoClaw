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
  /** Live helpers and explicitly owned shared test/e2e/fixtures sources. */
  liveSources?: string[];
  fast?: string[];
  liveOnlyReason?: string;
};

export type MockParityManifest = {
  version: 1;
  entries: MockParityEntry[];
};

const LIVE_TEST = /^test\/e2e\/live\/.+\.test\.ts$/u;
const LIVE_HELPER = /^test\/e2e\/live\/(?!.*\.test\.ts$).+\.(?:py|ts)$/u;
const SHARED_FIXTURE = /^test\/e2e\/fixtures\/(?!.*\.test\.ts$).+\.ts$/u;
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
    // Ignore only optional list punctuation; runtime operators and array holes remain.
    for (const child of children) {
      if (
        node.kind === ts.SyntaxKind.SyntaxList &&
        child.kind === ts.SyntaxKind.CommaToken &&
        child === children.at(-1)
      )
        continue;
      if (
        child === children[0] &&
        ((node.parent?.kind === ts.SyntaxKind.UnionType && child.kind === ts.SyntaxKind.BarToken) ||
          (node.parent?.kind === ts.SyntaxKind.IntersectionType &&
            child.kind === ts.SyntaxKind.AmpersandToken))
      )
        continue;
      visit(child);
    }
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
  baseManifest?: MockParityManifest;
  changedFastTestRenames?: ReadonlyMap<string, string>;
  renamedLiveOwners?: ReadonlyMap<string, string>;
  changedFiles: readonly string[];
  fileExists?: (file: string) => boolean;
}): string[] {
  const {
    manifest,
    baseManifest,
    changedFastTestRenames = new Map<string, string>(),
    renamedLiveOwners = new Map<string, string>(),
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
      errors.push(
        `${entry.live}: liveSources must be an array of live E2E helper or shared fixture paths`,
      );
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
      if (
        !isSafeRepoPath(sourceFile) ||
        !(LIVE_HELPER.test(sourceFile) || SHARED_FIXTURE.test(sourceFile))
      ) {
        errors.push(
          `${entry.live}: ${sourceFile} is not a test/e2e/live/**/*.py or *.ts helper or test/e2e/fixtures/**/*.ts fixture`,
        );
        continue;
      }
      if (!fileExists(sourceFile)) {
        errors.push(
          `${entry.live}: live E2E helper or shared fixture does not exist: ${sourceFile}`,
        );
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
  const requireChangedFastTest = (
    entry: MockParityEntry,
    changedSource: string,
    allowRename = false,
  ): void => {
    const mappedFastTests = Array.isArray(entry.fast)
      ? entry.fast.filter((fastFile): fastFile is string => typeof fastFile === "string")
      : [];
    if (
      mappedFastTests.length > 0 &&
      !mappedFastTests.some((fastFile) => {
        if (changedFileSet.has(fastFile)) return true;
        const replacement = allowRename ? changedFastTestRenames.get(fastFile) : undefined;
        return (
          replacement !== undefined &&
          isFastPrTest(replacement) &&
          fileExists(replacement) &&
          changedFileSet.has(replacement) &&
          entries.get(renamedLiveOwners.get(entry.live) ?? entry.live)?.fast?.includes(replacement)
        );
      })
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

  // Removing an explicit owner must not exempt a changed fixture from its
  // established fast-test obligation in the same PR.
  for (const entry of baseManifest?.entries ?? []) {
    for (const source of entry.liveSources ?? []) {
      if (SHARED_FIXTURE.test(source) && changedFileSet.has(source)) {
        const headEntry = entries.get(renamedLiveOwners.get(entry.live) ?? entry.live);
        const retainsOwnership =
          headEntry?.liveSources?.includes(source) &&
          entry.fast?.every((fastFile) => headEntry.fast?.includes(fastFile));
        requireChangedFastTest(
          headEntry && retainsOwnership ? { ...entry, fast: headEntry.fast } : entry,
          source,
          true,
        );
      }
    }
  }

  // Existing live helpers require ownership; shared fixtures opt in explicitly
  // through liveSources so unrelated fixture contracts are not broadened.
  for (const helperFile of [...changedFileSet].filter(
    (file) => LIVE_HELPER.test(file) || sourceOwners.has(file),
  )) {
    const owners = sourceOwners.get(helperFile) ?? [];
    if (owners.length === 0) {
      errors.push(
        `${helperFile}: changed live E2E helper needs an owning entry in ${DEFAULT_PARITY_MANIFEST}`,
      );
      continue;
    }
    for (const owner of owners) requireChangedFastTest(owner, helperFile);
  }

  return [...new Set(errors)].sort();
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function sourceAtRef(ref: string, file: string, repoRoot = REPO_ROOT): string | null {
  try {
    return execFileSync("git", ["show", `${ref}:${file}`], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
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
    if (
      !LIVE_TEST.test(file) &&
      !LIVE_HELPER.test(file) &&
      !SHARED_FIXTURE.test(file) &&
      !isFastPrTest(file)
    )
      return true;
    // Python indentation is executable syntax, so the TypeScript token filter
    // cannot safely classify any Python helper change as metadata-only.
    if (LIVE_HELPER.test(file) && file.endsWith(".py")) return true;
    return isMockParityRelevantSourceChange(sourceAtBase(file), sourceAtHead(file));
  });
}

function gitRenamedPaths(base: string, head: string, repoRoot: string): Map<string, string> {
  const fields = execFileSync(
    "git",
    ["diff", "--name-status", "-z", "--find-renames", "--diff-filter=R", `${base}...${head}`],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  ).split("\0");
  const paths = new Map<string, string>();
  for (let index = 0; index + 2 < fields.length; index += 3) {
    paths.set(fields[index + 2]!, fields[index + 1]!);
  }
  return paths;
}

export function collectMockParityChangedFiles(
  base: string,
  head: string,
  repoRoot = REPO_ROOT,
): string[] {
  const names = (filter: string, options: readonly string[] = []): string[] =>
    execFileSync(
      "git",
      ["diff", "--name-only", `--diff-filter=${filter}`, ...options, `${base}...${head}`],
      {
        cwd: repoRoot,
        encoding: "utf8",
      },
    )
      .split(/\r?\n/u)
      .filter(Boolean);
  // Preserve existing deletion handling for other source kinds; explicitly owned
  // shared fixtures retain their base-manifest obligation after deletion.
  const files = [
    ...names("ACMR"),
    ...names("D", ["--no-renames"]).filter((file) => SHARED_FIXTURE.test(file)),
  ];
  const renamedPaths = gitRenamedPaths(base, head, repoRoot);
  return filterMockParityRelevantChangedFiles(
    files,
    (file) => sourceAtRef(base, renamedPaths.get(file) ?? file, repoRoot),
    (file) => sourceAtRef(head, file, repoRoot),
  );
}

/** Preserve base ownership only through Git-proven live-owner and changed fast-test renames. */
export function collectMockParityRenames(
  base: string,
  head: string,
  repoRoot = REPO_ROOT,
): { changedFastTestRenames: Map<string, string>; renamedLiveOwners: Map<string, string> } {
  const changedFastTestRenames = new Map<string, string>();
  const renamedLiveOwners = new Map<string, string>();
  for (const [newPath, oldPath] of gitRenamedPaths(base, head, repoRoot)) {
    const before = sourceAtRef(base, oldPath, repoRoot);
    const after = sourceAtRef(head, newPath, repoRoot);
    if (before === null || after === null) continue;
    if (LIVE_TEST.test(oldPath) && LIVE_TEST.test(newPath)) renamedLiveOwners.set(oldPath, newPath);
    if (
      isFastPrTest(oldPath) &&
      isFastPrTest(newPath) &&
      isMockParityRelevantSourceChange(before, after)
    ) {
      changedFastTestRenames.set(oldPath, newPath);
    }
  }
  return { changedFastTestRenames, renamedLiveOwners };
}

function main(): void {
  const base = argument("--base");
  const head = argument("--head") ?? "HEAD";
  if (!base) throw new Error("usage: e2e-mock-parity.mts --base <git-ref> [--head <git-ref>]");

  const manifestPath = path.join(REPO_ROOT, DEFAULT_PARITY_MANIFEST);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as MockParityManifest;
  const baseManifest = JSON.parse(
    execFileSync("git", ["show", `${base}:${DEFAULT_PARITY_MANIFEST}`], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    }),
  ) as MockParityManifest;
  const errors = validateMockParity({
    manifest,
    baseManifest,
    changedFiles: collectMockParityChangedFiles(base, head),
    ...collectMockParityRenames(base, head),
  });
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
