// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { scanForSecrets, isMemoryPath } from "./secret-scanner.js";

// Test fixtures use synthetic values that look like real secrets but are not.
// Assembled at runtime to avoid triggering gitleaks/detect-private-key hooks.
const FAKE = {
  nvidia: "nvapi-" + "abcdefghijklmnopqrstuvwxyz",
  openai: "sk-" + "abc123def456ghi789jkl012mno",
  github: "ghp_" + "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn",
  aws: "AKIA" + "IOSFODNN7EXAMPLE",
  slack: "xoxb-" + "123456789-abcdefghij",
  npm: "npm_" + "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn",
  pemRsa: "-----BEGIN RSA " + "PRIVATE KEY-----\nMIIEpA...",
  pemOpenssh: "-----BEGIN OPENSSH " + "PRIVATE KEY-----\nb3Blbn...",
  telegram: "123456789:" + "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi",
  google: "AIza" + "SyA-1234567890abcdefghijklmnopqrstu",
  anthropic: "sk-ant-" + "api03-abcdefghijklmnopqrstuv",
  huggingface: "hf_" + "ABCDEFGHIJKLMNOPQRSTUVWXYZab",
  discord: "ABCDEFGHIJKLMNOPQRSTUVWx" + ".abc123" + ".ABCDEFGHIJKLMNOPQRSTUVWXYZa",
  awsSecret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  authHeader:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" +
    ".eyJzdWIiOiIxMjM0NTY3ODkwIn0.TJVA95OrM7E2cBab30RMHrHDcEfxjoYZgeFONFh7HgQ",
};

describe("scanForSecrets", () => {
  describe("detects known secret patterns", () => {
    it("NVIDIA API key", () => {
      const matches = scanForSecrets(`my key is ${FAKE.nvidia}`);
      expect(matches).toHaveLength(1);
      expect(matches[0].pattern).toBe("NVIDIA API key");
    });

    it("OpenAI API key", () => {
      const matches = scanForSecrets(`export OPENAI_API_KEY=${FAKE.openai}`);
      expect(matches).toHaveLength(1);
      expect(matches[0].pattern).toBe("OpenAI API key");
    });

    it("GitHub personal access token", () => {
      const matches = scanForSecrets(`token: ${FAKE.github}`);
      expect(matches).toHaveLength(1);
      expect(matches[0].pattern).toBe("GitHub token");
    });

    it("AWS access key", () => {
      const matches = scanForSecrets(`aws_access_key_id = ${FAKE.aws}`);
      expect(matches).toHaveLength(1);
      expect(matches[0].pattern).toBe("AWS access key");
    });

    it("Slack bot token", () => {
      const matches = scanForSecrets(`SLACK_TOKEN=${FAKE.slack}`);
      expect(matches).toHaveLength(1);
      expect(matches[0].pattern).toBe("Slack token");
    });

    it("npm token", () => {
      const matches = scanForSecrets(`//registry.npmjs.org/:_authToken=${FAKE.npm}`);
      expect(matches).toHaveLength(1);
      expect(matches[0].pattern).toBe("npm token");
    });

    it("private key (PEM RSA)", () => {
      const matches = scanForSecrets(FAKE.pemRsa);
      expect(matches).toHaveLength(1);
      expect(matches[0].pattern).toBe("Private key");
    });

    it("private key (OpenSSH)", () => {
      const matches = scanForSecrets(FAKE.pemOpenssh);
      expect(matches).toHaveLength(1);
      expect(matches[0].pattern).toBe("Private key");
    });

    it("Telegram bot token", () => {
      const matches = scanForSecrets(`bot token: ${FAKE.telegram}`);
      expect(matches).toHaveLength(1);
      expect(matches[0].pattern).toBe("Telegram bot token");
    });

    it("Google API key", () => {
      const matches = scanForSecrets(`GOOGLE_API_KEY=${FAKE.google}`);
      expect(matches).toHaveLength(1);
      expect(matches[0].pattern).toBe("Google API key");
    });

    it("Anthropic API key", () => {
      const matches = scanForSecrets(`key: ${FAKE.anthropic}`);
      expect(matches).toHaveLength(1);
      expect(matches[0].pattern).toBe("Anthropic API key");
    });

    it("HuggingFace token", () => {
      const matches = scanForSecrets(`HF_TOKEN=${FAKE.huggingface}`);
      expect(matches).toHaveLength(1);
      expect(matches[0].pattern).toBe("HuggingFace token");
    });

    it("Discord bot token", () => {
      const matches = scanForSecrets(`DISCORD_TOKEN=${FAKE.discord}`);
      expect(matches).toHaveLength(1);
      expect(matches[0].pattern).toBe("Discord bot token");
    });

    it("AWS secret key", () => {
      const matches = scanForSecrets(`aws_secret_access_key = ${FAKE.awsSecret}`);
      expect(matches).toHaveLength(1);
      expect(matches[0].pattern).toBe("AWS secret key");
    });

    it("Authorization header", () => {
      const matches = scanForSecrets(`Authorization: Bearer ${FAKE.authHeader}`);
      expect(matches).toHaveLength(1);
      expect(matches[0].pattern).toBe("Authorization header");
    });
  });

  describe("does not false-positive on safe content", () => {
    it("normal markdown text", () => {
      expect(scanForSecrets("# My Project\n\nThis is a regular markdown file.")).toHaveLength(0);
    });

    it("code blocks without secrets", () => {
      expect(scanForSecrets("```python\nprint('hello world')\n```")).toHaveLength(0);
    });

    it("short tokens that don't meet minimum length", () => {
      expect(scanForSecrets("sk-short")).toHaveLength(0);
    });

    it("URLs with path segments", () => {
      expect(scanForSecrets("https://github.com/NVIDIA/NemoClaw/pull/1121")).toHaveLength(0);
    });

    it("UUIDs", () => {
      expect(scanForSecrets("id: 550e8400-e29b-41d4-a716-446655440000")).toHaveLength(0);
    });

    it("git commit hashes", () => {
      expect(scanForSecrets("commit 24a8b5a3f1e2d3c4b5a6f7e8d9c0b1a2")).toHaveLength(0);
    });
  });

  describe("redaction", () => {
    it("redacts long values showing first 4 and last 4 chars", () => {
      const matches = scanForSecrets(FAKE.nvidia);
      expect(matches[0].redacted).toBe("nvap..wxyz");
    });
  });

  describe("multiple secrets in one content", () => {
    it("detects multiple different secrets", () => {
      const content = `NVIDIA_API_KEY=${FAKE.nvidia}\nOPENAI_KEY=${FAKE.openai}`;
      const matches = scanForSecrets(content);
      expect(matches.length).toBeGreaterThanOrEqual(2);
    });

    it("counts multiple occurrences of the same pattern", () => {
      const key1 = "nvapi-" + "aaaabbbbccccddddeeeefffff";
      const key2 = "nvapi-" + "xxxxyyyyzzzzwwwwvvvvuuuuu";
      const content = `first: ${key1}\nsecond: ${key2}`;
      const matches = scanForSecrets(content);
      const nvidiaMatches = matches.filter((m) => m.pattern === "NVIDIA API key");
      expect(nvidiaMatches).toHaveLength(2);
    });

    it("deduplicates identical values", () => {
      const content = `key: ${FAKE.nvidia}\nrepeat: ${FAKE.nvidia}`;
      const matches = scanForSecrets(content);
      const nvidiaMatches = matches.filter((m) => m.pattern === "NVIDIA API key");
      expect(nvidiaMatches).toHaveLength(1);
    });
  });

  describe("pattern overlap", () => {
    it("Anthropic key is not double-matched as OpenAI", () => {
      const matches = scanForSecrets(`key: ${FAKE.anthropic}`);
      expect(matches).toHaveLength(1);
      expect(matches[0].pattern).toBe("Anthropic API key");
    });
  });
});

