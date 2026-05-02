// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { SECRET_PATTERNS } from "../src/lib/secret-patterns";
import { redact as debugRedact } from "../src/lib/debug";
import { redactSensitiveText } from "../src/lib/onboard-session";
// runner.ts uses CJS exports — import via dist
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { redact: runnerRedact } = require("../dist/lib/runner");

describe("secret redaction consistency (#1736)", () => {
  // Tokens whose prefix is a literal string that must appear in debug.sh.
  const LITERAL_PREFIX_TOKENS = [
    { name: "NVIDIA API key", token: "nvapi-" + "a".repeat(30) },
    { name: "NVIDIA Cloud Functions", token: "nvcf-" + "b".repeat(30) },
    { name: "GitHub PAT (classic)", token: "ghp_" + "c".repeat(36) },
    {
      name: "GitHub PAT (fine-grained)",
      token: "github_pat_" + "d".repeat(50),
    },
  ];

  // Tokens added for messaging integrations (#2336). debug.sh uses
  // character-class regexes for these, so the prefix-containment sub-test
  // does not apply — they are covered by the runner/debug TS blocks and
  // by the EXPECTED_SHELL_PREFIXES substring check (xox) where applicable.
  const MESSAGING_TOKENS = [
    { name: "Slack bot token", token: "xoxb-" + "1".repeat(12) + "-" + "e".repeat(24) },
    { name: "Slack app token", token: "xapp-" + "1".repeat(12) + "-" + "f".repeat(24) },
    { name: "Telegram bot token", token: "1234567890:" + "A".repeat(35) },
    {
      name: "Discord bot token",
      token: "g".repeat(24) + "." + "h".repeat(6) + "." + "i".repeat(27),
    },
  ];

  const TEST_TOKENS = [...LITERAL_PREFIX_TOKENS, ...MESSAGING_TOKENS];

  describe("runner.ts redacts all token types", () => {
    for (const { name, token } of TEST_TOKENS) {
      it(`redacts ${name}`, () => {
        const text = runnerRedact(`error: authentication failed with ${token}`);
        expect(text).not.toContain(token);
      });
    }
  });

  describe("debug.ts redacts all token types", () => {
    for (const { name, token } of TEST_TOKENS) {
      it(`redacts ${name}`, () => {
        const text = debugRedact(`error: authentication failed with ${token}`);
        expect(text).not.toContain(token);
      });
    }
  });

  describe("redactor consistency (#2381)", () => {
    it("runner and debug redactors both mask shared token patterns", () => {
      const text = "provider failed with NVIDIA_API_KEY=nvapi-" + "a".repeat(30);
      expect(runnerRedact(text)).not.toContain("nvapi-");
      expect(debugRedact(text)).not.toContain("nvapi-");
    });
  });

  describe("debug.sh delegates to node when available (#2381)", () => {
    it("redacts diagnostic command output with the compiled redactor", () => {
      const tmp = mkdtempSync(join(tmpdir(), "nemoclaw-debug-redact-"));
      const fakeBin = join(tmp, "bin");
      mkdirSync(fakeBin);
      writeFileSync(
        join(fakeBin, "date"),
        "#!/bin/sh\necho NVIDIA_API_KEY=nvapi-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
        { mode: 0o755 },
      );
      try {
        const result = spawnSync("bash", [join(import.meta.dirname, "..", "scripts", "debug.sh"), "--quick"], {
          encoding: "utf-8",
          env: { ...process.env, TMPDIR: tmp, PATH: `${fakeBin}:${process.env.PATH || ""}` },
          timeout: 30_000,
        });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain("NVIDIA_API_KEY=<REDACTED>");
        expect(result.stdout).not.toContain("nvapi-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }, 40_000);
  });

  describe("debug.sh sed fallback includes essential prefixes", () => {
    it("redacts essential token prefixes when node is unavailable", () => {
      const tmp = mkdtempSync(join(tmpdir(), "nemoclaw-debug-sed-redact-"));
      const fakeBin = join(tmp, "bin");
      mkdirSync(fakeBin);
      for (const name of [
        "cat",
        "dirname",
        "dmesg",
        "free",
        "head",
        "mktemp",
        "ps",
        "pwd",
        "rm",
        "sed",
        "sort",
        "tail",
        "tee",
        "tr",
        "uname",
        "uptime",
      ]) {
        try {
          const target = spawnSync("bash", ["-lc", `command -v ${name}`], {
            encoding: "utf-8",
          }).stdout.trim();
          if (target) symlinkSync(target, join(fakeBin, name));
        } catch {
          /* ignore optional command */
        }
      }
      writeFileSync(
        join(fakeBin, "date"),
        "#!/bin/sh\necho nvapi-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ghp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb sk-cccccccccccccccccccccccc\n",
        { mode: 0o755 },
      );
      try {
        const result = spawnSync("/bin/bash", [join(import.meta.dirname, "..", "scripts", "debug.sh"), "--quick"], {
          encoding: "utf-8",
          env: { ...process.env, TMPDIR: tmp, PATH: fakeBin },
          timeout: 30_000,
        });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain("<REDACTED>");
        expect(result.stdout).not.toContain("nvapi-");
        expect(result.stdout).not.toContain("ghp_");
        expect(result.stdout).not.toContain("sk-cccc");
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  describe("onboard-session redactSensitiveText (#2336)", () => {
    for (const { name, token } of TEST_TOKENS) {
      it(`redacts ${name} from persisted failure messages`, () => {
        const text = redactSensitiveText(`onboard step failed: provider returned ${token}`);
        expect(text).not.toContain(token);
      });
    }

    it("redacts Telegram token embedded in API URL path", () => {
      const token = "1234567890:" + "A".repeat(35);
      const text = redactSensitiveText(
        `Failed to reach https://api.telegram.org/bot${token}/getMe`,
      );
      expect(text).not.toContain(token);
    });

    it("redacts Slack env-var assignments", () => {
      const text = redactSensitiveText("SLACK_BOT_TOKEN=xoxb-notreal SLACK_APP_TOKEN=xapp-notreal");
      expect(text).not.toContain("xoxb-notreal");
      expect(text).not.toContain("xapp-notreal");
    });
  });
});
