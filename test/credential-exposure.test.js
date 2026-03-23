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

const ONBOARD_JS = path.join(
  import.meta.dirname,
  "..",
  "bin",
  "lib",
  "onboard.js",
);
const RUNNER_PY = path.join(
  import.meta.dirname,
  "..",
  "nemoclaw-blueprint",
  "orchestrator",
  "runner.py",
);

// Matches --credential followed by a value containing "=" (i.e. KEY=VALUE).
// Catches quoted KEY=VALUE patterns in JS and Python f-string interpolation.
// Assumes credentials are always in quoted strings (which matches our codebase).
// NOTE: unquoted forms like `--credential KEY=VALUE` would not be detected.
const JS_EXPOSURE_RE = /--credential\s+[^"]*"[A-Z_]+=/;
const JS_CREDENTIAL_CONCAT_RE = /--credential.*=.*process\.env\./;
const PY_EXPOSURE_RE = /--credential.*=.*\{/;

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

  it("runner.py must not pass KEY=VALUE to --credential", () => {
    const src = fs.readFileSync(RUNNER_PY, "utf-8");
    const lines = src.split("\n");

    const violations = lines.filter(
      (line) =>
        PY_EXPOSURE_RE.test(line) &&
        line.includes("--credential") &&
        !line.trimStart().startsWith("#"),
    );

    expect(violations).toEqual([]);
  });

  it("onboard.js --credential flags pass env var names only", () => {
    const src = fs.readFileSync(ONBOARD_JS, "utf-8");

    // Find all --credential arguments and verify they contain only a key name
    // (no "=" sign in the credential value)
    const credentialArgs = src.match(/--credential\s+"([^"]+)"/g) || [];
    const credentialShellQuote =
      src.match(/--credential\s+\$\{shellQuote\("([^"]+)"\)\}/g) || [];

    const allArgs = [...credentialArgs, ...credentialShellQuote];
    expect(allArgs.length).toBeGreaterThan(0);

    for (const arg of allArgs) {
      // Extract the credential value from the match
      const valueMatch =
        arg.match(/--credential\s+"([^"]+)"/) ||
        arg.match(/--credential\s+\$\{shellQuote\("([^"]+)"\)\}/);
      if (valueMatch) {
        expect(valueMatch[1]).not.toContain("=");
      }
    }
  });
});
