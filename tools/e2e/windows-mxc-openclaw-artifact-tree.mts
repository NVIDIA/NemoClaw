// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_ARTIFACT_FILES = 100_000;

export function sha256File(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function sha256WindowsOpenClawArtifactTree(root: string): string {
  const realRoot = fs.realpathSync(root);
  const rootStatus = fs.lstatSync(realRoot);
  if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) {
    throw new Error("OpenClaw artifact root must be a directory, not a link");
  }

  const files: string[] = [];
  const pending = [realRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) break;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      const status = fs.lstatSync(candidate);
      if (status.isSymbolicLink()) {
        throw new Error("OpenClaw artifact tree must not contain links");
      }
      if (status.isDirectory()) pending.push(candidate);
      else if (status.isFile()) files.push(candidate);
      else throw new Error("OpenClaw artifact tree contains an unsupported file type");
      if (files.length > MAX_ARTIFACT_FILES) {
        throw new Error("OpenClaw artifact tree exceeds its file bound");
      }
    }
  }

  files.sort((a, b) => {
    const left = path.relative(realRoot, a).split(path.sep).join("/");
    const right = path.relative(realRoot, b).split(path.sep).join("/");
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const digest = createHash("sha256");
  for (const file of files) {
    const relative = path.relative(realRoot, file).split(path.sep).join("/");
    digest.update(relative, "utf8");
    digest.update("\0", "utf8");
    digest.update(sha256File(file), "utf8");
    digest.update("\n", "utf8");
  }
  return digest.digest("hex");
}

function main(): void {
  const root = process.argv[2];
  if (!root || process.argv.length !== 3) {
    throw new Error("usage: windows-mxc-openclaw-artifact-tree.mts <artifact-root>");
  }
  process.stdout.write(`${sha256WindowsOpenClawArtifactTree(root)}\n`);
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) main();
