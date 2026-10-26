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
 * A terminal Ctrl-D typed between two prompts must also cancel the picker
 * (#12169). The terminal is cooked while nothing reads stdin, so the kernel
 * queues the Ctrl-D as an end-of-file. The picker prompt switches the terminal
 * to raw mode, which would drop that end-of-file and leave the picker waiting.
 *
 * These tests drive the compiled CLI (`dist/nemoclaw.js`) through a pipe-backed
 * stdin or a real pseudo-terminal. Only the registry and preset lookups are
 * stubbed, which replaces on-disk sandbox state.
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
const CROSS_PORT_PATH = JSON.stringify(
  path.join(REPO_ROOT, "dist", "lib", "state", "registry", "cross-port.js"),
);

const PRESET_STUBS = String.raw`
const registry = require(${REGISTRY_PATH});
const crossPort = require(${CROSS_PORT_PATH});
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
crossPort.findSandboxAcrossGatewayRoots = (name) =>
  name === "test-sandbox"
    ? { entry: { name }, gatewayPort: null, registryFile: "test-registry" }
    : null;
`;

/**
 * Run a policy command with no preset name and no terminal input. `input: ""`
 * gives the child an already-ended pipe, which is the stdin shape a boot unit
 * produces.
 */
function runPolicyCommandAtStdinEof(command: "policy-add" | "policy-remove") {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-prompt-eof-"));
  const scriptPath = path.join(tmpDir, "policy-prompt-eof-check.js");
  const script = String.raw`
${PRESET_STUBS}
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

const STORE_PATH = JSON.stringify(path.join(REPO_ROOT, "dist", "lib", "credentials", "store.js"));

/**
 * Drive the child on a pseudo-terminal. The runner answers a prior prompt,
 * then types Ctrl-D while the child is busy and the terminal is cooked, so the
 * kernel queues it as an end-of-file for the policy picker.
 */
const PTY_RUNNER = String.raw`
import os, pty, re, select, sys, termios, time

pid, fd = pty.fork()
if pid == 0:
    node = os.environ["NODE_UNDER_TEST"]
    os.execvpe(node, [node, sys.argv[1]], os.environ)

def cooked():
    try:
        return bool(termios.tcgetattr(fd)[3] & termios.ICANON)
    except termios.error:
        return False

out = bytearray()
answered = False
sent = False
exit_code = 124
deadline = time.time() + 20
os.set_blocking(fd, False)
while time.time() < deadline:
    ready, _, _ = select.select([fd], [], [], 0.05)
    if ready:
        try:
            out.extend(os.read(fd, 4096))
        except (BlockingIOError, OSError):
            pass
    text = re.sub(rb"\x1b\[[0-9;?]*[a-zA-Z]", b"", bytes(out))
    if not answered and b"Prior question:" in text:
        time.sleep(0.2)
        os.write(fd, b"ok\n")
        answered = True
    if answered and not sent and b"BUSY_BEFORE_PICKER" in text and cooked():
        os.write(fd, b"\x04")
        sent = True
    waited = os.waitpid(pid, os.WNOHANG)
    if waited[0] == pid:
        exit_code = os.waitstatus_to_exitcode(waited[1])
        break
else:
    os.kill(pid, 9)
    os.waitpid(pid, 0)

try:
    while True:
        chunk = os.read(fd, 4096)
        if not chunk:
            break
        out.extend(chunk)
except (BlockingIOError, OSError):
    pass

sys.stdout.buffer.write(bytes(out))
print("\nPTY_CTRL_D_SENT=" + str(sent))
sys.exit(exit_code if exit_code >= 0 else 128 - exit_code)
`;

function runPolicyAddWithQueuedCtrlD() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-prompt-pty-eof-"));
  const scriptPath = path.join(tmpDir, "policy-prompt-pty-eof-check.js");
  // The busy preset lookup blocks the event loop, so nothing reads stdin
  // while the runner types Ctrl-D.
  const script = String.raw`
${PRESET_STUBS}
const listPresets = policies.listPresets;
policies.listPresets = () => {
  process.stderr.write("BUSY_BEFORE_PICKER\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 700);
  return listPresets();
};
policies.applyPreset = async () => {
  process.stderr.write("POLICY_MUTATED\n");
  return true;
};
require(${STORE_PATH})
  .prompt("  Prior question: ")
  .then(() => {
    process.argv = ["node", "nemoclaw.js", "test-sandbox", "policy-add"];
    require(${CLI_PATH});
  });
`;
  fs.writeFileSync(scriptPath, script);
  try {
    const result = spawnSync("python3", ["-c", PTY_RUNNER, scriptPath], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      timeout: 30_000,
      killSignal: "SIGKILL",
      env: {
        ...process.env,
        HOME: tmpDir,
        NODE_UNDER_TEST: process.execPath,
        NODE_NO_WARNINGS: "1",
        NEMOCLAW_NON_INTERACTIVE: undefined,
      },
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform === "win32")(
  "policy preset prompt terminal Ctrl-D (#12169)",
  () => {
    it("policy-add cancels the picker on a Ctrl-D queued after a prior prompt", () => {
      const { status, output } = runPolicyAddWithQueuedCtrlD();

      expect(output).toContain("PTY_CTRL_D_SENT=True");
      // 124 is the runner's hang verdict.
      expect(status, output).toBe(1);
      expect(output).toContain("Available presets:");
      expect(output).toContain("Choose preset [2]:");
      expect(output).toContain("No input available on stdin");
      expect(output).not.toContain("POLICY_MUTATED");
    }, 45_000);
  },
);
