// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const quickstart = readFileSync(
  new URL("../docs/get-started/quickstart.mdx", import.meta.url),
  "utf8",
);

function collectFencedBlocks(markdown: string, language: string): string[] {
  const escapedLanguage = language.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    ...markdown.matchAll(
      new RegExp(`^\\\`\\\`\\\`${escapedLanguage}\\n([\\s\\S]*?)\\n\\\`\\\`\\\`$`, "gm"),
    ),
  ].map((match) => match[1]);
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

    expect(quickstart).toContain("[Choose an Inference Provider](#choose-an-inference-provider)");
    expect(quickstart).not.toContain("provider table above");
    expect(quickstart).not.toContain("provider table below");
    expect(uniqueMatches(quickstart, /\bnemoclaw\s+(my-[a-z0-9-]+)\b/g)).toEqual(["my-gpt-claw"]);
    expect(uniqueMatches(quickstart, /\bSandbox(?: name)?:\s+(my-[a-z0-9-]+)\b/g)).toEqual([
      "my-gpt-claw",
    ]);
  });
});