describe("isMemoryPath", () => {
  it("matches .openclaw/memory/ paths", () => {
    expect(isMemoryPath("/sandbox/.openclaw/memory/project.md")).toBe(true);
    expect(isMemoryPath("/sandbox/.openclaw/memory/notes.md")).toBe(true);
  });

  it("matches MEMORY.md anchored to .openclaw", () => {
    expect(isMemoryPath("/sandbox/.openclaw/MEMORY.md")).toBe(true);
  });

  it("matches OpenClaw runtime config", () => {
    expect(isMemoryPath("/sandbox/.openclaw/openclaw.json")).toBe(true);
  });

  it("matches workspace paths", () => {
    expect(isMemoryPath("/sandbox/.openclaw/workspace/notes.md")).toBe(true);
  });

  it("matches agents paths", () => {
    expect(isMemoryPath("/sandbox/.openclaw/agents/main/config.json")).toBe(true);
  });

  it("matches skills paths", () => {
    expect(isMemoryPath("/sandbox/.openclaw/skills/custom/handler.ts")).toBe(true);
  });

  it("matches hooks paths", () => {
    expect(isMemoryPath("/sandbox/.openclaw/hooks/my-hook/handler.ts")).toBe(true);
  });

  it("matches credentials paths", () => {
    expect(isMemoryPath("/sandbox/.openclaw/credentials/auth.json")).toBe(true);
  });

  it("matches canvas paths", () => {
    expect(isMemoryPath("/sandbox/.openclaw/canvas/drawing.json")).toBe(true);
  });

  it("matches identity paths", () => {
    expect(isMemoryPath("/sandbox/.openclaw/identity/profile.json")).toBe(true);
  });

  it("matches cron paths", () => {
    expect(isMemoryPath("/sandbox/.openclaw/cron/schedule.json")).toBe(true);
  });

  it("matches telegram paths", () => {
    expect(isMemoryPath("/sandbox/.openclaw/telegram/state.json")).toBe(true);
  });

  it("matches sandbox state paths", () => {
    expect(isMemoryPath("/sandbox/.openclaw/sandbox/config.json")).toBe(true);
  });

  it("matches .nemoclaw paths", () => {
    expect(isMemoryPath("/sandbox/.nemoclaw/config.json")).toBe(true);
  });

  it("does not match regular files", () => {
    expect(isMemoryPath("/sandbox/project/src/index.ts")).toBe(false);
  });

  it("does not match tmp files", () => {
    expect(isMemoryPath("/tmp/scratch.md")).toBe(false);
  });

  it("does not match unanchored workspace in project paths", () => {
    expect(isMemoryPath("/sandbox/my-project/workspace/readme.md")).toBe(false);
  });

  it("does not match unanchored MEMORY.md in project paths", () => {
    expect(isMemoryPath("/sandbox/my-project/MEMORY.md")).toBe(false);
  });
});
