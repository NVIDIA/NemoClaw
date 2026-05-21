// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

export type ParsedArgs = Record<string, string | undefined>;

export type AdvisorArtifactPaths = {
  prompt: string;
  raw: string;
  result: string;
  finalResult: string;
  summary: string;
  sessionHtml: string;
};

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        parsed[key] = undefined;
        continue;
      }
      parsed[key] = next;
      i += 1;
    }
  }
  return parsed;
}

export function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function advisorArtifactPaths(outDir: string, prefix: string): AdvisorArtifactPaths {
  return {
    prompt: path.join(outDir, `${prefix}-prompt.md`),
    raw: path.join(outDir, `${prefix}-raw-output.txt`),
    result: path.join(outDir, `${prefix}-result.json`),
    finalResult: path.join(outDir, `${prefix}-final-result.json`),
    summary: path.join(outDir, `${prefix}-summary.md`),
    sessionHtml: path.join(outDir, `${prefix}-session.html`),
  };
}

export function readJson<T>(relativeOrAbsolutePath: string, root = process.cwd()): T {
  return JSON.parse(fs.readFileSync(path.resolve(root, relativeOrAbsolutePath), "utf8")) as T;
}

export function writeJson(filePath: string, value: unknown): void {
  // lgtm[js/network-data-to-file] Advisor workflows intentionally persist
  // normalized GitHub/advisor metadata as JSON artifacts for maintainer review.
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function readIfExists(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  const resolved = path.resolve(process.cwd(), filePath);
  return fs.existsSync(resolved) ? fs.readFileSync(resolved, "utf8") : undefined;
}

export function readJsonIfExists<T>(filePath: string | undefined): T | undefined {
  const text = readIfExists(filePath);
  return text ? JSON.parse(text) as T : undefined;
}
