// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SECRET_PATTERNS,
  EXPECTED_SHELL_PREFIXES,
} from "../src/lib/secret-patterns";
import { redact as debugRedact } from "../src/lib/debug";
// runner.ts uses CJS exports — import via dist
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { redact: runnerRedact } = require("../dist/lib/runner");

const DEBUG_SH = readFileSync(
  join(import.meta.dirname, "..", "scripts", "debug.sh"),
  "utf-8",
);

const RUNNER_TS = readFileSync(
  join(import.meta.dirname, "..", "src", "lib", "runner.ts"),
  "utf-8",
);

const DEBUG_TS = readFileSync(
  join(import.meta.dirname, "..", "src", "lib", "debug.ts"),
  "utf-8",
);

describe("secret redaction consistency (#1736)", () => {
  // Test tokens that MUST be redacted by all three modules
  const TEST_TOKENS = [
    { name: "NVIDIA API key", token: "nvapi-" + "a".repeat(30) },
    { name: "NVIDIA Cloud Functions", token: "nvcf-" + "b".repeat(30) },
    { name: "GitHub PAT (classic)", token: "ghp_" + "c".repeat(36) },
    {
      name: "GitHub PAT (fine-grained)",
      token: "github_pat_" + "d".repeat(50),
    },
  ];

  describe("runner.ts redacts all token types", () => {
    for (const { name, token } of TEST_TOKENS) {
      it(`redacts ${name}`, () => {
        const text = runnerRedact(
          `error: authentication failed with ${token}`,
        );
        expect(text).not.toContain(token);
      });
    }
  });

  describe("debug.ts redacts all token types", () => {
    for (const { name, token } of TEST_TOKENS) {
      it(`redacts ${name}`, () => {
        const text = debugRedact(
          `error: authentication failed with ${token}`,
        );
        expect(text).not.toContain(token);
      });
    }
  });

  describe("runner.ts imports from secret-patterns.ts", () => {
    it("uses the shared module", () => {
      expect(RUNNER_TS).toContain("secret-patterns");
    });
  });

  describe("debug.ts imports from secret-patterns.ts", () => {
    it("uses the shared module", () => {
      expect(DEBUG_TS).toContain("secret-patterns");
    });
  });

  describe("debug.sh includes all token prefixes", () => {
    for (const prefix of EXPECTED_SHELL_PREFIXES) {
      it(`includes ${prefix} pattern`, () => {
        expect(DEBUG_SH).toContain(prefix);
      });
    }
  });

  describe("debug.sh redact() function handles all token types", () => {
    for (const { name, token } of TEST_TOKENS) {
      it(`redacts ${name}`, () => {
        // Extract the redact function's sed patterns and verify they match
        const redactFn = DEBUG_SH.match(
          /redact\(\) \{[\s\S]*?^\}/m,
        );
        expect(redactFn).toBeTruthy();
        // The token prefix should appear in a sed expression
        const prefix = token.split(/[A-Za-z0-9]{10}/)[0];
        expect(redactFn![0]).toContain(prefix);
      });
    }
  });
});
