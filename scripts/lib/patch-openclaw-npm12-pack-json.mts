#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const LEGACY_ENTRIES = "const entries = Array.isArray(parsed) ? parsed : [parsed];";
const NPM12_ENTRIES =
  'const entries = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" && !("name" in parsed) && !("version" in parsed) && !("filename" in parsed) && !("id" in parsed) ? Object.values(parsed) : [parsed]; /* nemoclaw: npm 12 keyed npm pack JSON */';
const NATIVE_ENTRIES = "const entries = resolveNpmJsonEntries(parsed);";
const NATIVE_RESOLVER_IMPORT =
  /import \{ [A-Za-z0-9_$]+ as resolveNpmJsonEntries \} from "\.\/(npm-registry-spec-[A-Za-z0-9_-]+\.js)";/gu;
const NATIVE_RESOLVER_MARKERS = [
  "function resolveNpmJsonEntries(value) {",
  "if (Array.isArray(value)) return value;",
  'if (!(typeof record.id === "string" || typeof record.name === "string" || typeof record.version === "string" || typeof record.filename === "string")) {',
  'const entries = Object.values(record).filter((entry) => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry));',
  "if (entries.length > 0) return entries;",
  "return [value];",
] as const;
const REVIEWED_LAYOUTS = {
  "2026.3.11": {
    expectedFiles: 2,
    filename: /^npm-pack-install-[A-Za-z0-9_-]+\.js$/,
    mode: "patch",
  },
  "2026.4.24": {
    expectedFiles: 1,
    filename: /^install-source-utils-[A-Za-z0-9_-]+\.js$/,
    mode: "patch",
  },
  "2026.7.1": {
    expectedFiles: 1,
    filename: /^install-source-utils-[A-Za-z0-9_-]+\.js$/,
    mode: "patch",
  },
  "2026.9.1": {
    expectedFiles: 1,
    filename: /^install-source-utils-[A-Za-z0-9_-]+\.js$/,
    mode: "native",
  },
} as const;

function occurrences(contents: string, needle: string): number {
  return contents.split(needle).length - 1;
}

export function patchOpenClawNpm12PackJson(
  distDirectory: string,
  openClawVersion: string,
): "already-patched" | "patched" {
  const layout = REVIEWED_LAYOUTS[openClawVersion as keyof typeof REVIEWED_LAYOUTS];
  if (!layout) throw new Error(`OpenClaw ${openClawVersion} has no reviewed npm 12 parser layout`);
  const candidates = fs
    .readdirSync(distDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && layout.filename.test(entry.name))
    .map((entry) => path.join(distDirectory, entry.name));

  if (candidates.length !== layout.expectedFiles) {
    throw new Error(
      `OpenClaw ${openClawVersion} npm pack JSON parser file count is unsupported: expected=${layout.expectedFiles}, found=${candidates.length}`,
    );
  }

  if (layout.mode === "native") {
    const target = candidates[0]!;
    const contents = fs.readFileSync(target, "utf8");
    const imports = [...contents.matchAll(NATIVE_RESOLVER_IMPORT)];
    const nativeEntries = occurrences(contents, NATIVE_ENTRIES);
    if (
      nativeEntries !== 1 ||
      occurrences(contents, LEGACY_ENTRIES) !== 0 ||
      occurrences(contents, NPM12_ENTRIES) !== 0 ||
      imports.length !== 1
    ) {
      throw new Error(
        `OpenClaw ${openClawVersion} native npm pack JSON parser shape is unsupported: native=${nativeEntries}, imports=${imports.length}`,
      );
    }
    const resolver = path.join(distDirectory, imports[0]![1]!);
    const resolverContents = fs.readFileSync(resolver, "utf8");
    const driftedMarkers = NATIVE_RESOLVER_MARKERS.filter(
      (marker) => occurrences(resolverContents, marker) !== 1,
    );
    if (driftedMarkers.length > 0) {
      throw new Error(
        `OpenClaw ${openClawVersion} native npm pack JSON resolver shape is unsupported: drifted=${driftedMarkers.length}`,
      );
    }
    return "already-patched";
  }

  const inspected = candidates.map((file) => ({
    contents: fs.readFileSync(file, "utf8"),
    file,
  }));
  const states = inspected.map(({ contents, file }) => ({
    file,
    legacy: occurrences(contents, LEGACY_ENTRIES),
    patched: occurrences(contents, NPM12_ENTRIES),
  }));
  const legacyMatches = states.flatMap(({ file, legacy }) =>
    Array.from({ length: legacy }, () => file),
  );
  const patchedMatches = states.flatMap(({ file, patched }) =>
    Array.from({ length: patched }, () => file),
  );

  if (states.every(({ legacy, patched }) => legacy === 0 && patched === 1))
    return "already-patched";
  if (!states.every(({ legacy, patched }) => legacy === 1 && patched === 0)) {
    throw new Error(
      `OpenClaw ${openClawVersion} npm pack JSON parser shape is unsupported: legacy=${legacyMatches.length}, patched=${patchedMatches.length}`,
    );
  }

  for (const target of legacyMatches) {
    const contents = fs.readFileSync(target, "utf8");
    const patched = contents.replace(LEGACY_ENTRIES, NPM12_ENTRIES);
    if (occurrences(patched, LEGACY_ENTRIES) !== 0 || occurrences(patched, NPM12_ENTRIES) !== 1)
      throw new Error("OpenClaw npm pack JSON parser patch verification failed");
    fs.writeFileSync(target, patched);
  }
  return "patched";
}

function cli(args: readonly string[]): void {
  if (args.length !== 2)
    throw new Error(
      "usage: patch-openclaw-npm12-pack-json.mts OPENCLAW_DIST_DIRECTORY OPENCLAW_VERSION",
    );
  const result = patchOpenClawNpm12PackJson(path.resolve(args[0]!), args[1]!);
  console.log(`OpenClaw npm 12 pack JSON parser ${result}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    cli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
