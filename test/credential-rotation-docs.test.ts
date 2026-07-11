// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const DOC_PATH = "docs/security/credential-rotation.mdx";

function readGuide(): string {
  return readFileSync(path.join(process.cwd(), DOC_PATH), "utf8");
}

function fencedBlocks(text: string, language: string): string[] {
  const pattern = new RegExp("```" + language + "\\n([\\s\\S]*?)```", "g");
  return [...text.matchAll(pattern)].map((match) => match[1] ?? "");
}

describe("credential rotation documentation", () => {
  it("keeps every non-interactive onboard example executable", () => {
    const examples = [
      ...fencedBlocks(readGuide(), "bash"),
      ...fencedBlocks(readGuide(), "yaml"),
    ].filter((block) => block.includes("onboard") && block.includes("--non-interactive"));

    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) {
      expect(example).toContain("--name <sandbox>");
      expect(example).toContain("--yes-i-accept-third-party-software");
    }
  });

  it("uses normal onboarding instead of interrupted-session resume", () => {
    expect(readGuide()).not.toContain("--resume");
  });

  it("keeps replacement credentials out of command text (#6266)", () => {
    const guide = readGuide();
    const credentialVariables = [
      "NVIDIA_INFERENCE_API_KEY",
      "SLACK_BOT_TOKEN",
      "SLACK_APP_TOKEN",
      "TELEGRAM_BOT_TOKEN",
      "DISCORD_BOT_TOKEN",
      "BRAVE_API_KEY",
      "TAVILY_API_KEY",
    ];

    for (const variable of credentialVariables) {
      expect(guide).toMatch(new RegExp(`IFS= read -r -s ${variable}`));
      expect(guide).toMatch(new RegExp(`unset [^\\n]*\\b${variable}\\b`));
      expect(guide).not.toMatch(new RegExp(`${variable}=[^\\s$]`));
    }
  });

  it("documents messaging rebuilds and web search recreation", () => {
    const guide = readGuide();
    const bash = fencedBlocks(guide, "bash");

    for (const channel of ["slack", "telegram", "discord"]) {
      const example = bash.find((block) => block.includes(`channels add ${channel}`));
      expect(example, channel).toBeDefined();
      expect(example, channel).toContain("rebuild --yes");
    }

    const searchExamples = bash.filter((block) => block.includes("NEMOCLAW_WEB_SEARCH_PROVIDER"));
    expect(searchExamples.length).toBeGreaterThan(0);
    for (const example of searchExamples) {
      expect(example).toContain("--fresh");
      expect(example).toContain("--recreate-sandbox");
    }
  });

  it("uses real provider names and separates configuration checks from live proof", () => {
    const guide = readGuide();

    expect(guide).toContain("credentials reset nvidia-prod --yes");
    expect(guide).toContain("Per-sandbox messaging bridge names are not resettable credentials");
    expect(guide).toContain("Complete a real request through the rotated integration");
    expect(guide).not.toContain("alpha-nvidia-inference");
    expect(guide).not.toContain("alpha-slack");
    expect(guide).not.toContain("PROVIDER_KEY=new-value");
  });

  it("authenticates the Hermes verification request", () => {
    const example = fencedBlocks(readGuide(), "bash").find((block) =>
      block.includes("/v1/chat/completions"),
    );

    expect(example).toBeDefined();
    expect(example).toContain("gateway-token --quiet");
    expect(example).toContain("Authorization: Bearer $TOKEN");
  });
});
