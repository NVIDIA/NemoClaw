// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

type SourceMap = {
  sources?: unknown;
};

function walkFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const result: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...walkFiles(fullPath));
    } else if (entry.isFile()) {
      result.push(fullPath);
    }
  }
  return result;
}

function isExternalSource(source: string): boolean {
  return (
    source.startsWith("node:") ||
    source.startsWith("webpack://") ||
    source.includes("node_modules") ||
    source.startsWith("/")
  );
}

function sourceExists(mapPath: string, source: string): boolean {
  if (isExternalSource(source)) return true;
  const resolved = path.resolve(path.dirname(mapPath), source);
  return fs.existsSync(resolved);
}

function readSourceMap(mapPath: string): SourceMap | null {
  try {
    return JSON.parse(fs.readFileSync(mapPath, "utf-8")) as SourceMap;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${mapPath}: invalid JSON source map (${message})`);
  }
}

export function findMissingDistSourcemapSources(distDir: string): string[] {
  const missing: string[] = [];
  for (const mapPath of walkFiles(distDir).filter((file) => file.endsWith(".js.map"))) {
    const sourceMap = readSourceMap(mapPath);
    const sources = Array.isArray(sourceMap?.sources) ? sourceMap.sources : [];
    for (const source of sources) {
      if (typeof source !== "string") continue;
      if (!sourceExists(mapPath, source)) {
        missing.push(`${mapPath} -> ${source}`);
      }
    }
  }
  return missing;
}

function main(): void {
  const distDir = process.argv[2] ?? "dist";
  const missing = findMissingDistSourcemapSources(distDir);
  if (missing.length === 0) {
    console.log(`All JavaScript sourcemaps in ${distDir} reference existing sources.`);
    return;
  }
  console.error(`Stale JavaScript sourcemap sources found in ${distDir}:`);
  for (const entry of missing) {
    console.error(`  ${entry}`);
  }
  console.error("Rebuild from a clean dist directory before running coverage.");
  process.exit(1);
}

if (require.main === module) {
  main();
}
