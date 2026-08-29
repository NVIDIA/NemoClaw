// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SMOKE_SCRIPT = path.join(import.meta.dirname, "../..", "scripts", "smoke-macos-install.sh");

describe("macOS smoke install sandbox-name guard", () => {
  it.each([
    ["an exact 19-character name", "abcdefghijklmnopqrs", true],
    ["a 20-character name", "abcdefghijklmnopqrst", false],
    ["consecutive hyphens", "legacy--box", false],
    ["a leading digit", "1legacy-box", false],
  ])("validates %s against the OpenShell 0.0.99 contract (#8497)", (_label, name, valid) => {
    const result = spawnSync(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-c",
        'set --; source "$SMOKE_SCRIPT_PATH"; SANDBOX_NAME="$SMOKE_SANDBOX_NAME"; validate_sandbox_name',
      ],
      {
        cwd: path.join(import.meta.dirname, "../.."),
        encoding: "utf-8",
        env: {
          ...process.env,
          NVIDIA_INFERENCE_API_KEY: "nvapi-test",
          SMOKE_SANDBOX_NAME: name,
          SMOKE_SCRIPT_PATH: SMOKE_SCRIPT,
        },
      },
    );

    expect(result.status === 0, `${result.stdout}${result.stderr}`).toBe(valid);
  });
});

describe.skip("macOS smoke install script guardrails", () => {
  it("prints help", () => {
    const result = spawnSync("bash", [SMOKE_SCRIPT, "--help"], {
      cwd: path.join(import.meta.dirname, "../.."),
      encoding: "utf-8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Usage: \.\/scripts\/smoke-macos-install\.sh/);
  });

  it("requires NVIDIA_INFERENCE_API_KEY", () => {
    const result = spawnSync("bash", [SMOKE_SCRIPT], {
      cwd: path.join(import.meta.dirname, "../.."),
      encoding: "utf-8",
      env: { ...process.env, NVIDIA_INFERENCE_API_KEY: "" },
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/NVIDIA_INFERENCE_API_KEY must be set/);
  });

  it("rejects invalid sandbox names", () => {
    const result = spawnSync("bash", [SMOKE_SCRIPT, "--sandbox-name", "Bad Name"], {
      cwd: path.join(import.meta.dirname, "../.."),
      encoding: "utf-8",
      env: { ...process.env, NVIDIA_INFERENCE_API_KEY: "nvapi-test" },
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/Invalid sandbox name/);
  });

  it("rejects unsupported runtimes", () => {
    const result = spawnSync("bash", [SMOKE_SCRIPT, "--runtime", "lxc"], {
      cwd: path.join(import.meta.dirname, "../.."),
      encoding: "utf-8",
      env: { ...process.env, NVIDIA_INFERENCE_API_KEY: "nvapi-test" },
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/Unsupported runtime 'lxc'/);
  });

  it("accepts podman as a runtime option", () => {
    const result = spawnSync("bash", [SMOKE_SCRIPT, "--runtime", "podman"], {
      cwd: path.join(import.meta.dirname, "../.."),
      encoding: "utf-8",
      env: {
        ...process.env,
        NVIDIA_INFERENCE_API_KEY: "nvapi-test",
        HOME: "/tmp/nemoclaw-smoke-no-runtime",
      },
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/no Podman socket was found/);
  });

  it("fails when a requested runtime socket is unavailable", () => {
    const result = spawnSync("bash", [SMOKE_SCRIPT, "--runtime", "docker-desktop"], {
      cwd: path.join(import.meta.dirname, "../.."),
      encoding: "utf-8",
      env: {
        ...process.env,
        NVIDIA_INFERENCE_API_KEY: "nvapi-test",
        HOME: "/tmp/nemoclaw-smoke-no-runtime",
      },
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/no Docker Desktop socket was found/);
  });

  it.skip("stages the policy preset no answer after sandbox setup", () => {
    const script = `
      set -euo pipefail
      source "${SMOKE_SCRIPT}"
      answers_pipe="$(mktemp -u)"
      install_log="$(mktemp)"
      mkfifo "$answers_pipe"
      trap 'rm -f "$answers_pipe" "$install_log"' EXIT
      SANDBOX_NAME="smoke-test"
      feed_install_answers "$answers_pipe" "$install_log" &
      feeder_pid="$!"
      {
        IFS= read -r first_line
        printf '%s\\n' "$first_line"
        printf '  ✓ OpenClaw gateway launched inside sandbox\\n' >> "$install_log"
        IFS= read -r second_line
        printf '%s\\n' "$second_line"
      } < "$answers_pipe"
      wait "$feeder_pid"
    `;

    const result = spawnSync("bash", ["--noprofile", "--norc", "-c", script], {
      cwd: path.join(import.meta.dirname, "../.."),
      encoding: "utf-8",
      env: { ...process.env, NVIDIA_INFERENCE_API_KEY: "nvapi-test" },
      timeout: 10_000,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("smoke-test\nn\n");
  });
});
