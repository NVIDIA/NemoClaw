// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";

import { DEV_SHIM_MARKER } from "../src/lib/domain/dev-shim";

const repoRoot = path.join(import.meta.dirname, "..");
const scriptUnderTest = path.join(repoRoot, "scripts", "npm-link-or-shim.sh");
const compiledCli = path.join(repoRoot, "dist", "nemoclaw.js");

function writeFakeNpm(fakeBin: string, behaviour: "succeed" | "fail"): void {
  const failBody =
    behaviour === "fail"
      ? "echo 'npm error code EACCES' >&2\necho 'npm error syscall symlink' >&2\nexit 1\n"
      : "exit 0\n";
  fs.writeFileSync(
    path.join(fakeBin, "npm"),
    `#!/usr/bin/env bash\nif [ "\${1:-}" = "link" ]; then\n${failBody}fi\nexit 0\n`,
    { mode: 0o755 },
  );
}

function runScript(options: { fakeBin: string; homeDir: string; installing?: boolean }): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync("/bin/bash", [scriptUnderTest], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: {
      HOME: options.homeDir,
      NEMOCLAW_CLI_JS: compiledCli,
      NEMOCLAW_INSTALLING: options.installing ? "1" : "",
      NEMOCLAW_NODE: process.execPath,
      PATH: `${options.fakeBin}:/usr/bin:/bin`,
    },
  });
  return {
    status: typeof result.status === "number" ? result.status : -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("npm-link-or-shim.sh", () => {
  it("falls back to a wrapper script on npm link failure, preserving the Node directory", () => {
    expect(fs.existsSync(compiledCli)).toBe(true);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-link-shim-wrapper-"));
    const fakeBin = path.join(tmp, "bin");
    const homeDir = path.join(tmp, "home");
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });
    writeFakeNpm(fakeBin, "fail");

    const result = runScript({ fakeBin, homeDir });

    expect(result.status).toBe(0);
    const shimPath = path.join(homeDir, ".local", "bin", "nemoclaw");
    expect(fs.existsSync(shimPath)).toBe(true);
    const contents = fs.readFileSync(shimPath, "utf-8");
    expect(contents).toContain(DEV_SHIM_MARKER);
    expect(contents).toContain(`exec "${path.join(repoRoot, "bin", "nemoclaw.js")}"`);
    expect(contents).toContain(`export PATH="${path.dirname(process.execPath)}:$PATH"`);
    expect(result.stderr).toContain("npm link failed");
    expect(result.stderr).toContain("Created user-local shim");
    expect(result.stderr).toContain("EACCES");
  });

  it("does not create a shim when npm link succeeds", () => {
    expect(fs.existsSync(compiledCli)).toBe(true);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-link-shim-wrapper-"));
    const fakeBin = path.join(tmp, "bin");
    const homeDir = path.join(tmp, "home");
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });
    writeFakeNpm(fakeBin, "succeed");

    const result = runScript({ fakeBin, homeDir });

    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(homeDir, ".local", "bin", "nemoclaw"))).toBe(false);
    expect(result.stderr).toBe("");
  });

  it("is a no-op when NEMOCLAW_INSTALLING is already set (avoids prepare-script recursion)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-link-shim-wrapper-"));
    const fakeBin = path.join(tmp, "bin");
    const homeDir = path.join(tmp, "home");
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });
    writeFakeNpm(fakeBin, "fail");

    const result = runScript({ fakeBin, homeDir, installing: true });

    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(homeDir, ".local", "bin", "nemoclaw"))).toBe(false);
    expect(result.stderr).toBe("");
  });
});
