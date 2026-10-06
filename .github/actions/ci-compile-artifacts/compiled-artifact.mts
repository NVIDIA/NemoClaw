// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function verifyCompiledArtifact(root: string, sha: string): void {
  for (const directory of ["dist", "nemoclaw/dist"]) {
    const walk = (relative: string): void => {
      const info = lstatSync(join(root, relative));
      if (info.isDirectory()) {
        for (const name of readdirSync(join(root, relative))) walk(`${relative}/${name}`);
      } else if (!info.isFile()) {
        throw new Error(`Compiled output contains a link or special file: ${relative}`);
      }
    };
    walk(directory);
  }
  for (const file of [
    "dist/nemoclaw.js",
    "dist/lib/blueprint-runner.js",
    "dist/nemoclaw/blueprint/runner.js",
    "nemoclaw/dist/index.js",
    "nemoclaw/dist/shared/sandbox-name.cjs",
  ]) {
    const info = lstatSync(join(root, file));
    if (!info.isFile() || info.size === 0) throw new Error(`Missing compiled output: ${file}`);
  }
  const identity = JSON.parse(readFileSync(join(root, "dist/build-identity.json"), "utf8"));
  if (identity.sourceRevision !== sha)
    throw new Error("Compiled output does not match the checkout SHA");
}

function main(): void {
  const root = process.env.GITHUB_WORKSPACE;
  if (!root) throw new Error("GITHUB_WORKSPACE is required");
  const sha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Invalid checkout SHA");
  if (process.argv[2] === "verify") {
    verifyCompiledArtifact(root, sha);
    return;
  }
  if (process.argv[2] !== "identity") throw new Error("Expected identity or verify");
  const action = dirname(fileURLToPath(import.meta.url));
  const hash = createHash("sha256");
  for (const file of ["action.yaml", "compiled-artifact.mts", "../ci-install-dependencies.sh"]) {
    hash.update(readFileSync(join(action, file)));
  }
  const recipeSha = execFileSync("git", ["-C", action, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const key = `compiled-v1-${process.env.RUNNER_OS}-${process.env.RUNNER_ARCH}-${process.version}-${recipeSha}-${sha}-${hash.digest("hex")}`;
  appendFileSync(process.env.GITHUB_OUTPUT!, `sha=${sha}\nkey=${key}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
