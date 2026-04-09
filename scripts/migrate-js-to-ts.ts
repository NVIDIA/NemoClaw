// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

type ShimStrategy = "simple" | "cache-busting" | "cli-launcher";

type Manifest = {
  renameTests?: string[];
  moveRuntime?: Record<string, string>;
  rewriteSourcePaths?: Record<string, string>;
  shimStrategy?: Record<string, ShimStrategy>;
};

type Options = {
  manifestPath: string;
  apply: boolean;
};

const REPO_ROOT = process.cwd();
const DIST_ROOT = path.join(REPO_ROOT, "dist");
const SRC_ROOT = path.join(REPO_ROOT, "src");
const TESTABLE_ROOTS = [path.join(REPO_ROOT, "test"), path.join(REPO_ROOT, "src")];
const WRAPPER_HEADER = [
  "// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.",
  "// SPDX-License-Identifier: Apache-2.0",
].join("\n");

function fail(message: string): never {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function parseArgs(argv: string[]): Options {
  let manifestPath = "";
  let apply = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") {
      apply = true;
      continue;
    }
    if (arg === "--dry-run") {
      apply = false;
      continue;
    }
    if (arg === "--manifest") {
      manifestPath = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    fail(`unknown argument: ${arg}`);
  }

  if (!manifestPath) {
    fail("missing --manifest <file>");
  }

  return {
    manifestPath: path.resolve(REPO_ROOT, manifestPath),
    apply,
  };
}

function printHelp() {
  console.log(
    `Usage: npm run migrate:js-to-ts -- --manifest <file> [--apply|--dry-run]\n\nMechanical JS→TS migration helper for stacked PRs.`,
  );
}

