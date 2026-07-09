// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const quickstart = readFileSync(
  new URL("../docs/get-started/quickstart.mdx", import.meta.url),
  "utf8",
);

function collectFencedBlocks(markdown: string, language: string): string[] {
  const blocks: string[] = [];
  const lines = markdown.split(/\r?\n/);
  let current: string[] | null = null;
  let currentLanguage = "";

  for (const line of lines) {
    const fenceStart = line.match(/^```([A-Za-z0-9_-]*)\s*$/);
    if (!current && fenceStart) {
      current = [];
      currentLanguage = fenceStart[1] ?? "";
      continue;
    }

    if (current && line === "```") {
      if (currentLanguage === language) {
        blocks.push(current.join("\n"));
      }
      current = null;
      currentLanguage = "";
      continue;
    }

    current?.push(line);
  }

  return blocks;
}

function uniqueMatches(source: string, pattern: RegExp): string[] {
  return [...new Set([...source.matchAll(pattern)].map((match) => match[1]))];
}

describe("OpenClaw quickstart docs", () => {
  it("keeps the non-interactive install block complete and sandbox examples aligned (#5631)", () => {
    const nonInteractiveInstall = collectFencedBlocks(quickstart, "bash").find(
      (block) =>
        block.includes("https://www.nvidia.com/nemoclaw.sh") &&
        block.includes("NEMOCLAW_NON_INTERACTIVE=1"),
    );

    expect(nonInteractiveInstall).toBeDefined();
    const installBlock = nonInteractiveInstall ?? "";
    expect(installBlock).toContain("NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1");
    expect(installBlock).toContain("NEMOCLAW_PROVIDER=build");
    expect(installBlock).toContain("NVIDIA_INFERENCE_API_KEY=<your-key>");
    expect(installBlock).toContain("NEMOCLAW_SANDBOX_NAME=my-gpt-claw");

    expect(quickstart).toContain("provider table below");
    expect(quickstart).not.toContain("provider table above");
    expect(uniqueMatches(quickstart, /\bnemoclaw\s+(my-[a-z0-9-]+)\b/g)).toEqual(["my-gpt-claw"]);
    expect(uniqueMatches(quickstart, /\bSandbox(?: name)?:\s+(my-[a-z0-9-]+)\b/g)).toEqual([
      "my-gpt-claw",
    ]);
  });
});
