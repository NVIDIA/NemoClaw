// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Prompt-cancellation package contract for the policy preset pickers (#7418).
 *
 * A boot unit runs `nemoclaw <sandbox> policy-add` with no preset name and a
 * closed stdin. That reaches the interactive picker, and the prompt hits EOF.
 * The `question` callback never fired, the picker promise never settled, and
 * the CLI exited 0 having applied nothing. Automation could not distinguish
 * an applied preset from a no-op.
 *
 * These tests drive the compiled CLI (`dist/nemoclaw.js`) on real stdin at
 * EOF, so readline decides when the prompt closes. Only the registry and
 * preset lookups are stubbed, which replaces on-disk sandbox state.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "../../..");
const CLI_PATH = JSON.stringify(path.join(REPO_ROOT, "dist", "nemoclaw.js"));
const POLICIES_PATH = JSON.stringify(path.join(REPO_ROOT, "dist", "lib", "policy", "index.js"));
const REGISTRY_PATH = JSON.stringify(path.join(REPO_ROOT, "dist", "lib", "state", "registry.js"));

/**
 * Run a policy command with no preset name against a closed stdin. `input: ""`
 * gives the child an already-ended pipe, which is the EOF a boot unit
 * produces.
 */
function runPolicyCommandAtStdinEof(command: "policy-add" | "policy-remove") {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-prompt-eof-"));
  const scriptPath = path.join(tmpDir, "policy-prompt-eof-check.js");
  const script = String.raw`
const registry = require(${REGISTRY_PATH});
const policies = require(${POLICIES_PATH});
policies.listPresets = () => [
  { file: "npm.yaml", name: "npm", description: "npm registry access" },
  { file: "pypi.yaml", name: "pypi", description: "PyPI access" },
];
policies.listCustomPresets = () => [];
policies.getAppliedPresets = () => ["npm"];
registry.getSandbox = (name) =>
  name === "test-sandbox" ? { name, policies: ["npm"], customPolicies: [] } : null;
registry.listSandboxes = () => ({ sandboxes: [{ name: "test-sandbox" }] });
process.argv = ["node", "nemoclaw.js", "test-sandbox", ${JSON.stringify(command)}];
require(${CLI_PATH});
`;
  fs.writeFileSync(scriptPath, script);
  try {
    return spawnSync(process.execPath, [scriptPath], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      input: "",
      // A regression here is a hang, not a wrong value, so cap it rather than
      // letting the suite block. SIGKILL because the child is mid-prompt.
      timeout: 30_000,
      killSignal: "SIGKILL",
      env: { ...process.env, HOME: tmpDir, NEMOCLAW_NON_INTERACTIVE: undefined },
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("policy preset prompt cancellation", () => {
  it.each([
    { command: "policy-add" as const, menu: "Available presets:" },
    { command: "policy-remove" as const, menu: "Applied presets:" },
  ])("$command exits non-zero when the picker prompt hits EOF (#7418)", ({ command, menu }) => {
    const result = runPolicyCommandAtStdinEof(command);

    // The child exited on its own rather than being killed by the timeout
    // above. The pre-#7418 promise never settled, which appears here as a
    // SIGKILL and a null status instead of an exit status.
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    // The picker was reached, so this is prompt EOF rather than the
    // NEMOCLAW_NON_INTERACTIVE=1 guard exiting earlier.
    expect(result.stderr).toContain(menu);
    expect(result.stderr).toContain("No input available on stdin");
    expect(result.stderr).toContain(`${command} <preset>`);
    expect(result.status).toBe(1);
    // Above the child's 30s cap, so a hung picker fails on the assertions
    // above rather than as a bare suite timeout.
  }, 45_000);
});
