// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the no-direct-credential-env ESLint rule.
 *
 * Verifies that the rule flags direct process.env reads for known
 * credential keys while allowing assignments, deletions, and
 * non-credential keys.
 *
 * See #2306.
 */

import { describe, expect, it } from "vitest";
import { RuleTester } from "eslint";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Import the CJS rule via dynamic import
const rulePath = path.join(import.meta.dirname, "..", "eslint-rules", "no-direct-credential-env.js");
const rule = (await import(pathToFileURL(rulePath).href)).default;

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

describe("ESLint rule: nemoclaw/no-direct-credential-env", () => {
  it("flags and allows the expected patterns", () => {
    ruleTester.run("no-direct-credential-env", rule, {
      valid: [
        // Assignments (write context) — allowed
        { code: 'process.env.NVIDIA_API_KEY = "test";' },
        { code: 'process.env.OPENAI_API_KEY = value;' },
        { code: "process.env[credentialEnv] = providerKey;" },

        // Deletions (write context) — allowed
        { code: "delete process.env.NVIDIA_API_KEY;" },
        { code: "delete process.env.ANTHROPIC_API_KEY;" },

        // Non-credential env vars — allowed
        { code: "const x = process.env.NEMOCLAW_MODEL;" },
        { code: "const x = process.env.HOME;" },
        { code: "const x = process.env.PATH;" },

        // NEMOCLAW_PROVIDER_KEY is a user-facing override, not credential resolution
        { code: "const x = process.env.NEMOCLAW_PROVIDER_KEY;" },

        // Correct patterns — allowed
        { code: 'const key = getCredential("NVIDIA_API_KEY");' },
        { code: 'const key = resolveProviderCredential("NVIDIA_API_KEY");' },

        // Bracketed string-literal assignments — allowed
        { code: 'process.env["NVIDIA_API_KEY"] = "test";' },

        // Dynamic access with non-credential variable name — allowed
        { code: "const x = process.env[someKey];" },
        { code: "const x = process.env[envName];" },
      ],

      invalid: [
        // Static reads of known credential keys
        {
          code: "const key = process.env.NVIDIA_API_KEY;",
          errors: [{ messageId: "noDirectCredentialEnv" }],
        },
        {
          code: "const key = process.env.OPENAI_API_KEY;",
          errors: [{ messageId: "noDirectCredentialEnv" }],
        },
        {
          code: "const key = process.env.ANTHROPIC_API_KEY;",
          errors: [{ messageId: "noDirectCredentialEnv" }],
        },
        {
          code: "const key = process.env.GEMINI_API_KEY;",
          errors: [{ messageId: "noDirectCredentialEnv" }],
        },
        {
          code: "const key = process.env.COMPATIBLE_API_KEY;",
          errors: [{ messageId: "noDirectCredentialEnv" }],
        },
        {
          code: "const key = process.env.COMPATIBLE_ANTHROPIC_API_KEY;",
          errors: [{ messageId: "noDirectCredentialEnv" }],
        },

        // Conditional check (read context)
        {
          code: "if (!process.env.NVIDIA_API_KEY) {}",
          errors: [{ messageId: "noDirectCredentialEnv" }],
        },

        // Bracketed string-literal reads
        {
          code: 'const key = process.env["NVIDIA_API_KEY"];',
          errors: [{ messageId: "noDirectCredentialEnv" }],
        },
        {
          code: 'if (!process.env["OPENAI_API_KEY"]) {}',
          errors: [{ messageId: "noDirectCredentialEnv" }],
        },

        // Dynamic read with credential-containing variable name
        {
          code: "if (!process.env[credentialEnv]) {}",
          errors: [{ messageId: "noDirectCredentialEnv" }],
        },
        {
          code: "const x = process.env[resolvedCredentialEnv];",
          errors: [{ messageId: "noDirectCredentialEnv" }],
        },
      ],
    });
  });

  it("onboard.ts has zero violations (Phase 1 already fixed all patterns)", async () => {
    const { spawnSync } = await import("node:child_process");
    const repoRoot = path.join(import.meta.dirname, "..");
    const result = spawnSync(
      "npx",
      ["eslint", "src/lib/onboard.ts", "--format", "json"],
      {
        cwd: repoRoot,
        encoding: "utf-8",
        timeout: 30_000,
      },
    );
    const output = JSON.parse(result.stdout);
    const violations = output[0].messages.filter(
      (m: any) => m.ruleId === "nemoclaw/no-direct-credential-env",
    );
    expect(violations).toHaveLength(0);
  });
});
