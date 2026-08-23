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
  const nonInteractiveOnboardExamples = [
    ...fencedBlocks(readGuide(), "bash"),
    ...fencedBlocks(readGuide(), "yaml"),
  ].filter((block) => block.includes("onboard") && block.includes("--non-interactive"));

  it("includes a non-interactive onboard example", () => {
    expect(nonInteractiveOnboardExamples.length).toBeGreaterThan(0);
  });

  it.each(nonInteractiveOnboardExamples)(
    "keeps non-interactive onboard example %# executable",
    (example) => {
      expect(example).toContain("--name <sandbox>");
      expect(example).toContain("--yes-i-accept-third-party-software");
    },
  );

  it("uses normal onboarding instead of interrupted-session resume", () => {
    expect(readGuide()).not.toContain("--resume");
  });

  it.each([
    "NVIDIA_INFERENCE_API_KEY",
    "SLACK_BOT_TOKEN",
    "SLACK_APP_TOKEN",
    "TELEGRAM_BOT_TOKEN",
    "DISCORD_BOT_TOKEN",
    "BRAVE_API_KEY",
    "TAVILY_API_KEY",
  ])("keeps replacement credential %s out of command text (#6266)", (variable) => {
    const guide = readGuide();
    expect(guide).toMatch(new RegExp(`IFS= read -r -s ${variable}`));
    expect(guide).toMatch(new RegExp(`unset [^\\n]*\\b${variable}\\b`));
    expect(guide).not.toMatch(new RegExp(`${variable}=[^\\s$]`));
  });

  it.each(["SLACK_BOT_TOKEN", "TELEGRAM_BOT_TOKEN", "DISCORD_BOT_TOKEN"])(
    "documents onboarding-managed recreation for %s",
    (credential) => {
      const guide = readGuide();
      const bash = fencedBlocks(guide, "bash");
      const example = bash.find(
        (block) => block.includes(credential) && block.includes("onboard --name <sandbox>"),
      );
      expect(example, credential).toBeDefined();
      expect(example, credential).toContain("--yes-i-accept-third-party-software");
      expect(example, credential).not.toContain("channels add");
      expect(example, credential).not.toContain("rebuild --yes");
    },
  );

  it("documents messaging and web search recreation boundaries", () => {
    const guide = readGuide();
    const bash = fencedBlocks(guide, "bash");
    expect(guide).toContain("WECHAT_BOT_TOKEN");
    expect(guide).toContain("MSTEAMS_APP_PASSWORD");
    expect(guide).toContain("Telegram, Discord, Slack, WeChat, or Microsoft Teams");
    expect(guide).toContain("backs up supported workspace and manifest-declared state");
    expect(guide).toContain("Files outside those state paths are not preserved.");
    expect(guide).toContain("If the recorded channel state changes during rotation");
    expect(guide).toContain("A channel stopped with `channels stop` remains inactive");
    expect(guide).toContain("The sandbox registry stores the credential hash");
    expect(guide).toContain("OpenShell retains the registered credential");
    expect(guide).toContain(
      "Discord and Microsoft Teams require non-empty replacement input but cannot prove upstream credential validity before recreation.",
    );
    expect(guide).toContain("verify a live messaging request after onboarding finishes");
    expect(guide).not.toContain("validates each changed value");
    expect(guide).not.toContain("restores the sandbox");
    expect(guide).toContain(
      "Plan for recreation downtime when automating messaging or web search rotation.",
    );
    expect(guide).not.toContain("rebuild downtime");

    expect(bash.some((block) => block.includes("NEMOCLAW_WEB_SEARCH_PROVIDER"))).toBe(true);
  });

  it.each(
    fencedBlocks(readGuide(), "bash").filter((block) =>
      block.includes("NEMOCLAW_WEB_SEARCH_PROVIDER"),
    ),
  )("uses recreation flags in web search example %#", (example) => {
    expect(example).toContain("--fresh");
    expect(example).toContain("--recreate-sandbox");
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
