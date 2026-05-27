// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const dgxLocalInferenceDoc = path.join(
  repoRoot,
  "docs",
  "inference",
  "dgx-spark-station-local-inference.mdx",
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

describe("DGX local inference docs copyable commands", () => {
  it("uses bash command blocks without prompt prefixes", () => {
    const markdown = fs.readFileSync(dgxLocalInferenceDoc, "utf8");
    const blocks = collectFencedBlocks(markdown);
    const promptLines = blocks.flatMap((block) =>
      block.lines
        .map((line, offset) => ({ line, lineNumber: block.line + offset + 1 }))
        .filter(({ line }) => /^\s*\$ /.test(line))
        .map(
          ({ line, lineNumber }) =>
            `${path.relative(repoRoot, dgxLocalInferenceDoc)}:${lineNumber}: ${line}`,
        ),
    );
    const languages = new Set(blocks.map((block) => block.language));

    expect(promptLines).toEqual([]);
    expect(languages).toEqual(new Set(["bash"]));
  });
});
