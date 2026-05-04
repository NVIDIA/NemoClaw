// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

type RunBlock = { start: number; block: string };

const DOCKERFILE = path.join(import.meta.dirname, "..", "agents", "hermes", "Dockerfile");

function findRunBlock(src: string, predicate: (block: string) => boolean): RunBlock | null {
  const lines = src.split("\n");
  let current: string[] = [];
  let start = -1;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (start === -1) {
      if (/^\s*RUN\b/.test(line)) {
        start = i;
        current = [line];
        if (!/\\\s*$/.test(line)) {
          const block = current.join("\n");
          if (predicate(block)) return { start, block };
          start = -1;
        }
      }
      continue;
    }

    current.push(line);
    if (!/\\\s*$/.test(line)) {
      const block = current.join("\n");
      if (predicate(block)) return { start, block };
      start = -1;
    }
  }

  return null;
}

describe("Hermes Dockerfile TUI Build Chain", () => {
  it("implements the secure build-and-prune sequence before privilege drop", () => {
    const src = fs.readFileSync(DOCKERFILE, "utf-8");
    const lines = src.split("\n");

    // 1. Verify the full chained sequence exists
    // We use a regex that allows for variable whitespace, newlines, and backslashes
    const buildChainRegex = /npm ci --ignore-scripts\s*\\?\s*&&\s*npm run build\s*\\?\s*&&\s*npm prune --omit=dev\s*\\?\s*&&\s*npm cache clean --force/s;
    expect(src).toMatch(buildChainRegex);

    // 2. Verify the sequence occurs BEFORE the privilege drop to 'sandbox' user
    const userSandboxIndex = lines.findIndex((line) => /^\s*USER\s+sandbox\b/.test(line));
    
    // Calculate absolute line position for the USER sandbox command
    let userSandboxLinePos = 0;
    for (let i = 0; i < userSandboxIndex; i++) {
      userSandboxLinePos += lines[i].length + 1;
    }
    // Find the LAST occurrence of 'npm ci --ignore-scripts' before the USER sandbox line
    const matches = Array.from(src.matchAll(/npm ci --ignore-scripts/g));
    const validMatches = matches.filter(m => m.index < userSandboxLinePos);
    
    expect(validMatches.length).toBeGreaterThan(0);
    const tuiBlockIndex = validMatches[validMatches.length - 1].index;
    expect(tuiBlockIndex).toBeLessThan(userSandboxLinePos);
  });
});
