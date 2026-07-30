// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "../../..");
const CLI_PATH = path.join(REPO_ROOT, "dist", "nemoclaw.js");
const ONBOARD_PATH = path.join(REPO_ROOT, "dist", "lib", "onboard.js");
const BUILD_CREDENTIAL_PATH = path.join(
  REPO_ROOT,
  "dist",
  "lib",
  "onboard",
  "build-credential-reuse.js",
);
const INVALID_KEY = "submitted-invalid-nvidia-key";
const STACK_TRACE_PATTERNS = [/(^|\s)(TypeError|ReferenceError|SyntaxError):/m, /^\s+at /m];

describe("compiled CLI invalid NVIDIA credential handling", () => {
  it("rejects the key without disclosure, a stack trace, external calls, or saved onboarding state (#7616)", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-invalid-key-contract-"));
    const home = path.join(fixtureRoot, "home");
    const blockedBin = path.join(fixtureRoot, "bin");
    const externalCallLog = path.join(fixtureRoot, "external-calls.log");
    const driver = path.join(fixtureRoot, "invalid-key-driver.cjs");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(blockedBin, { recursive: true });
    fs.writeFileSync(externalCallLog, "");

    for (const command of ["curl", "docker", "openshell"]) {
      fs.writeFileSync(
        path.join(blockedBin, command),
        `#!/usr/bin/env bash
printf '%s\n' "$0 $*" >> "$NEMOCLAW_EXTERNAL_CALL_LOG"
exit 97
`,
        { mode: 0o755 },
      );
    }

    fs.writeFileSync(
      driver,
      `
const onboardPath = ${JSON.stringify(ONBOARD_PATH)};
const cliPath = ${JSON.stringify(CLI_PATH)};
const { resolveNonInteractiveBuildCredential } = require(${JSON.stringify(BUILD_CREDENTIAL_PATH)});
require.cache[onboardPath] = {
  id: onboardPath,
  filename: onboardPath,
  loaded: true,
  exports: {
    onboard: async () => {
      resolveNonInteractiveBuildCredential({
        provider: "nvidia-prod",
        helpUrl: "https://build.nvidia.com/settings/api-keys",
        recoveredFromSandbox: false,
        providerExistsInGateway: () => {
          throw new Error("invalid-key validation queried the gateway");
        },
      });
    },
  },
};
process.argv = [
  "node",
  "nemoclaw.js",
  "onboard",
  "--non-interactive",
  "--yes",
  "--yes-i-accept-third-party-software",
];
require(cliPath);
`,
      { mode: 0o600 },
    );

    try {
      const result = spawnSync(process.execPath, [driver], {
        cwd: REPO_ROOT,
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: home,
          NEMOCLAW_EXTERNAL_CALL_LOG: externalCallLog,
          NEMOCLAW_NON_INTERACTIVE: "1",
          NVIDIA_INFERENCE_API_KEY: INVALID_KEY,
          PATH: `${blockedBin}${path.delimiter}${process.env.PATH ?? ""}`,
        },
        killSignal: "SIGKILL",
        timeout: 30_000,
      });
      const output = `${result.stdout}\n${result.stderr}`;

      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status, output).toBe(1);
      expect(output).toContain("Invalid NVIDIA API key. Must start with nvapi-");
      expect(output).not.toContain(INVALID_KEY);
      expect(
        STACK_TRACE_PATTERNS.some((pattern) => pattern.test(output)),
        output,
      ).toBe(false);
      expect(fs.readFileSync(externalCallLog, "utf-8")).toBe("");
      expect(fs.existsSync(path.join(home, ".nemoclaw", "onboard-session.json"))).toBe(false);
      expect(fs.existsSync(path.join(home, ".nemoclaw", "sandboxes.json"))).toBe(false);
    } finally {
      fs.rmSync(fixtureRoot, { force: true, recursive: true });
    }
  });
});
