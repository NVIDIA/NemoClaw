// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import path from "node:path";

import { redactString } from "./redaction.ts";

/**
 * The publication boundary for live E2E evidence.
 *
 * Every text or JSON write is redacted here, including direct writers that do
 * not pass through ShellProbe. The fixture seeds environment-derived secrets;
 * callers can register values generated during a test before persisting them.
 */
export class ArtifactSink {
  readonly rootDir: string;
  private readonly redactionValues = new Set<string>();

  constructor(rootDir: string, redactionValues: Iterable<string> = []) {
    this.rootDir = path.resolve(rootDir);
    this.addRedactionValues(redactionValues);
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

  addRedactionValues(values: Iterable<string>): void {
    for (const value of values) {
      if (value) this.redactionValues.add(value);
    }
  }

  async writeText(relativePath: string, text: string): Promise<string> {
    const target = this.pathFor(relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, redactString(text, this.redactionValues), "utf8");
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

export function createArtifactSink(
  testName: string,
  rootDir = process.cwd(),
  redactionValues: Iterable<string> = [],
): ArtifactSink {
  const baseDir = process.env.E2E_ARTIFACT_DIR ?? path.join(rootDir, ".e2e", "live");
  return new ArtifactSink(path.join(baseDir, slugifyArtifactName(testName)), redactionValues);
}
