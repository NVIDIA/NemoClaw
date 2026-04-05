// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Security regression test: credential values must never appear in --credential
// CLI arguments. OpenShell reads credential values from the environment when
// only the env-var name is passed (e.g. --credential "NVIDIA_API_KEY"), so
// there is no reason to pass the secret itself on the command line where it
// would be visible in `ps aux` output.

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const ONBOARD_JS = path.join(import.meta.dirname, "..", "bin", "lib", "onboard.js");
const RUNNER_TS = path.join(import.meta.dirname, "..", "nemoclaw", "src", "blueprint", "runner.ts");

// Matches --credential followed by a value containing "=" (i.e. KEY=VALUE).
// Catches quoted KEY=VALUE patterns in JS and Python f-string interpolation.
// Assumes credentials are always in quoted strings (which matches our codebase).
// NOTE: unquoted forms like `--credential KEY=VALUE` would not be detected.
const JS_EXPOSURE_RE = /--credential\s+[^"]*"[A-Z_]+=/;
const JS_CREDENTIAL_CONCAT_RE = /--credential.*=.*process\.env\./;
// TS pattern: --credential with template literal interpolation containing "="
const TS_EXPOSURE_RE = /--credential.*=.*\$\{/;

describe("credential exposure in process arguments", () => {
  it("onboard.js must not pass KEY=VALUE to --credential", () => {
    const src = fs.readFileSync(ONBOARD_JS, "utf-8");
    const lines = src.split("\n");

    const violations = lines.filter(
      (line) =>
        (JS_EXPOSURE_RE.test(line) || JS_CREDENTIAL_CONCAT_RE.test(line)) &&
        // Allow comments that describe the old pattern
        !line.trimStart().startsWith("//"),
    );

    expect(violations).toEqual([]);
  });

  it("runner.ts must not pass KEY=VALUE to --credential", () => {
    const src = fs.readFileSync(RUNNER_TS, "utf-8");
    const lines = src.split("\n");

    const violations = lines.filter(
      (line) =>
        TS_EXPOSURE_RE.test(line) &&
        line.includes("--credential") &&
        !line.trimStart().startsWith("//"),
    );

    expect(violations).toEqual([]);
  });

  it("onboard.js --credential flags pass env var names only", () => {
    const src = fs.readFileSync(ONBOARD_JS, "utf-8");

    expect(src).toMatch(/"--credential", credentialEnv/);
    expect(src).not.toMatch(/"--credential",\s*["'][A-Z_]+=/);
    expect(src).not.toMatch(/"--credential",\s*process\.env\./);
  });

  it("onboard.js does not embed sandbox secrets in the sandbox create command line", () => {
    const src = fs.readFileSync(ONBOARD_JS, "utf-8");

    // sandboxEnv must be built with a blocklist that strips all credential env vars.
    // The blocklist derives provider keys from REMOTE_PROVIDER_CONFIG and adds
    // messaging tokens explicitly. Verify both mechanisms are present.
    const blocklistMatch = src.match(/const blockedSandboxEnvNames = new Set\(\[([\s\S]*?)\]\);/);
    expect(blocklistMatch).not.toBeNull();
    const blocklist = blocklistMatch[1];
    // Provider credentials are derived from REMOTE_PROVIDER_CONFIG
    expect(blocklist).toContain("REMOTE_PROVIDER_CONFIG");
    // Messaging and additional credentials are listed explicitly
    expect(blocklist).toContain('"BEDROCK_API_KEY"');
    expect(blocklist).toContain('"DISCORD_BOT_TOKEN"');
    expect(blocklist).toContain('"SLACK_BOT_TOKEN"');
    expect(blocklist).toContain('"TELEGRAM_BOT_TOKEN"');
    expect(src).toMatch(/streamSandboxCreate\(createCommand, sandboxEnv(?:, \{)?/);
    expect(src).not.toMatch(/envArgs\.push\(formatEnvAssignment\("NVIDIA_API_KEY"/);
    expect(src).not.toMatch(/envArgs\.push\(formatEnvAssignment\("DISCORD_BOT_TOKEN"/);
    expect(src).not.toMatch(/envArgs\.push\(formatEnvAssignment\("SLACK_BOT_TOKEN"/);
  });

  it("onboard.js curl probes use explicit timeouts", () => {
    const src = fs.readFileSync(ONBOARD_JS, "utf-8");

    expect(src).toMatch(/function getCurlTimingArgs\(\)/);
    expect(src).toMatch(/"--connect-timeout", "10"/);
    expect(src).toMatch(/"--max-time", "60"/);
  });
});
