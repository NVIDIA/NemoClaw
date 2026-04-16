// @ts-nocheck
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

const ONBOARD_JS = path.join(import.meta.dirname, "..", "src", "lib", "onboard.ts");
const RUNNER_TS = path.join(import.meta.dirname, "..", "nemoclaw", "src", "blueprint", "runner.ts");
const SERVICES_TS = path.join(import.meta.dirname, "..", "src", "lib", "services.ts");

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

  it("runner.ts must not spread full process.env into subprocess", () => {
    const src = fs.readFileSync(RUNNER_TS, "utf-8");

    // Strip comments so that documented bad patterns don't trigger false positives.
    // Scan the full source (not line-by-line) to catch multiline spreads.
    const uncommented = src.replace(/\/\/.*$/gm, "");
    const spreadRe = /env\s*:\s*\{[\s\S]*?\.\.\.process\.env/;
    expect(uncommented).not.toMatch(spreadRe);
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

  it("onboard.ts uses subprocess allowlist (not blocklist) for sandbox env", () => {
    const src = fs.readFileSync(ONBOARD_JS, "utf-8");

    // The sandbox create path must use the shared subprocess-env.ts
    // allowlist, NOT the old blocklist. The allowlist inverts the
    // default: only known-safe env vars are forwarded, everything
    // else (credentials, CI secrets, SSH agent, etc.) is dropped.
    expect(src).toMatch(/buildSubprocessEnv\(\)/);
    // The old blocklist pattern must NOT be present
    expect(src).not.toMatch(/blockedSandboxEnvNames/);
    // KUBECONFIG and SSH_AUTH_SOCK must be explicitly deleted from
    // the sandbox env even though the generic allowlist permits them
    // for host-side processes.
    expect(src).toMatch(/delete sandboxEnv\.KUBECONFIG/);
    expect(src).toMatch(/delete sandboxEnv\.SSH_AUTH_SOCK/);
    // sandboxEnv must still be passed to streamSandboxCreate
    expect(src).toMatch(/streamSandboxCreate\(createCommand, sandboxEnv(?:, \{)?/);
  });

  it("services.ts must not spread full process.env into subprocess", () => {
    const src = fs.readFileSync(SERVICES_TS, "utf-8");

    const uncommented = src.replace(/\/\/.*$/gm, "");
    const spreadRe = /env\s*:\s*\{[\s\S]*?\.\.\.process\.env/;
    expect(uncommented).not.toMatch(spreadRe);
  });

  it("onboard curl probes use explicit timeouts", () => {
    const onboardSrc = fs.readFileSync(ONBOARD_JS, "utf-8");
    const probeSrc = fs.readFileSync(
      path.join(import.meta.dirname, "..", "src", "lib", "http-probe.ts"),
      "utf-8",
    );

    expect(onboardSrc).toMatch(/http-probe/);
    expect(probeSrc).toMatch(/"--connect-timeout", "10"/);
    expect(probeSrc).toMatch(/"--max-time", "60"/);
  });

  it("api-key paste-guard uses extensible prefix list and regex fallback", () => {
    const src = fs.readFileSync(ONBOARD_JS, "utf-8");

    // Known prefix list must include at least NVIDIA and GitHub prefixes
    expect(src).toMatch(/API_KEY_PREFIXES/);
    expect(src).toMatch(/"nvapi-"/);
    expect(src).toMatch(/"ghp_"/);
    // Space-aware length check must be present
    expect(src).toMatch(/!choice\.includes\(" "\).*choice\.length > 40/);
    // Regex fallback for base64-safe tokens must be present (full shape)
    expect(src).toMatch(/\/\^\[A-Za-z0-9_\\-\\.\]\{20,\}\$\/\.test\(choice\)/);
    // Validator must be hoisted (defined exactly once, not inside both branches)
    const validatorCount = (
      src.match(/const validator = credentialEnv === "NVIDIA_API_KEY"/g) || []
    ).length;
    expect(validatorCount).toBe(1);
    // looksLikeToken variable must exist
    expect(src).toMatch(/looksLikeToken/);
  });
});
