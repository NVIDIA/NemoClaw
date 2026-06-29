// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import path from "node:path";

export class ArtifactSink {
  readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
  }

  async ensureRoot(): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
  }

  pathFor(relativePath: string): string {
    if (!relativePath || path.isAbsolute(relativePath)) {
      throw new Error(`artifact path must be relative: ${relativePath}`);
    }
    const resolved = path.resolve(this.rootDir, relativePath);
    if (resolved !== this.rootDir && !resolved.startsWith(`${this.rootDir}${path.sep}`)) {
      throw new Error(`artifact path escapes root: ${relativePath}`);
    }
    return resolved;
  }

  async writeText(relativePath: string, text: string): Promise<string> {
    const target = this.pathFor(relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, text, "utf8");
    return target;
  }

  async writeJson(relativePath: string, value: unknown): Promise<string> {
    return this.writeText(relativePath, `${JSON.stringify(value, null, 2)}\n`);
  }
}

export function slugifyArtifactName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "unnamed-test";
}

export function createArtifactSink(testName: string, rootDir = process.cwd()): ArtifactSink {
  const baseDir = process.env.E2E_ARTIFACT_DIR ?? path.join(rootDir, ".e2e", "vitest");
  return new ArtifactSink(path.join(baseDir, slugifyArtifactName(testName)));
}
