// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { moduleTagDeclarations } from "../../tools/e2e/module-tags.mts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const DEFAULT_PARITY_EXCEPTIONS = "test/e2e/fast-test-exceptions.json";

export type MockParityEntry = {
  live: string;
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
  for (const entry of manifest.entries) {
    if (!entry || typeof entry !== "object" || typeof entry.live !== "string") {
      errors.push("mock parity entries must be objects with a live path");
      continue;
    }
    if (
      !isSafeRepoPath(entry.live) ||
      (!LIVE_TEST.test(entry.live) && !LIVE_HELPER.test(entry.live))
    ) {
      errors.push(`${entry.live}: live path must be a test/e2e/live/**/*.ts source`);
      continue;
    }
    if (entries.has(entry.live)) {
      errors.push(`${entry.live}: duplicate mock parity entry`);
      continue;
    }
    entries.set(entry.live, entry);

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
    for (const fastFile of new Set(fast)) {
      if (!isFastPrTest(fastFile)) {
        errors.push(`${entry.live}: ${fastFile} is not collected by a fast PR test project`);
      } else if (!fileExists(fastFile)) {
        errors.push(`${entry.live}: mapped fast test does not exist: ${fastFile}`);
      }
    }
  }

  const changedFileSet = new Set(changedFiles);
  for (const liveFile of [...changedFileSet].filter(
    (file) => LIVE_TEST.test(file) || LIVE_HELPER.test(file),
  )) {
    const entry = entries.get(liveFile);
    if (!entry) {
      errors.push(
        `${liveFile}: changed live E2E source needs a discovered fast test or an exception in ${DEFAULT_PARITY_EXCEPTIONS}`,
      );
      continue;
    }
    if (
      Array.isArray(entry.fast) &&
      entry.fast.length > 0 &&
      !entry.fast.some((file) => changedFileSet.has(file))
    ) {
      errors.push(`${liveFile}: change at least one mapped fast PR test with the live source`);
    }
  }

  return errors.sort();
}

/** Discover fast-test ownership without importing or executing candidate modules. */
export function discoverMockParity(
  sources: ReadonlyMap<string, string>,
  exceptions: MockParityManifest,
): MockParityManifest {
  const graph = new Map<string, string[]>();
  const resolve = (importer: string, specifier: string): string | undefined => {
    if (!specifier.startsWith(".")) return undefined;
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
    const stem = base.replace(/\.[cm]?[jt]sx?$/u, "");
    return [
      base,
      ...[".ts", ".mts", ".cts", ".js", ".tsx", "/index.ts"].map((suffix) => stem + suffix),
    ].find((file) => sources.has(file));
  };
  for (const [file, source] of sources) {
    graph.set(
      file,
      ts
        .preProcessFile(source, true, true)
        .importedFiles.map(({ fileName }) => resolve(file, fileName))
        .filter((dependency): dependency is string => dependency !== undefined),
    );
  }
  const reachable = (file: string): Set<string> => {
    const seen = new Set<string>();
    const pending = [file];
    while (pending.length > 0) {
      const next = pending.pop()!;
      if (seen.has(next)) continue;
      seen.add(next);
      pending.push(...(graph.get(next) ?? []));
    }
    return seen;
  };
  const liveSources = [...sources.keys()].filter(
    (file) => LIVE_TEST.test(file) || LIVE_HELPER.test(file),
  );
  const defaults = new Map<string, Set<string>>(liveSources.map((file) => [file, new Set()]));
  for (const fast of [...sources.keys()].filter(isFastPrTest)) {
    for (const dependency of reachable(fast)) defaults.get(dependency)?.add(fast);
  }
  for (const file of liveSources) {
    const sibling = file
      .replace("test/e2e/live/", "test/e2e/support/")
      .replace(/(?<!\.test)\.ts$/u, ".test.ts");
    if (sources.has(sibling)) defaults.get(file)!.add(sibling);
  }
  const explicit = new Map(exceptions.entries.map((entry) => [entry.live, entry]));
  const entries: MockParityEntry[] = [];
  for (const file of liveSources) {
    const exception = explicit.get(file);
    if (exception) {
      entries.push(exception);
      continue;
    }
    const fast = new Set(defaults.get(file));
    if (LIVE_TEST.test(file)) {
      for (const dependency of reachable(file)) {
        for (const test of defaults.get(dependency) ?? []) fast.add(test);
      }
    }
    if (fast.size > 0) entries.push({ live: file, fast: [...fast].sort() });
  }
  return { version: 1, entries };
}

function repositorySources(): Map<string, string> {
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: REPO_ROOT, encoding: "utf8" })
    .split("\0")
    .filter((file) => /\.[cm]?[jt]sx?$/u.test(file));
  return new Map(
    files
      .filter((file) => fs.existsSync(path.join(REPO_ROOT, file)))
      .map((file) => [file, fs.readFileSync(path.join(REPO_ROOT, file), "utf8")]),
  );
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

  const manifestPath = path.join(REPO_ROOT, DEFAULT_PARITY_EXCEPTIONS);
  const exceptions = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as MockParityManifest;
  const exceptionErrors = validateMockParity({ manifest: exceptions, changedFiles: [] });
  const manifest =
    exceptionErrors.length === 0
      ? discoverMockParity(repositorySources(), exceptions)
      : { version: 1 as const, entries: [] };
  const errors = [
    ...exceptionErrors,
    ...validateMockParity({ manifest, changedFiles: changedFiles(base, head) }),
  ];
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
