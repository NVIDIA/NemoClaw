// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Non-interactive package contract for policy preset selection (#7418).
 *
 * A boot unit runs `nemoclaw <sandbox> policy-add` with no preset name and a
 * pipe-backed stdin. The CLI must reject the missing preset before it starts
 * the interactive picker. Automation can then distinguish refusal from a
 * successful mutation.
 *
 * These tests drive the compiled CLI (`dist/nemoclaw.js`) with a pipe-backed
 * stdin. Only the registry and preset lookups are stubbed, which replaces
 * on-disk sandbox state.
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
 * Run a policy command with no preset name and no terminal input. `input: ""`
 * gives the child an already-ended pipe, which is the stdin shape a boot unit
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
  name === "test-sandbox" ? { name } : null;
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
      // Keep defensive hang protection around the real stdin boundary. Before
      // #7418, the unresolved picker promise let Node exit 0 after stdin closed;
      // the status assertion below catches that original regression.
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
    { command: "policy-add" as const, menu: "Available presets:", usage: "policy add <preset>" },
    {
      command: "policy-remove" as const,
      menu: "Applied presets:",
      usage: "policy remove <preset>",
    },
  ])(
    "$command exits non-zero before opening a picker without a terminal (#7418)",
    ({ command, menu, usage }) => {
      const result = runPolicyCommandAtStdinEof(command);

      // The child exited on its own rather than being killed by the defensive
      // timeout above. A hang would produce SIGKILL and a null status; the
      // pre-#7418 regression exited 0 and is caught by the final assertion.
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.stderr).not.toContain(menu);
      expect(result.stderr).toContain("No input available on stdin");
      expect(result.stderr).toContain(usage);
      expect(result.status).toBe(1);
      // Above the child's 30s cap, so any hang fails on the assertions above
      // rather than as a bare suite timeout.
    },
    45_000,
  );
});
