// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import YAML from "yaml";

export type Options = {
  version: string;
  push: boolean;
  commit: boolean;
  tag: boolean;
  dryRun: boolean;
  skipTests: boolean;
  docsMode: "latest" | "versioned";
};

type PackageJson = {
  version: string;
  scripts?: Record<string, string>;
};

type BlueprintManifest = {
  version?: string;
};

function parseJson<T>(text: string): T {
  return JSON.parse(text);
}

function parseYaml<T>(text: string): T {
  return YAML.parse(text);
}

function readStringProperty(value: object | null, key: string): string | undefined {
  if (!value || Array.isArray(value)) {
    return undefined;
  }
  const property = Reflect.get(value, key);
  return typeof property === "string" ? property : undefined;
}

function readNumberProperty(value: object | null, key: string): number | undefined {
  if (!value || Array.isArray(value)) {
    return undefined;
  }
  const property = Reflect.get(value, key);
  return typeof property === "number" ? property : undefined;
}

const REPO_ROOT = process.cwd();
const ROOT_PACKAGE_JSON = path.join(REPO_ROOT, "package.json");
const PLUGIN_PACKAGE_JSON = path.join(REPO_ROOT, "nemoclaw", "package.json");
const BLUEPRINT_YAML = path.join(REPO_ROOT, "nemoclaw-blueprint", "blueprint.yaml");
const INSTALL_SH = path.join(REPO_ROOT, "scripts", "install.sh");
const README_MD = path.join(REPO_ROOT, "README.md");
const QUICKSTART_MDX = path.join(REPO_ROOT, "docs", "get-started", "quickstart.mdx");
const VERSIONED_DOC_LINK_FILES = [README_MD, QUICKSTART_MDX];
const FILES_TO_STAGE = [
  ROOT_PACKAGE_JSON,
  PLUGIN_PACKAGE_JSON,
  BLUEPRINT_YAML,
  INSTALL_SH,
  ...VERSIONED_DOC_LINK_FILES,
];
const DOCS_PUBLIC_URL_PREFIX = "https://docs.nvidia.com/nemoclaw/";
const DOCS_URL_SEGMENT_DELIMITERS = new Set(["/", "?", "#", ")", "]", '"', "'", "`", "<", ">"]);

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const tagName = `v${options.version}`;

  ensureCleanGit();
  ensureOnMainBranch();
  ensureOriginIsCanonicalRepo();
  ensureUpToDateWithOriginMain();
  ensureTagDoesNotExist(tagName);

  const rootPackage = readJson<PackageJson>(ROOT_PACKAGE_JSON);
  const previousVersion = rootPackage.version;

  if (previousVersion === options.version) {
    throw new Error(`Version is already ${options.version}`);
  }

  const nextDocsVersion = `v${options.version}`;
  const docsSegment = options.docsMode === "versioned" ? options.version : "latest";
  const nextDocsPublicUrl = `https://docs.nvidia.com/nemoclaw/${docsSegment}`;

  if (options.dryRun) {
    printDryRunPlan(options.version, nextDocsPublicUrl, options.docsMode, options.skipTests);
    return;
  }

  updatePackageJson(ROOT_PACKAGE_JSON, options.version);
  updatePackageJson(PLUGIN_PACKAGE_JSON, options.version);
  updateBlueprintVersion(options.version);
  updateInstallScriptDefaultVersion(previousVersion, options.version);
  updateDocsVersionLinks(nextDocsPublicUrl);
  updateInstallAndUninstallDocs(nextDocsVersion);

  verifyVersionState(options.version, nextDocsPublicUrl, nextDocsVersion);

  runInstallerAndBuild(options.version);
  if (!options.skipTests) {
    runTypecheckAndTests();
  }

  if (options.commit) {
    git(["add", ...FILES_TO_STAGE]);
    git(["commit", "-m", `chore(release): bump version to ${tagName}`]);
  }

  if (options.tag) {
    git(["tag", "-a", tagName, "-m", tagName]);
  }

  if (options.push) {
    git(buildReleasePushArgs(tagName, options.tag));
  }

  log(`Version bump complete: ${previousVersion} -> ${options.version}`);
}

