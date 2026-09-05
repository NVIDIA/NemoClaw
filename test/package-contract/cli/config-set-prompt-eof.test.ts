// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

/** Verify line answers and EOF through the compiled CLI over a real stdin pipe. */
const REPO_ROOT = path.join(import.meta.dirname, "../../..");
const CLI_PATH = JSON.stringify(path.join(REPO_ROOT, "dist", "nemoclaw.js"));
const OPENSHELL_PATH = JSON.stringify(
  path.join(REPO_ROOT, "dist", "lib", "adapters", "openshell", "client.js"),
);
const REGISTRY_PATH = JSON.stringify(path.join(REPO_ROOT, "dist", "lib", "state", "registry.js"));
const LIFECYCLE_LOCK_PATH = JSON.stringify(
  path.join(REPO_ROOT, "dist", "lib", "state", "mcp-lifecycle-lock.js"),
);
const LIFECYCLE_LOCK_ACQUISITION_PATH = JSON.stringify(
  path.join(REPO_ROOT, "dist", "lib", "state", "mcp-lifecycle-lock-acquisition.js"),
);
const CONFIG_LOCK_PATH = JSON.stringify(
  path.join(REPO_ROOT, "dist", "lib", "sandbox", "openclaw-config-guard.js"),
);
const PRIVILEGED_EXEC_PATH = JSON.stringify(
  path.join(REPO_ROOT, "dist", "lib", "sandbox", "privileged-exec.js"),
);

function runConfigSetWithInput(input: string) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-config-prompt-eof-"));
  const scriptPath = path.join(tmpDir, "config-prompt-eof-check.js");
  const script = [
    "function install(modulePath, exports) {",
    "  require.cache[modulePath] = {",
    "    id: modulePath,",
    "    filename: modulePath,",
    "    loaded: true,",
    "    exports,",
    "  };",
    "}",
    "",
    "install(" + REGISTRY_PATH + ", {",
    '  getSandbox: (name) => (name === "prompt-eof" ? { name } : null),',
    '  listSandboxes: () => ({ sandboxes: [{ name: "prompt-eof" }] }),',
    "});",
    "install(" + OPENSHELL_PATH + ", {",
    "  captureOpenshellCommand: () => ({",
    "    status: 0,",
    "    signal: null,",
    '    output: "{}",',
    '    stdout: "{}\\n",',
    '    stderr: "",',
    "  }),",
    "  runOpenshellCommand: () => ({ status: 0 }),",
    "});",
    "install(" + LIFECYCLE_LOCK_PATH + ", {",
    "  withMcpLifecycleLock: async (_sandboxName, callback) => callback(),",
    "  withSandboxMutationLock: (_sandboxName, callback) => callback(),",
    "});",
    "install(" + LIFECYCLE_LOCK_ACQUISITION_PATH + ", {",
    "  isMcpLifecycleLockHeld: () => true,",
    "  withMcpLifecycleLock: async (_sandboxName, callback) => callback(),",
    "  withMcpLifecycleLockSync: (_sandboxName, callback) => callback(),",
    "});",
    "install(" + CONFIG_LOCK_PATH + ", {",
    "  validateOpenClawConfigCandidate: () => [],",
    "  writeOpenClawConfigCandidate: (_privileged, input) => ({",
    "    issues: [],",
    '    configSha256: require("node:crypto")',
    '      .createHash("sha256")',
    '      .update(input || "")',
    '      .digest("hex"),',
    "  }),",
    "});",
    "install(" + PRIVILEGED_EXEC_PATH + ", {",
    "  capturePrivilegedSandboxCommand: () => Buffer.alloc(0),",
    "  executePrivilegedSandboxCommand: () => ({",
    "    status: 0,",
    "    signal: null,",
    "    stdout: Buffer.alloc(0),",
    "    stderr: Buffer.alloc(0),",
    "  }),",
    '  resolveDirectSandboxContainer: () => "container-id",',
    '  resolvePrivilegedSandboxTarget: () => ({ resourceHandle: "container-id" }),',
    "  withPrivilegedSandboxExecutionLease: (_sandboxName, _operation, callback) => callback(),",
    "});",
    "",
    'Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });',
    "process.argv = [",
    '  "node",',
    '  "nemoclaw.js",',
    '  "prompt-eof",',
    '  "config",',
    '  "set",',
    '  "--key",',
    '  "new.path",',
    '  "--value",',
    '  "1",',
    "];",
    "require(" + CLI_PATH + ");",
  ].join("\n");
  try {
    fs.writeFileSync(scriptPath, script);
    return spawnSync(process.execPath, [scriptPath], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      input,
      timeout: 30_000,
      killSignal: "SIGKILL",
      env: {
        ...process.env,
        HOME: tmpDir,
        NEMOCLAW_CONFIG_ACCEPT_NEW_PATH: undefined,
        NEMOCLAW_NON_INTERACTIVE: undefined,
      },
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("config set new-key prompt", () => {
  it("exits non-zero when the new-key prompt reaches EOF", () => {
    // An empty input closes the pipe before readline asks the question.
    const result = runConfigSetWithInput("");

    // A timeout would produce SIGKILL and a null status. Before this fix, the
    // unresolved question let Node exit 0 after stdin closed.
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.stdout).toContain("Old value: (not set)");
    expect(result.stderr).toContain("Write this new key? [y/N]");
    expect(result.stderr).toContain("No input available on stdin");
    expect(result.stderr).toContain("--config-accept-new-path");
    expect(result.stderr).toContain("NEMOCLAW_CONFIG_ACCEPT_NEW_PATH=1");
    expect(result.stdout).not.toContain("Writing config to sandbox");
    expect(result.stdout).not.toContain("config updated");
    expect(result.status).toBe(1);
  }, 45_000);

  it("treats an empty answer as an abort instead of EOF", () => {
    const result = runConfigSetWithInput("\n");

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.stderr).toContain("Write this new key? [y/N]");
    expect(result.stderr).toContain("Aborted.");
    expect(result.stderr).not.toContain("No input available on stdin");
    expect(result.stdout).not.toContain("Writing config to sandbox");
    expect(result.stdout).not.toContain("config updated");
    expect(result.status).toBe(1);
  }, 45_000);

  it("accepts a whitespace-padded affirmative answer", () => {
    const result = runConfigSetWithInput("  yes  \n");

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.stderr).toContain("Write this new key? [y/N]");
    expect(result.stderr).not.toContain("Aborted.");
    expect(result.stderr).not.toContain("No input available on stdin");
    expect(
      result.stdout,
      `status=${String(result.status)} stderr=${String(result.stderr)}`,
    ).toContain("Writing config to sandbox");
    expect(result.stdout).toContain("config updated");
    expect(result.status).toBe(0);
  }, 45_000);

  it("treats an unterminated answer as EOF", () => {
    const result = runConfigSetWithInput("yes");

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.stderr).toContain("Write this new key? [y/N]");
    expect(result.stderr).toContain("No input available on stdin");
    expect(result.stdout).not.toContain("Writing config to sandbox");
    expect(result.stdout).not.toContain("config updated");
    expect(result.status).toBe(1);
  }, 45_000);
});
