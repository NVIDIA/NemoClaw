// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const docsRoot = path.join(repoRoot, "docs");

type FencedBlock = {
  language: string;
  line: number;
  lines: string[];
};

const COPYABLE_LANGUAGES = new Set(["bash", "sh", "powershell", "console", ""]);

function collectFencedBlocks(markdown: string): FencedBlock[] {
  const lines = markdown.split(/\r?\n/);
  const blocks: FencedBlock[] = [];
  let current: FencedBlock | null = null;

  for (const [index, line] of lines.entries()) {
    const fence = line.match(/^```(\S*)\s*$/);
    if (!fence) {
      if (current) current.lines.push(line);
      continue;
    }

    if (current) {
      blocks.push(current);
      current = null;
      continue;
    }

    current = {
      language: fence[1] ?? "",
      line: index + 1,
      lines: [],
    };
  }

  return blocks;
}

function listDocMdxFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "_build" || entry.name === "_components") continue;
      files.push(...listDocMdxFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".mdx")) {
      files.push(fullPath);
    }
  }
  return files;
}

describe("docs copyable command blocks (#4754)", () => {
  it("does not use shell prompt prefixes in copyable fenced code blocks", () => {
    const violations: string[] = [];

    for (const docPath of listDocMdxFiles(docsRoot)) {
      const markdown = fs.readFileSync(docPath, "utf8");
      const blocks = collectFencedBlocks(markdown);
      for (const block of blocks) {
        if (!COPYABLE_LANGUAGES.has(block.language)) continue;
        for (const [offset, line] of block.lines.entries()) {
          if (!/^\s*\$ /.test(line)) continue;
          const lineNumber = block.line + offset + 1;
          violations.push(
            `${path.relative(repoRoot, docPath)}:${lineNumber} [${block.language || "plain"}]: ${line}`,
          );
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
