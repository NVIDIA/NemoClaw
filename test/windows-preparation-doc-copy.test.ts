// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const windowsPreparationDoc = path.join(repoRoot, "docs", "get-started", "windows-preparation.mdx");
const contributingDoc = path.join(repoRoot, "docs", "CONTRIBUTING.md");
const codeRabbitConfig = path.join(repoRoot, ".coderabbit.yaml");
const contributorUpdateDocsSkill = path.join(
  repoRoot,
  ".agents",
  "skills",
  "nemoclaw-contributor-update-docs",
  "SKILL.md",
);

type FencedBlock = {
  language: string;
  line: number;
  lines: string[];
};

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

describe("Windows preparation docs copyable commands", () => {
  it("uses language-specific command blocks without prompt prefixes", () => {
    const markdown = fs.readFileSync(windowsPreparationDoc, "utf8");
    const blocks = collectFencedBlocks(markdown);
    const promptLines = blocks.flatMap((block) =>
      block.lines
        .map((line, offset) => ({ line, lineNumber: block.line + offset + 1 }))
        .filter(({ line }) => /^\s*\$ /.test(line))
        .map(
          ({ line, lineNumber }) =>
            `${path.relative(repoRoot, windowsPreparationDoc)}:${lineNumber}: ${line}`,
        ),
    );
    const languages = new Set(blocks.map((block) => block.language));

    expect(promptLines).toEqual([]);
    expect(languages.has("powershell")).toBe(true);
    expect(languages.has("bash")).toBe(true);
  });

  it("keeps docs style guidance aligned with copyable command blocks", () => {
    const styleSources = [contributingDoc, codeRabbitConfig, contributorUpdateDocsSkill];
    const oldGuidance = [
      /CLI code blocks must use the `console` language tag with `\$` prompt/,
      /Code examples use `console` language\*\* with `\$` prompt prefix/,
      /Use code blocks with the `console` language for CLI examples\. Prefix commands with `\$`/,
    ];

    for (const source of styleSources) {
      const content = fs.readFileSync(source, "utf8");
      for (const pattern of oldGuidance) {
        expect(
          content,
          `${path.relative(repoRoot, source)} still contains old prompt-prefix guidance`,
        ).not.toMatch(pattern);
      }
    }
  });
});
