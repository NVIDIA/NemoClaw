// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the direct credential env guard.
 *
 * Verifies that the guard flags direct process.env reads for known credential
 * keys while allowing assignments, deletions, suppressions, and non-credential
 * keys.
 *
 * See #2306.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findDirectCredentialEnvReads } from "../scripts/check-direct-credential-env";

describe("direct credential env guard", () => {
  it.each([
    // Assignments (write context) — allowed
    'process.env.NVIDIA_API_KEY = "test";',
    "process.env.OPENAI_API_KEY = value;",
    "process.env[credentialEnv] = providerKey;",

    // Deletions (write context) — allowed
    "delete process.env.NVIDIA_API_KEY;",
    "delete process.env.ANTHROPIC_API_KEY;",

    // Non-credential env vars — allowed
    "const x = process.env.NEMOCLAW_MODEL;",
    "const x = process.env.HOME;",
    "const x = process.env.PATH;",

    // NEMOCLAW_PROVIDER_KEY is a user-facing override, not credential resolution.
    "const x = process.env.NEMOCLAW_PROVIDER_KEY;",

    // Correct patterns — allowed
    'const key = getCredential("NVIDIA_API_KEY");',
    'const key = resolveProviderCredential("NVIDIA_API_KEY");',

    // Bracketed string-literal assignments — allowed
    'process.env["NVIDIA_API_KEY"] = "test";',

    // Dynamic access with non-credential variable name — allowed
    "const x = process.env[someKey];",
    "const x = process.env[envName];",

    // Explicitly suppressed raw-env reads — allowed
    "// check-direct-credential-env-ignore -- raw env check required\nconst key = process.env.NVIDIA_API_KEY;",
    "// no-direct-credential-env -- backward-compatible suppression\nconst key = process.env.NVIDIA_API_KEY;",
  ])("allows %s", (code) => {
    expect(findDirectCredentialEnvReads(code)).toEqual([]);
  });

  it.each([
    // Static reads of known credential keys
    ["const key = process.env.NVIDIA_API_KEY;", "NVIDIA_API_KEY"],
    ["const key = process.env.OPENAI_API_KEY;", "OPENAI_API_KEY"],
    ["const key = process.env.ANTHROPIC_API_KEY;", "ANTHROPIC_API_KEY"],
    ["const key = process.env.GEMINI_API_KEY;", "GEMINI_API_KEY"],
    ["const key = process.env.COMPATIBLE_API_KEY;", "COMPATIBLE_API_KEY"],
    [
      "const key = process.env.COMPATIBLE_ANTHROPIC_API_KEY;",
      "COMPATIBLE_ANTHROPIC_API_KEY",
    ],

    // Conditional check (read context)
    ["if (!process.env.NVIDIA_API_KEY) {}", "NVIDIA_API_KEY"],

    // Bracketed string-literal reads
    ['const key = process.env["NVIDIA_API_KEY"];', "NVIDIA_API_KEY"],
    ['if (!process.env["OPENAI_API_KEY"]) {}', "OPENAI_API_KEY"],

    // Dynamic read with credential-containing variable name
    ["if (!process.env[credentialEnv]) {}", "[credentialEnv]"],
    ["const x = process.env[resolvedCredentialEnv];", "[resolvedCredentialEnv]"],

    // Suppression token inside non-comment text must not suppress.
    [
      "const marker = 'no-direct-credential-env';\nconst key = process.env.NVIDIA_API_KEY;",
      "NVIDIA_API_KEY",
    ],
  ])("flags %s", (code, key) => {
    expect(findDirectCredentialEnvReads(code)).toMatchObject([{ key }]);
  });

  it("onboard.ts has zero violations", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const result = spawnSync(
      "npx",
      ["tsx", "scripts/check-direct-credential-env.ts", "src/lib/onboard.ts"],
      {
        cwd: repoRoot,
        encoding: "utf-8",
        timeout: 60_000,
      },
    );

    expect(result.status, result.stderr).toBe(0);
  });
});
