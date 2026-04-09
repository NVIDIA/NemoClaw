// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import moveMap from "./ts-migration/move-map.json";

type Options = {
  base: string;
  write: boolean;
  strict: boolean;
};

const REPO_ROOT = process.cwd();
const DIST_ROOT = path.join(REPO_ROOT, "dist");
const SRC_ROOT = path.join(REPO_ROOT, "src");
const WRAPPER_HEADER = "// @ts-nocheck\n";
const RUNTIME_MOVES = moveMap.runtimeMoves as Record<string, string>;

const SPECIAL_REWRITES: Record<string, Array<[string, string]>> = {
  "bin/lib/onboard.js": [
    ['require("./runner")', 'require("../../bin/lib/runner")'],
    ['require("./sandbox-build-context")', 'require("../../bin/lib/sandbox-build-context")'],
    ['require("./local-inference")', 'require("../../bin/lib/local-inference")'],
    ['require("./inference-config")', 'require("../../bin/lib/inference-config")'],
    ['require("./platform")', 'require("../../bin/lib/platform")'],
    ['require("./resolve-openshell")', 'require("../../bin/lib/resolve-openshell")'],
    ['require("./credentials")', 'require("../../bin/lib/credentials")'],
    ['require("./registry")', 'require("../../bin/lib/registry")'],
    ['require("./nim")', 'require("../../bin/lib/nim")'],
    ['require("./onboard-session")', 'require("../../bin/lib/onboard-session")'],
    ['require("./policies")', 'require("../../bin/lib/policies")'],
    ['require("./usage-notice")', 'require("../../bin/lib/usage-notice")'],
    ['require("./preflight")', 'require("../../bin/lib/preflight")'],
  ],
  "bin/nemoclaw.js": [
    ['require("./lib/runner")', 'require("../bin/lib/runner")'],
    ['require("./lib/resolve-openshell")', 'require("../bin/lib/resolve-openshell")'],
    ['require("./lib/onboard")', 'require("../bin/lib/onboard")'],
    ['require("./lib/credentials")', 'require("../bin/lib/credentials")'],
    ['require("./lib/registry")', 'require("../bin/lib/registry")'],
    ['require("./lib/nim")', 'require("../bin/lib/nim")'],
    ['require("./lib/policies")', 'require("../bin/lib/policies")'],
    ['require("./lib/inference-config")', 'require("../bin/lib/inference-config")'],
    ['require("./lib/version")', 'require("../bin/lib/version")'],
    ['require("./lib/onboard-session")', 'require("../bin/lib/onboard-session")'],
    ['require("./lib/runtime-recovery")', 'require("../bin/lib/runtime-recovery")'],
    ['require("./lib/usage-notice")', 'require("../bin/lib/usage-notice")'],
    ['require("./lib/services")', 'require("../bin/lib/services")'],
    ['require("./lib/debug")', 'require("../bin/lib/debug")'],
    ['require("./lib/debug-command")', 'require("./lib/debug-command")'],
    ['require("../dist/lib/debug-command")', 'require("./lib/debug-command")'],
    ['require("../dist/lib/openshell")', 'require("./lib/openshell")'],
    ['require("../dist/lib/inventory-commands")', 'require("./lib/inventory-commands")'],
    ['require("../dist/lib/deploy")', 'require("./lib/deploy")'],
    ['require("../dist/lib/services-command")', 'require("./lib/services-command")'],
    ['require("../dist/lib/uninstall-command")', 'require("./lib/uninstall-command")'],
  ],
};

function parseArgs(argv: string[]): Options {
  let base = "origin/main";
  let write = false;
  let strict = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--base") {
      base = argv[index + 1] || base;
      index += 1;
      continue;
    }
    if (arg === "--write") {
      write = true;
      continue;
    }
    if (arg === "--dry-run") {
      write = false;
      continue;
    }
    if (arg === "--strict") {
      strict = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { base, write, strict };
}

function printHelp() {
  console.log(
    `Usage: npm run ts-migration:assist -- --base origin/main [--write|--dry-run] [--strict]\n\nPorts stale branch edits from migrated legacy JS paths to their canonical TS files.`,
  );
}

