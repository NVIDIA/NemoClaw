// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SECRET_PATTERNS, EXPECTED_SHELL_PREFIXES } from "../src/lib/secret-patterns";
import { redact as debugRedact } from "../src/lib/debug";
import { redactSensitiveText } from "../src/lib/onboard-session";
// runner.ts uses CJS exports — import via dist
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { redact: runnerRedact } = require("../dist/lib/runner");

const DEBUG_SH = readFileSync(join(import.meta.dirname, "..", "scripts", "debug.sh"), "utf-8");

const RUNNER_TS = readFileSync(join(import.meta.dirname, "..", "src", "lib", "runner.ts"), "utf-8");

function requireMatch(match: RegExpMatchArray | null): RegExpMatchArray {
  expect(match).toBeTruthy();
  if (!match) {
    throw new Error("Expected regex match to be present");
  }
  return match;
}

const DEBUG_TS = readFileSync(join(import.meta.dirname, "..", "src", "lib", "debug.ts"), "utf-8");

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

  describe("runner.ts imports from the unified redact module (#2381)", () => {
    it("uses the shared module", () => {
      expect(RUNNER_TS).toContain("./redact");
    });
  });

  describe("debug.ts imports from the unified redact module (#2381)", () => {
    it("uses the shared module", () => {
      expect(DEBUG_TS).toContain("./redact");
    });
  });

  describe("debug.sh delegates to node when available (#2381)", () => {
    it("references the compiled redact module", () => {
      expect(DEBUG_SH).toContain("dist/lib/redact.js");
      expect(DEBUG_SH).toContain("redactFull");
    });
  });

  describe("debug.sh sed fallback includes essential prefixes", () => {
    for (const prefix of EXPECTED_SHELL_PREFIXES) {
      it(`includes ${prefix} pattern`, () => {
        expect(DEBUG_SH).toContain(prefix);
      });
    }
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
