// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for issue #2273 Layer 1: non-interactive provider selection
 * can stage pre-fix legacy credentials from ~/.nemoclaw/credentials.json.
 *
 * Verifies that the non-interactive code path in setupNim() hydrates
 * provider credentials through the canonical resolver
 * (via hydrateCredentialEnv) before checking process.env.  This preserves
 * rebuild compatibility for users who still have a pre-fix legacy
 * credentials.json while keeping new credential persistence env-only.
 *
 * This test covers all remote providers in REMOTE_PROVIDER_CONFIG.
 *
 * NOTE: This test imports from dist/lib/onboard.js (the compiled CLI
 * output).  If you modify src/lib/onboard.ts, rebuild with
 * `npm run build:cli` before running this test — otherwise it will
 * exercise stale compiled code.  The test gracefully skips when dist/
 * is missing entirely.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execTimeout, testTimeout } from "./helpers/timeouts";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const tmpFixtures: string[] = [];

const CHILD_PROCESS_TIMEOUT_MS = Math.max(execTimeout(10_000), testTimeout(10_000));
const TEST_TIMEOUT_MS = testTimeout(Math.max(30_000, CHILD_PROCESS_TIMEOUT_MS + 10_000));

afterEach(() => {
  for (const dir of tmpFixtures.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* */
    }
  }
});

/**
 * Parametric test: for a given credentialEnv, verify that onboard
 * non-interactive mode can resolve a pre-fix legacy credentials.json key
 * when process.env does NOT have it set.
 *
 * We run a small script that:
 *   1. Sets up a temp HOME with credentials.json containing the key
 *   2. Ensures process.env does NOT have the key
 *   3. Imports the compiled onboard module
 *   4. Calls hydrateCredentialEnv(credentialEnv)
 *   5. Checks that process.env now has the key
 */
function verifyCredentialHydration(credentialEnv: string, credentialValue: string) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-2273-hydrate-"));
  tmpFixtures.push(tmpDir);
  const nemoclawDir = path.join(tmpDir, ".nemoclaw");
  fs.mkdirSync(nemoclawDir, { recursive: true, mode: 0o700 });

  // Seed a pre-fix legacy credentials.json.
  fs.writeFileSync(
    path.join(nemoclawDir, "credentials.json"),
    JSON.stringify({ [credentialEnv]: credentialValue }),
    { mode: 0o600 },
  );

  const distPath = path.join(REPO_ROOT, "dist", "lib", "onboard.js");
  const scriptPath = path.join(tmpDir, "check-hydrate.js");
  fs.writeFileSync(
    scriptPath,
    `
const onboardPath = ${JSON.stringify(distPath)};
const { hydrateCredentialEnv } = require(onboardPath);

// Ensure the env var is NOT set
delete process.env[${JSON.stringify(credentialEnv)}];

// Hydrate through the canonical resolver.
const result = hydrateCredentialEnv(${JSON.stringify(credentialEnv)});

// Report
const payload = {
  hydrated: result,
  envValue: process.env[${JSON.stringify(credentialEnv)}] || null,
};
process.stdout.write(JSON.stringify(payload));
`,
  );

  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    env: {
      HOME: tmpDir,
      PATH: path.dirname(process.execPath) + ":/usr/bin:/bin",
      NO_COLOR: "1",
    },
    timeout: CHILD_PROCESS_TIMEOUT_MS,
  });

  return { result, tmpDir };
}

describe("Issue #2273 Layer 1: credential hydration from legacy storage", () => {
  // Test each provider's credential env to ensure parametric coverage
  const providers = [
    { name: "NVIDIA Endpoints", credentialEnv: "NVIDIA_API_KEY", value: "nvapi-test-hydrate" },
    { name: "OpenAI", credentialEnv: "OPENAI_API_KEY", value: "sk-test-hydrate" },
    { name: "Anthropic", credentialEnv: "ANTHROPIC_API_KEY", value: "sk-ant-test-hydrate" },
    { name: "Google Gemini", credentialEnv: "GEMINI_API_KEY", value: "gemini-test-hydrate" },
    {
      name: "Custom OpenAI-compatible",
      credentialEnv: "COMPATIBLE_API_KEY",
      value: "compat-test-hydrate",
    },
    {
      name: "Custom Anthropic-compatible",
      credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
      value: "compat-ant-test-hydrate",
    },
  ];

  for (const { name, credentialEnv, value } of providers) {
    it(
      `hydrates ${credentialEnv} (${name}) from legacy credentials.json when not in process.env`,
      { timeout: TEST_TIMEOUT_MS },
      () => {
        const { result } = verifyCredentialHydration(credentialEnv, value);

        if (result.status !== 0) {
          if ((result.stderr || "").includes("Cannot find module")) {
            throw new Error(
              `dist/lib/onboard.js not found. Run \`npm run build:cli\` before running this test.\n${result.stderr}`,
            );
          }
          throw new Error(
            `Script failed (exit ${result.status}):\n${result.stderr}\n${result.stdout}`,
          );
        }

        const payload = JSON.parse(result.stdout);
        expect(payload.hydrated).toBe(value);
        expect(payload.envValue).toBe(value);
      },
    );
  }
});