function runGit(args: string[]): string {
  return String(execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" })).trim();
}

function runGitAllowFailure(args: string[]): { ok: boolean; output: string } {
  try {
    return { ok: true, output: runGit(args) };
  } catch (error) {
    return { ok: false, output: String(error) };
  }
}

function normalizeRel(filePath: string): string {
  return path.posix.normalize(filePath.split(path.sep).join(path.posix.sep));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ensureDotSlash(specifier: string): string {
  return specifier.startsWith(".") ? specifier : `./${specifier}`;
}

function withoutTsExtension(filePath: string): string {
  return filePath.replace(/\.ts$/, "");
}

function isWithin(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

function toPosix(filePath: string): string {
  return filePath.split(path.sep).join(path.posix.sep);
}

function replaceAll(text: string, oldValue: string, newValue: string): string {
  return text.split(oldValue).join(newValue);
}

function replaceQuotedPathSegments(text: string, oldRel: string, newRel: string): string {
  const oldSegments = normalizeRel(oldRel).split("/");
  const newSegments = normalizeRel(newRel).split("/");
  if (oldSegments.length === 0 || newSegments.length === 0) {
    return text;
  }

  const pattern = new RegExp(
    `(["'])${escapeRegExp(oldSegments[0])}\\1${oldSegments
      .slice(1)
      .map((segment) => `\\s*,\\s*\\1${escapeRegExp(segment)}\\1`)
      .join("")}`,
    "g",
  );

  return text.replace(pattern, (_match, quote: string) =>
    newSegments.map((segment) => `${quote}${segment}${quote}`).join(", "),
  );
}

function readGitFile(ref: string, relPath: string): string | null {
  const result = runGitAllowFailure(["show", `${ref}:${normalizeRel(relPath)}`]);
  return result.ok ? result.output : null;
}

function getMergeBase(base: string): string {
  return runGit(["merge-base", base, "HEAD"]);
}

function getChangedFilesSince(ref: string): Set<string> {
  const output = runGit(["diff", "--name-only", `${ref}..HEAD`]);
  if (!output) {
    return new Set();
  }
  return new Set(output.split("\n").filter(Boolean).map(normalizeRel));
}

function rewriteNamedExports(content: string): string {
  return content.replace(/module\.exports\s*=\s*\{([\s\S]*?)\};?\s*$/m, "export {$1};\n");
}

function rewriteMovedRuntimeContent(content: string, oldAbs: string, newAbs: string): string {
  const rewrittenRequires = content.replace(
    /(require(?:\.resolve)?\(\s*["'])([^"']+)(["']\s*\))/g,
    (match, prefix: string, specifier: string, suffix: string) => {
      if (!specifier.startsWith(".")) {
        return match;
      }
      const resolved = path.resolve(path.dirname(oldAbs), specifier);
      if (!isWithin(resolved, DIST_ROOT)) {
        return match;
      }
      const relFromDist = path.relative(DIST_ROOT, resolved);
      const srcTarget = path.join(SRC_ROOT, relFromDist);
      const rewritten = toPosix(path.relative(path.dirname(newAbs), srcTarget));
      return `${prefix}${ensureDotSlash(rewritten)}${suffix}`;
    },
  );
  return rewriteNamedExports(rewrittenRequires);
}

function applySpecialRewrites(oldRel: string, content: string): string {
  let updated = content;
  for (const [oldText, newText] of SPECIAL_REWRITES[oldRel] || []) {
    updated = updated.replaceAll(oldText, newText);
  }
  return updated;
}

function transformRuntimeFile(oldRel: string, newRel: string, original: string): string {
  const withoutShebang = original.replace(/^#![^\n]*\n/, "");
  if (oldRel === "bin/lib/onboard.js" || oldRel === "bin/nemoclaw.js") {
    const rewritten = applySpecialRewrites(oldRel, withoutShebang);
    return rewritten.startsWith("// @ts-nocheck") ? rewritten : `${WRAPPER_HEADER}${rewritten}`;
  }
  const oldAbs = path.join(REPO_ROOT, oldRel);
  const newAbs = path.join(REPO_ROOT, newRel);
  const rewritten = rewriteMovedRuntimeContent(withoutShebang, oldAbs, newAbs);
  return rewritten.startsWith("// @ts-nocheck") ? rewritten : `${WRAPPER_HEADER}${rewritten}`;
}

function portRuntimeMove(
  oldRel: string,
  newRel: string,
  changedFiles: Set<string>,
  baseRef: string,
  options: Options,
  manual: string[],
  applied: string[],
) {
  const oldAbs = path.join(REPO_ROOT, oldRel);
  const newAbs = path.join(REPO_ROOT, newRel);
  if (!changedFiles.has(oldRel)) {
    return;
  }
  if (!fs.existsSync(oldAbs)) {
    manual.push(`${oldRel}: expected branch version of legacy file is missing`);
    return;
  }
  if (changedFiles.has(newRel)) {
    manual.push(`${oldRel}: branch already edits canonical path ${newRel}`);
    return;
  }

  const transformed = transformRuntimeFile(oldRel, newRel, fs.readFileSync(oldAbs, "utf8"));
  const baseNew = readGitFile(baseRef, newRel);
  if (baseNew && fs.existsSync(newAbs)) {
    const currentNew = fs.readFileSync(newAbs, "utf8");
    if (currentNew !== baseNew) {
      manual.push(`${oldRel}: working tree already diverged at ${newRel}`);
      return;
    }
  }

  if (options.write) {
    fs.mkdirSync(path.dirname(newAbs), { recursive: true });
    fs.writeFileSync(newAbs, transformed);
    const baseOld = readGitFile(baseRef, oldRel);
    if (baseOld !== null) {
      runGit(["checkout", baseRef, "--", oldRel]);
    } else if (fs.existsSync(oldAbs)) {
      fs.unlinkSync(oldAbs);
    }
  }

  applied.push(`${oldRel} -> ${newRel}`);
}

function portTestRename(
  oldRel: string,
  changedFiles: Set<string>,
  baseRef: string,
  options: Options,
  manual: string[],
  applied: string[],
) {
  if (!oldRel.startsWith("test/") || !oldRel.endsWith(".test.js") || !changedFiles.has(oldRel)) {
    return;
  }
  const newRel = oldRel.replace(/\.js$/, ".ts");
  const oldAbs = path.join(REPO_ROOT, oldRel);
  const newAbs = path.join(REPO_ROOT, newRel);

  if (!fs.existsSync(oldAbs)) {
    manual.push(`${oldRel}: expected branch version of test file is missing`);
    return;
  }
  if (changedFiles.has(newRel)) {
    manual.push(`${oldRel}: branch already edits canonical test path ${newRel}`);
    return;
  }

  const original = fs.readFileSync(oldAbs, "utf8");
  const updated = original.startsWith("// @ts-nocheck") ? original : `${WRAPPER_HEADER}${original}`;

  if (options.write) {
    fs.writeFileSync(newAbs, updated);
    if (readGitFile(baseRef, oldRel) !== null) {
      runGit(["checkout", baseRef, "--", oldRel]);
    } else if (fs.existsSync(oldAbs)) {
      fs.unlinkSync(oldAbs);
    }
  }

  applied.push(`${oldRel} -> ${newRel}`);
}

function rewriteSourceInspectionFiles(
  changedFiles: Set<string>,
  options: Options,
  applied: string[],
) {
  const candidateFiles = Array.from(changedFiles)
    .filter((file) => file.endsWith(".js") || file.endsWith(".ts"))
    .filter((file) => fs.existsSync(path.join(REPO_ROOT, file)));

  for (const candidate of candidateFiles) {
    const absolute = path.join(REPO_ROOT, candidate);
    const original = fs.readFileSync(absolute, "utf8");
    let updated = original;
    for (const [oldRel, newRel] of Object.entries(RUNTIME_MOVES)) {
      updated = replaceAll(updated, normalizeRel(oldRel), normalizeRel(newRel));
      updated = replaceQuotedPathSegments(updated, oldRel, newRel);
    }
    if (updated === original) {
      continue;
    }
    if (options.write) {
      fs.writeFileSync(absolute, updated);
    }
    applied.push(`rewrote source paths in ${candidate}`);
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const mergeBase = getMergeBase(options.base);
  const changedFiles = getChangedFilesSince(mergeBase);
  const applied: string[] = [];
  const manual: string[] = [];

  for (const [oldRel, newRel] of Object.entries(RUNTIME_MOVES)) {
    portRuntimeMove(oldRel, newRel, changedFiles, options.base, options, manual, applied);
  }

  for (const changedFile of Array.from(changedFiles).sort()) {
    portTestRename(changedFile, changedFiles, options.base, options, manual, applied);
  }

  rewriteSourceInspectionFiles(changedFiles, options, applied);

  if (applied.length === 0) {
    console.log("No migrated legacy-path edits detected on this branch.");
  } else {
    console.log(`${options.write ? "Applied" : "Planned"} TS migration assists:`);
    for (const item of applied) {
      console.log(`  - ${item}`);
    }
  }

  if (manual.length > 0) {
    console.log("Manual follow-up needed:");
    for (const item of manual) {
      console.log(`  - ${item}`);
    }
    if (options.strict) {
      process.exit(1);
    }
  }
}

main();