export function parseArgs(args: string[]): Options {
  let version = "";
  let push = false;
  let commit = true;
  let tag = true;
  let dryRun = false;
  let skipTests = false;
  let docsMode: "latest" | "versioned" = "versioned";

  for (const arg of args) {
    switch (arg) {
      case "--push":
        push = true;
        break;
      case "--no-commit":
        commit = false;
        break;
      case "--no-tag":
        tag = false;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--skip-tests":
        skipTests = true;
        break;
      case "--docs-versioned":
        docsMode = "versioned";
        break;
      case "--docs-latest":
        docsMode = "latest";
        break;
      case "-h":
      case "--help":
        printUsageAndExit(0);
        break;
      default:
        if (arg.startsWith("-")) {
          throw new Error(`Unknown flag: ${arg}`);
        }
        if (version) {
          throw new Error(`Unexpected extra argument: ${arg}`);
        }
        version = arg;
        break;
    }
  }

  if (!version) {
    printUsageAndExit(1);
  }

  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid semver: ${version}`);
  }

  if (push && !tag) {
    throw new Error("--push requires tagging; do not combine --push with --no-tag");
  }

  if (tag && !commit) {
    throw new Error("--tag requires committing; do not combine --tag with --no-commit");
  }

  return { version, push, commit, tag, dryRun, skipTests, docsMode };
}

function printUsageAndExit(code: number): never {
  const usage = [
    "Usage: npm run bump:version -- <version> [options]",
    "",
    "Options:",
    "  --push        Push the commit and semver tag to origin",
    "  --no-commit   Update files but do not create a commit",
    "  --no-tag      Update files but do not create the vX.Y.Z tag",
    "  --dry-run     Print the release plan and checks without writing files",
    "  --skip-tests  Skip npm test and typecheck verification",
    "  --docs-latest Keep public docs URLs pointed at /latest/",
    "  --docs-versioned Rewrite public docs URLs to /<version>/ (default)",
    "  -h, --help    Show this help",
  ].join("\n");

  console.log(usage);
  process.exit(code);
}

function ensureCleanGit(): void {
  const status = run("git", ["status", "--porcelain"], { allowFailure: false }).trim();
  if (status) {
    throw new Error("Git working tree is not clean");
  }
}

function ensureOnMainBranch(): void {
  const branch = run("git", ["branch", "--show-current"]).trim();
  if (branch !== "main") {
    throw new Error(
      `Release bumps must run from main. Current branch: ${branch || "(detached HEAD)"}`,
    );
  }
}

function ensureOriginIsCanonicalRepo(): void {
  const originUrl = run("git", ["remote", "get-url", "origin"]).trim();
  const allowed = new Set([
    "git@github.com:NVIDIA/NemoClaw.git",
    "https://github.com/NVIDIA/NemoClaw.git",
    "https://github.com/NVIDIA/NemoClaw",
  ]);

  if (!allowed.has(originUrl)) {
    throw new Error(
      `origin must point to the canonical NVIDIA/NemoClaw repository. Found: ${originUrl}`,
    );
  }
}

function ensureUpToDateWithOriginMain(): void {
  run("git", ["fetch", "origin", "main", "--tags"]);

  const localHead = run("git", ["rev-parse", "HEAD"]).trim();
  const originHead = run("git", ["rev-parse", "origin/main"]).trim();
  const mergeBase = run("git", ["merge-base", "HEAD", "origin/main"]).trim();

  if (localHead !== originHead) {
    if (mergeBase === originHead) {
      throw new Error(
        "Local main is ahead of origin/main. Push or reconcile before cutting a release.",
      );
    }
    if (mergeBase === localHead) {
      throw new Error("Local main is behind origin/main. Pull/rebase before cutting a release.");
    }
    throw new Error(
      "Local main has diverged from origin/main. Reconcile before cutting a release.",
    );
  }
}

function ensureTagDoesNotExist(tagName: string): void {
  if (gitRefExists(`refs/tags/${tagName}`)) {
    throw new Error(`Tag already exists: ${tagName}`);
  }
}

function updatePackageJson(filePath: string, version: string): void {
  const pkg = readJson<PackageJson>(filePath);
  pkg.version = version;
  writeFileSync(filePath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
}

function updateBlueprintVersion(version: string): void {
  const manifest = parseYaml<BlueprintManifest>(readText(BLUEPRINT_YAML));
  manifest.version = version;
  writeFileSync(BLUEPRINT_YAML, YAML.stringify(manifest), "utf8");
}

function updateInstallScriptDefaultVersion(previousVersion: string, nextVersion: string): void {
  replaceExact(
    INSTALL_SH,
    `DEFAULT_NEMOCLAW_VERSION="${previousVersion}"`,
    `DEFAULT_NEMOCLAW_VERSION="${nextVersion}"`,
  );
}

function updateDocsVersionLinks(nextDocsPublicUrl: string): void {
  for (const filePath of VERSIONED_DOC_LINK_FILES) {
    const current = readText(filePath);
    const { updated, count } = rewriteDocsPublicUrls(current, nextDocsPublicUrl);
    if (count === 0) {
      throw new Error(`No docs.nvidia.com/nemoclaw links found in ${relative(filePath)}`);
    }
    writeFileSync(filePath, updated, "utf8");
  }
}

export function rewriteDocsPublicUrls(
  content: string,
  nextDocsPublicUrl: string,
): { updated: string; count: number } {
  let cursor = 0;
  let count = 0;
  let updated = "";

  for (;;) {
    const start = content.indexOf(DOCS_PUBLIC_URL_PREFIX, cursor);
    if (start === -1) {
      updated += content.slice(cursor);
      break;
    }

    const segmentStart = start + DOCS_PUBLIC_URL_PREFIX.length;
    const segmentEnd = findDocsUrlSegmentEnd(content, segmentStart);
    const segment = content.slice(segmentStart, segmentEnd);

    updated += content.slice(cursor, start);
    if (isDocsVersionSegment(segment)) {
      updated += nextDocsPublicUrl;
      count += 1;
    } else {
      updated += content.slice(start, segmentEnd);
    }
    cursor = segmentEnd;
  }

  return { updated, count };
}

function findDocsUrlSegmentEnd(content: string, start: number): number {
  let index = start;
  while (index < content.length) {
    const char = content[index];
    if (DOCS_URL_SEGMENT_DELIMITERS.has(char) || /\s/.test(char)) break;
    index += 1;
  }
  return index;
}

function isDocsVersionSegment(segment: string): boolean {
  return segment === "latest" || /^[0-9]+\.[0-9]+\.[0-9]+$/.test(segment);
}

function updateInstallAndUninstallDocs(nextDocsVersion: string): void {
  const installReplacement = `curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash # ${nextDocsVersion}`;
  const uninstallReplacement = `curl -fsSL https://raw.githubusercontent.com/NVIDIA/NemoClaw/refs/heads/main/uninstall.sh | bash # ${nextDocsVersion}`;

  replaceCodeBlockLine(
    README_MD,
    /^curl -fsSL https:\/\/www\.nvidia\.com\/nemoclaw\.sh \| bash(?: # v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)?$/m,
    installReplacement,
  );
  replaceCodeBlockLine(
    QUICKSTART_MDX,
    /^curl -fsSL https:\/\/www\.nvidia\.com\/nemoclaw\.sh \| bash(?: # v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)?$/m,
    installReplacement,
  );
  replaceCodeBlockLine(
    README_MD,
    /^curl -fsSL https:\/\/raw\.githubusercontent\.com\/NVIDIA\/NemoClaw\/refs\/heads\/main\/uninstall\.sh \| bash(?: # v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)?$/m,
    uninstallReplacement,
  );
  replaceCodeBlockLine(
    QUICKSTART_MDX,
    /^curl -fsSL https:\/\/raw\.githubusercontent\.com\/NVIDIA\/NemoClaw\/refs\/heads\/main\/uninstall\.sh \| bash(?: # v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)?$/m,
    uninstallReplacement,
  );
}

function replaceCodeBlockLine(filePath: string, pattern: RegExp, replacement: string): void {
  const current = readText(filePath);
  if (!pattern.test(current)) {
    throw new Error(`Could not find expected command in ${relative(filePath)}`);
  }
  const updated = current.replace(pattern, replacement);
  writeFileSync(filePath, updated, "utf8");
}

function verifyVersionState(
  version: string,
  docsPublicUrl: string,
  docsDisplayVersion: string,
): void {
  assertEqual(
    readJson<PackageJson>(ROOT_PACKAGE_JSON).version,
    version,
    "root package.json version mismatch",
  );
  assertEqual(
    readJson<PackageJson>(PLUGIN_PACKAGE_JSON).version,
    version,
    "plugin package.json version mismatch",
  );

  const blueprint = parseYaml<BlueprintManifest>(readText(BLUEPRINT_YAML));
  assertEqual(blueprint.version, version, "blueprint version mismatch");

  requireContains(INSTALL_SH, `DEFAULT_NEMOCLAW_VERSION="${version}"`);
  requireContains(README_MD, docsPublicUrl);
  requireContains(README_MD, docsDisplayVersion);
  requireContains(QUICKSTART_MDX, docsDisplayVersion);
  for (const filePath of VERSIONED_DOC_LINK_FILES) {
    verifyDocsLinks(filePath, docsPublicUrl);
  }
}

function runInstallerAndBuild(version: string): void {
  log("Running installer version check");
  const installerVersion = run("bash", [INSTALL_SH, "--version"]);
  if (!installerVersion.includes(`v${version}`)) {
    throw new Error(`Installer version output did not include v${version}`);
  }

  log("Running build:cli");
  run("npm", ["run", "build:cli"]);
}

function runTypecheckAndTests(): void {
  log("Running typecheck:cli");
  run("npm", ["run", "typecheck:cli"]);

  log("Running test suite");
  run("npm", ["test"]);
}

function git(args: string[]): void {
  run("git", args);
}

export function buildReleasePushArgs(tagName: string, includeTag: boolean): string[] {
  const args = ["push", "--atomic", "origin", "HEAD"];
  if (includeTag) {
    args.push(`refs/tags/${tagName}:refs/tags/${tagName}`);
  }
  return args;
}

function gitRefExists(ref: string): boolean {
  return (
    run("git", ["show-ref", "--verify", "--quiet", ref], { allowFailure: true }).exitCode === 0
  );
}

function readJson<T>(filePath: string): T {
  return parseJson<T>(readText(filePath));
}

function readText(filePath: string): string {
  return readFileSync(filePath, "utf8");
}

function replaceExact(filePath: string, before: string, after: string): void {
  const current = readText(filePath);
  if (!current.includes(before)) {
    throw new Error(`Expected to find '${before}' in ${relative(filePath)}`);
  }
  writeFileSync(filePath, current.replace(before, after), "utf8");
}

function requireContains(filePath: string, text: string): void {
  if (!readText(filePath).includes(text)) {
    throw new Error(`Expected ${relative(filePath)} to contain: ${text}`);
  }
}

function verifyDocsLinks(filePath: string, expectedDocsPublicUrl: string): void {
  const content = readText(filePath);
  const segments = collectDocsVersionSegments(content);

  if (segments.length === 0) {
    throw new Error(`Expected at least one docs.nvidia.com/nemoclaw link in ${relative(filePath)}`);
  }

  const expectedSegment = expectedDocsPublicUrl.slice(DOCS_PUBLIC_URL_PREFIX.length);
  for (const segment of segments) {
    if (segment !== expectedSegment) {
      throw new Error(
        `Found unexpected docs version segment '${segment}' in ${relative(filePath)}; expected '${expectedSegment}'`,
      );
    }
  }
}

export function collectDocsVersionSegments(content: string): string[] {
  const segments: string[] = [];
  let cursor = 0;
  for (;;) {
    const start = content.indexOf(DOCS_PUBLIC_URL_PREFIX, cursor);
    if (start === -1) return segments;
    const segmentStart = start + DOCS_PUBLIC_URL_PREFIX.length;
    const segmentEnd = findDocsUrlSegmentEnd(content, segmentStart);
    const segment = content.slice(segmentStart, segmentEnd);
    if (segment) segments.push(segment);
    cursor = segmentEnd;
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}. Expected '${expected}', got '${String(actual)}'`);
  }
}

function run(
  command: string,
  args: string[],
  options?: { allowFailure?: boolean },
): string & { exitCode?: number } {
  try {
    const output = execFileSync(command, args, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["inherit", "pipe", "pipe"],
    });
    return Object.assign(output, { exitCode: 0 });
  } catch (error) {
    const errorObject = typeof error === "object" && error !== null ? error : null;
    const stdout = readStringProperty(errorObject, "stdout")?.trim();
    const stderr = readStringProperty(errorObject, "stderr")?.trim();
    const status = readNumberProperty(errorObject, "status") ?? 1;
    if (options?.allowFailure) {
      return Object.assign(stdout ?? "", { exitCode: status });
    }
    throw new Error(
      [`Command failed: ${command} ${args.join(" ")}`, stdout, stderr].filter(Boolean).join("\n"),
    );
  }
}

function relative(filePath: string): string {
  return path.relative(REPO_ROOT, filePath) || filePath;
}

function printDryRunPlan(
  version: string,
  docsPublicUrl: string,
  docsMode: Options["docsMode"],
  skipTests: boolean,
): void {
  log(`Dry run for version ${version}`);
  log(`Docs mode: ${docsMode}`);
  log(`Docs URL target: ${docsPublicUrl}/`);
  log(`Files to update: ${FILES_TO_STAGE.map((filePath) => relative(filePath)).join(", ")}`);
  log(
    "Pre-checks: clean git tree, main branch, canonical origin, origin/main sync, tag availability",
  );
  log(
    `Mode: ${docsMode === "versioned" ? "versioned docs" : "latest docs"}, ${skipTests ? "tests skipped" : "tests enabled"}`,
  );
  if (skipTests) {
    log("Checks: installer version and build:cli only (typecheck and tests skipped)");
  } else {
    log("Checks: installer version, build:cli, typecheck:cli, npm test");
  }
  log("No files were written. No commit, tag, or push was performed.");
}

function log(message: string): void {
  console.log(`[bump-version] ${message}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
