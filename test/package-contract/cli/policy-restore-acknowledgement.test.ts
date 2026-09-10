// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Acknowledgement package contract for `policy restore`.
 *
 * A session without terminal input must require explicit acknowledgement and
 * must not interpret pipe input as an interactive confirmation.
 *
 * These tests drive the compiled CLI (`dist/nemoclaw.js`) over a real stdin
 * pipe. The helper stubs registry and baseline lookups. It replaces
 * `restoreBaselineEntry` with a marker so the test does not change sandbox
 * state.
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

const RESTORED_MARKER = "restore-baseline-entry-reached";
const USAGE = "Usage: nemoclaw <sandbox> policy restore <key> [--yes|-y] [--force] [--dry-run]";

function runPolicyRestore({ input, nonInteractive }: { input: string; nonInteractive: boolean }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-restore-ack-"));
  const scriptPath = path.join(tmpDir, "policy-restore-acknowledgement-check.js");
  const script = String.raw`
const registry = require(${REGISTRY_PATH});
const policies = require(${POLICIES_PATH});
registry.getSandbox = (name) => (name === "test-sandbox" ? { name, agent: "hermes" } : null);
registry.listSandboxes = () => ({ sandboxes: [{ name: "test-sandbox" }] });
policies.resolveSandboxBaselinePolicy = () => ({
  agent: "hermes",
  policyPath: "/policy-additions.yaml",
  content: "version: 1\n",
});
policies.getSandboxBaselineEntry = (_sandbox, key) =>
  key === "npm_registry"
    ? { name: "npm_registry", endpoints: [{ host: "registry.npmjs.org", port: 443 }] }
    : null;
policies.restoreBaselineEntry = () => {
  console.log(${JSON.stringify(RESTORED_MARKER)});
  return true;
};
process.argv = ["node", "nemoclaw.js", "test-sandbox", "policy", "restore", "npm_registry"];
require(${CLI_PATH});
`;
  fs.writeFileSync(scriptPath, script);
  try {
    return spawnSync(process.execPath, [scriptPath], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      input,
      timeout: 30_000,
      killSignal: "SIGKILL",
      env: {
        ...process.env,
        HOME: tmpDir,
        NEMOCLAW_NON_INTERACTIVE: nonInteractive ? "1" : undefined,
      },
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("policy restore acknowledgement", () => {
  it("requires explicit acknowledgement when pipe input contains a decline", () => {
    const result = runPolicyRestore({ input: "n\n", nonInteractive: false });

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.stdout).toContain("re-allows:");
    expect(result.stderr).toContain(
      "Non-interactive restore requires explicit acknowledgement: pass --force (or --yes).",
    );
    expect(result.stderr).toContain(USAGE);
    expect(result.stdout).not.toContain(RESTORED_MARKER);
    expect(result.status).toBe(1);
  }, 45_000);

  it("prints the usage line when non-interactive mode has no acknowledgement", () => {
    const result = runPolicyRestore({ input: "", nonInteractive: true });

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.stderr).toContain(
      "Non-interactive restore requires explicit acknowledgement: pass --force (or --yes).",
    );
    expect(result.stderr).toContain(USAGE);
    expect(result.stdout).not.toContain(RESTORED_MARKER);
    expect(result.status).toBe(1);
  }, 45_000);

  it("prints the non-interactive usage line when stdin is an ended pipe", () => {
    const result = runPolicyRestore({ input: "", nonInteractive: false });

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.stderr).toContain(
      "Non-interactive restore requires explicit acknowledgement: pass --force (or --yes).",
    );
    expect(result.stderr).toContain(USAGE);
    expect(result.stdout).not.toContain(RESTORED_MARKER);
    expect(result.status).toBe(1);
  }, 45_000);
});
