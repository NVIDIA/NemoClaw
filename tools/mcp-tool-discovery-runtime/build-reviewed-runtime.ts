// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { build } from "esbuild";

const packageRoot = import.meta.dirname;
const repoRoot = path.resolve(packageRoot, "../..");
const reviewedRoot = path.join(packageRoot, "reviewed-runtime-bundle");
const checkOnly = process.argv.slice(2).includes("--check");
const unexpectedArguments = process.argv.slice(2).filter((argument) => argument !== "--check");
if (unexpectedArguments.length > 0) {
  throw new Error(`unexpected reviewed runtime build arguments: ${unexpectedArguments.join(" ")}`);
}

const outputRoot = checkOnly
  ? fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-reviewed-runtime-"))
  : reviewedRoot;
const mcpOutput = path.join(outputRoot, "mcp-tool-discovery");

if (!checkOnly) fs.rmSync(reviewedRoot, { force: true, recursive: true });
process.env.NEMOCLAW_MCP_BUNDLE_OUTPUT_DIR = mcpOutput;
process.env.NEMOCLAW_MCP_BUNDLE_FILENAME = "mcp-tool-discovery.bundle";
process.env.NEMOCLAW_MCP_REVIEWED_ARTIFACT = "1";

try {
  await import("./build-runtime.ts");
  await build({
    absWorkingDir: repoRoot,
    entryPoints: ["src/lib/onboard/managed-bootstrap/image-runtime.ts"],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    legalComments: "eof",
    minifyWhitespace: true,
    outfile: path.join(outputRoot, "managed-startup-image-runtime.bundle"),
  });
  for (const relativePath of [
    "mcp-tool-discovery/mcp-tool-discovery.bundle",
    "managed-startup-image-runtime.bundle",
  ]) {
    const bundlePath = path.join(outputRoot, relativePath);
    const normalizedBundle = fs.readFileSync(bundlePath, "utf8").replace(/[ \t]+$/gmu, "");
    fs.writeFileSync(bundlePath, normalizedBundle, "utf8");
  }

  if (checkOnly) {
    const listFiles = (root: string): string[] =>
      fs
        .readdirSync(root, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
        .sort();
    const expectedFiles = listFiles(reviewedRoot);
    const actualFiles = listFiles(outputRoot);
    if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
      throw new Error(
        `reviewed runtime bundle file set is stale: expected ${JSON.stringify(expectedFiles)}, generated ${JSON.stringify(actualFiles)}`,
      );
    }
    for (const relativePath of expectedFiles) {
      const expected = fs.readFileSync(path.join(reviewedRoot, relativePath));
      const actual = fs.readFileSync(path.join(outputRoot, relativePath));
      if (!actual.equals(expected)) {
        throw new Error(`reviewed runtime bundle is stale: ${relativePath}`);
      }
    }
  }
} finally {
  if (checkOnly) fs.rmSync(outputRoot, { force: true, recursive: true });
}
