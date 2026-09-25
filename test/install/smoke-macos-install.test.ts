// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { superviseChild } from "../helpers/process-supervisor";

const SMOKE_SCRIPT = path.join(import.meta.dirname, "../..", "scripts", "smoke-macos-install.sh");

async function runGuard(script: string, args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  // Sourcing exercises the real parser and guard functions without entering the
  // install/uninstall main. Runtime discovery is independent of the host's sockets.
  const child = spawn(
    "bash",
    [
      "--noprofile",
      "--norc",
      "-c",
      `source "$SMOKE_SCRIPT_PATH"
find_colima_docker_socket() { return 1; }
find_podman_socket() { return 1; }
find_docker_desktop_socket() { return 1; }
${script}`,
      "smoke-guard",
      ...args,
    ],
    {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        NVIDIA_INFERENCE_API_KEY: "nvapi-test",
        SMOKE_SCRIPT_PATH: SMOKE_SCRIPT,
        ...env,
      },
    },
  );
  const result = await superviseChild(child, {
    timeoutMs: 5_000,
    killGraceMs: 100,
    onStdout: (chunk) => stdout.push(chunk),
    onStderr: (chunk) => stderr.push(chunk),
  });
  expect(result.spawnError).toBeUndefined();
  expect(result.cleanupError).toBeUndefined();
  expect(result.timedOut).toBe(false);
  return { status: result.exitCode, stdout: stdout.join(""), stderr: stderr.join("") };
}

describe("macOS smoke install script guardrails", { timeout: 10_000 }, () => {
  it.each([
    ["an exact 19-character name", "abcdefghijklmnopqrs", true],
    ["a 20-character name", "abcdefghijklmnopqrst", false],
    ["consecutive hyphens", "legacy--box", false],
    ["a leading digit", "1legacy-box", false],
  ])("validates %s against the OpenShell 0.0.99 contract (#8497)", async (_label, name, valid) => {
    const result = await runGuard("validate_sandbox_name", ["--sandbox-name", String(name)]);
    expect(result.status === 0, `${result.stdout}${result.stderr}`).toBe(valid);
  });

  it("prints help", async () => {
    const result = await runGuard("", ["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Usage: \.\/scripts\/smoke-macos-install\.sh/);
  });

  it("requires NVIDIA_INFERENCE_API_KEY", async () => {
    const result = await runGuard("", [], { NVIDIA_INFERENCE_API_KEY: "" });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/NVIDIA_INFERENCE_API_KEY must be set/);
  });

  it("rejects invalid sandbox names", async () => {
    const result = await runGuard("validate_sandbox_name", ["--sandbox-name", "Bad Name"]);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/Invalid sandbox name/);
  });

  it.each([
    ["unsupported lxc", "lxc", "Unsupported runtime 'lxc'"],
    ["Podman without a socket", "podman", "no Podman socket was found"],
    ["Docker Desktop without a socket", "docker-desktop", "no Docker Desktop socket was found"],
  ])("rejects runtime selection for %s", async (_title, runtime, message) => {
    const result = await runGuard("select_runtime", ["--runtime", runtime]);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(message);
  });

  it("stages the policy preset no answer after sandbox setup", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-smoke-answers-"));
    onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
    const result = await runGuard(
      String.raw`
answers_pipe="$SMOKE_TEST_DIR/answers"
install_log="$SMOKE_TEST_DIR/install.log"
mkfifo "$answers_pipe"
: > "$install_log"
SANDBOX_NAME="smoke-test"
feed_install_answers "$answers_pipe" "$install_log" &
feeder_pid="$!"
{
  IFS= read -r first_line
  printf '%s\n' "$first_line"
  printf 'OpenClaw gateway launched inside sandbox\n' >> "$install_log"
  IFS= read -r second_line
  printf '%s\n' "$second_line"
} < "$answers_pipe"
wait "$feeder_pid"
`,
      [],
      { SMOKE_TEST_DIR: directory },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("smoke-test\nn\n");
  });
});
