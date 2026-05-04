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

describe("Hermes Dockerfile TUI dependencies", () => {
  it("preinstalls TUI npm deps before dropping privileges", () => {
    const src = fs.readFileSync(DOCKERFILE, "utf-8");
    const lines = src.split("\n");
    const tuiBlock = findRunBlock(src, (block) => block.includes("cd /opt/hermes/ui-tui"));

    expect(tuiBlock).not.toBeNull();
    if (!tuiBlock) return;

    expect(tuiBlock.block).toContain("npm ci --omit=dev --ignore-scripts");
    expect(tuiBlock.block).toContain("npm cache clean --force");

    const userSandboxIndex = lines.findIndex((line) => /^\s*USER\s+sandbox\b/.test(line));
    expect(userSandboxIndex).toBeGreaterThan(-1);
    expect(tuiBlock.start).toBeLessThan(userSandboxIndex);
  });
});