function loadManifest(manifestPath: string): Manifest {
  if (!fs.existsSync(manifestPath)) {
    fail(`manifest not found: ${path.relative(REPO_ROOT, manifestPath)}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Manifest;
  const allowedKeys = new Set(["renameTests", "moveRuntime", "rewriteSourcePaths", "shimStrategy"]);
  for (const key of Object.keys(manifest)) {
    if (!allowedKeys.has(key)) {
      fail(`unsupported manifest key '${key}' in ${path.relative(REPO_ROOT, manifestPath)}`);
    }
  }
  return manifest;
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
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function toPosix(filePath: string): string {
  return filePath.split(path.sep).join(path.posix.sep);
}

function listCandidateRewriteFiles(): string[] {
  const files: string[] = [];
  for (const root of TESTABLE_ROOTS) {
    if (!fs.existsSync(root)) {
      continue;
    }
    walk(root, (entry) => {
      if (entry.endsWith(".js") || entry.endsWith(".ts")) {
        files.push(entry);
      }
    });
  }
  return files.sort();
}

function walk(root: string, visitor: (entry: string) => void) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, visitor);
    } else {
      visitor(fullPath);
    }
  }
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

function rewriteSourceInspectionPaths(oldRel: string, newRel: string, apply: boolean) {
  const candidates = listCandidateRewriteFiles();
  for (const candidate of candidates) {
    const original = fs.readFileSync(candidate, "utf8");
    let updated = replaceAll(original, normalizeRel(oldRel), normalizeRel(newRel));
    updated = replaceQuotedPathSegments(updated, oldRel, newRel);
    if (updated === original) {
      continue;
    }
    const rel = path.relative(REPO_ROOT, candidate);
    if (!apply) {
      console.log(`rewrite source path in ${rel}: ${oldRel} -> ${newRel}`);
      continue;
    }
    fs.writeFileSync(candidate, updated);
    console.log(`rewrote source path in ${rel}: ${oldRel} -> ${newRel}`);
  }
}

function distSpecifierFor(oldRel: string, newRel: string): string {
  const absoluteNew = path.join(REPO_ROOT, newRel);
  const absoluteOld = path.join(REPO_ROOT, oldRel);
  if (!isWithin(absoluteNew, SRC_ROOT)) {
    fail(`runtime target must live under src/: ${newRel}`);
  }
  const distNoExt = withoutTsExtension(path.join(DIST_ROOT, path.relative(SRC_ROOT, absoluteNew)));
  const relative = toPosix(path.relative(path.dirname(absoluteOld), distNoExt));
  return ensureDotSlash(relative);
}

function buildWrapper(oldRel: string, newRel: string, strategy: ShimStrategy): string {
  const distSpecifier = distSpecifierFor(oldRel, newRel);
  switch (strategy) {
    case "simple":
      return `${WRAPPER_HEADER}\n\nmodule.exports = require(${JSON.stringify(distSpecifier)});\n`;
    case "cache-busting":
      return `${WRAPPER_HEADER}\n\nconst distPath = require.resolve(${JSON.stringify(distSpecifier)});\ndelete require.cache[distPath];\nmodule.exports = require(distPath);\n`;
    case "cli-launcher":
      return `#!/usr/bin/env node\n${WRAPPER_HEADER}\n\nrequire(${JSON.stringify(distSpecifier)});\n`;
    default: {
      const exhaustiveCheck: never = strategy;
      fail(`unsupported shim strategy '${String(exhaustiveCheck)}' for ${oldRel}`);
    }
  }
}

function rewriteMovedRuntimeContent(content: string, oldAbs: string, newAbs: string): string {
  return content.replace(
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
}

function renameTest(oldRel: string, apply: boolean) {
  if (!oldRel.endsWith(".js")) {
    fail(`renameTests entries must end with .js: ${oldRel}`);
  }
  const newRel = oldRel.replace(/\.js$/, ".ts");
  const oldAbs = path.join(REPO_ROOT, oldRel);
  const newAbs = path.join(REPO_ROOT, newRel);
  if (!fs.existsSync(oldAbs)) {
    fail(`test file not found: ${oldRel}`);
  }
  if (fs.existsSync(newAbs)) {
    fail(`destination already exists: ${newRel}`);
  }
  const original = fs.readFileSync(oldAbs, "utf8");
  const updated = original.startsWith("// @ts-nocheck") ? original : `// @ts-nocheck\n${original}`;
  if (!apply) {
    console.log(`rename test: ${oldRel} -> ${newRel}`);
    return;
  }
  fs.writeFileSync(newAbs, updated);
  fs.unlinkSync(oldAbs);
  console.log(`renamed test: ${oldRel} -> ${newRel}`);
}

function moveRuntime(oldRel: string, newRel: string, strategy: ShimStrategy, apply: boolean) {
  const oldAbs = path.join(REPO_ROOT, oldRel);
  const newAbs = path.join(REPO_ROOT, newRel);
  if (!fs.existsSync(oldAbs)) {
    fail(`runtime file not found: ${oldRel}`);
  }
  if (fs.existsSync(newAbs)) {
    fail(`destination already exists: ${newRel}`);
  }
  if (!oldRel.endsWith(".js") || !newRel.endsWith(".ts")) {
    fail(`moveRuntime entries must be .js -> .ts: ${oldRel} -> ${newRel}`);
  }

  const original = fs.readFileSync(oldAbs, "utf8");
  const withoutShebang = original.replace(/^#![^\n]*\n/, "");
  const rewritten = rewriteMovedRuntimeContent(withoutShebang, oldAbs, newAbs);
  const withNoCheck = rewritten.startsWith("// @ts-nocheck")
    ? rewritten
    : `// @ts-nocheck\n${rewritten}`;
  const wrapper = buildWrapper(oldRel, newRel, strategy);

  if (!apply) {
    console.log(`move runtime: ${oldRel} -> ${newRel} (${strategy})`);
    return;
  }

  fs.mkdirSync(path.dirname(newAbs), { recursive: true });
  fs.writeFileSync(newAbs, withNoCheck);
  fs.writeFileSync(oldAbs, wrapper);
  if (strategy === "cli-launcher") {
    fs.chmodSync(oldAbs, 0o755);
  }
  console.log(`moved runtime: ${oldRel} -> ${newRel} (${strategy})`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifest = loadManifest(options.manifestPath);
  const manifestRel = path.relative(REPO_ROOT, options.manifestPath);
  console.log(`${options.apply ? "Applying" : "Planning"} migration manifest ${manifestRel}`);

  for (const testFile of manifest.renameTests || []) {
    renameTest(normalizeRel(testFile), options.apply);
  }

  for (const [oldRel, newRel] of Object.entries(manifest.moveRuntime || {})) {
    const strategy = manifest.shimStrategy?.[oldRel] || "simple";
    moveRuntime(normalizeRel(oldRel), normalizeRel(newRel), strategy, options.apply);
  }

  for (const [oldRel, newRel] of Object.entries(manifest.rewriteSourcePaths || {})) {
    rewriteSourceInspectionPaths(normalizeRel(oldRel), normalizeRel(newRel), options.apply);
  }

  if (!options.apply) {
    console.log("Dry run complete. Re-run with --apply to write changes.");
  }
}

main();
