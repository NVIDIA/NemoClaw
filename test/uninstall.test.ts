// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const UNINSTALL_SCRIPT = path.join(import.meta.dirname, "..", "uninstall.sh");

function createFakeNpmEnv(tmp: string): Record<string, string | undefined> {
  const fakeBin = path.join(tmp, "bin");
  const npmPath = path.join(fakeBin, "npm");
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(npmPath, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  return {
    ...process.env,
    HOME: tmp,
    PATH: `${fakeBin}:${process.env.PATH || "/usr/bin:/bin"}`,
  };
}

describe("uninstall CLI flags", () => {
  it("--help exits 0 and shows usage", () => {
    const result = spawnSync("bash", [UNINSTALL_SCRIPT, "--help"], {
      cwd: path.join(import.meta.dirname, ".."),
      encoding: "utf-8",
    });

    expect(result.status).toBe(0);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toMatch(/NemoClaw Uninstaller/);
    expect(output).toMatch(/--yes/);
    expect(output).toMatch(/--keep-openshell/);
    expect(output).toMatch(/--delete-models/);
  });

  it("--yes skips the confirmation prompt and completes successfully", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-yes-"));
    const fakeBin = path.join(tmp, "bin");
    fs.mkdirSync(fakeBin);

    try {
      for (const cmd of ["npm", "openshell", "docker", "ollama", "pgrep"]) {
        fs.writeFileSync(path.join(fakeBin, cmd), "#!/usr/bin/env bash\nexit 0\n", {
          mode: 0o755,
        });
      }

      const result = spawnSync("bash", [UNINSTALL_SCRIPT, "--yes"], {
        cwd: path.join(import.meta.dirname, ".."),
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmp,
          PATH: `${fakeBin}:/usr/bin:/bin`,
          SCRIPT_DIR: path.join(import.meta.dirname, ".."),
        },
      });

      expect(result.status).toBe(0);
      const output = `${result.stdout}${result.stderr}`;
      expect(output).toMatch(/NemoClaw/);
      expect(output).toMatch(/Claws retracted/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("uninstall helpers", () => {
  it("returns the expected gateway volume candidate", () => {
    const result = spawnSync(
      "bash",
      ["-c", `source "${UNINSTALL_SCRIPT}"; gateway_volume_candidates nemoclaw`],
      {
        cwd: path.join(import.meta.dirname, ".."),
        encoding: "utf-8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("openshell-cluster-nemoclaw");
  });

  it("removes the user-local nemoclaw shim", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-shim-"));
    const shimDir = path.join(tmp, ".local", "bin");
    const shimPath = path.join(shimDir, "nemoclaw");
    const targetPath = path.join(tmp, "prefix", "bin", "nemoclaw");

    fs.mkdirSync(shimDir, { recursive: true });
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, "#!/usr/bin/env bash\n", { mode: 0o755 });
    fs.symlinkSync(targetPath, shimPath);

    const result = spawnSync("bash", ["-c", `source "${UNINSTALL_SCRIPT}"; remove_nemoclaw_cli`], {
      cwd: path.join(import.meta.dirname, ".."),
      encoding: "utf-8",
      env: createFakeNpmEnv(tmp),
    });

    expect(result.status).toBe(0);
    expect(fs.existsSync(shimPath)).toBe(false);
  }, 60_000);

  it("preserves a user-managed nemoclaw file in the shim directory", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-preserve-"));
    const shimDir = path.join(tmp, ".local", "bin");
    const shimPath = path.join(shimDir, "nemoclaw");

    fs.mkdirSync(shimDir, { recursive: true });
    fs.writeFileSync(shimPath, "#!/usr/bin/env bash\n", { mode: 0o755 });

    const result = spawnSync("bash", ["-c", `source "${UNINSTALL_SCRIPT}"; remove_nemoclaw_cli`], {
      cwd: path.join(import.meta.dirname, ".."),
      encoding: "utf-8",
      env: createFakeNpmEnv(tmp),
    });

    expect(result.status).toBe(0);
    expect(fs.existsSync(shimPath)).toBe(true);
    expect(`${result.stdout}${result.stderr}`).toMatch(/not an installer-managed shim/);
  }, 60_000);

  it("removes an installer-managed nemoclaw wrapper file in the shim directory", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-wrapper-"));
    const shimDir = path.join(tmp, ".local", "bin");
    const shimPath = path.join(shimDir, "nemoclaw");

    fs.mkdirSync(shimDir, { recursive: true });
    fs.writeFileSync(
      shimPath,
      [
        "#!/usr/bin/env bash",
        'export PATH="/tmp/node-bin:$PATH"',
        'exec "/tmp/prefix/bin/nemoclaw" "$@"',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const result = spawnSync("bash", ["-c", `source "${UNINSTALL_SCRIPT}"; remove_nemoclaw_cli`], {
      cwd: path.join(import.meta.dirname, ".."),
      encoding: "utf-8",
      env: createFakeNpmEnv(tmp),
    });

    expect(result.status).toBe(0);
    expect(fs.existsSync(shimPath)).toBe(false);
  }, 60_000);

  it("removes a dev-install shim written by scripts/npm-link-or-shim.sh", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-dev-shim-"));
    const shimDir = path.join(tmp, ".local", "bin");
    const shimPath = path.join(shimDir, "nemoclaw");

    fs.mkdirSync(shimDir, { recursive: true });
    fs.writeFileSync(
      shimPath,
      [
        "#!/usr/bin/env bash",
        "# NemoClaw dev-shim - managed by scripts/npm-link-or-shim.sh",
        'export PATH="/tmp/node-bin:$PATH"',
        'exec "/tmp/checkout/bin/nemoclaw.js" "$@"',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const result = spawnSync("bash", ["-c", `source "${UNINSTALL_SCRIPT}"; remove_nemoclaw_cli`], {
      cwd: path.join(import.meta.dirname, ".."),
      encoding: "utf-8",
      env: createFakeNpmEnv(tmp),
    });

    expect(result.status).toBe(0);
    expect(fs.existsSync(shimPath)).toBe(false);
  }, 60_000);

  it("preserves a wrapper-like shim when extra content is appended", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-wrapper-extra-"));
    const shimDir = path.join(tmp, ".local", "bin");
    const shimPath = path.join(shimDir, "nemoclaw");

    fs.mkdirSync(shimDir, { recursive: true });
    fs.writeFileSync(
      shimPath,
      [
        "#!/usr/bin/env bash",
        'export PATH="/tmp/node-bin:$PATH"',
        'exec "/tmp/prefix/bin/nemoclaw" "$@"',
        "echo user-extra",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const result = spawnSync("bash", ["-c", `source "${UNINSTALL_SCRIPT}"; remove_nemoclaw_cli`], {
      cwd: path.join(import.meta.dirname, ".."),
      encoding: "utf-8",
      env: createFakeNpmEnv(tmp),
    });

    expect(result.status).toBe(0);
    expect(fs.existsSync(shimPath)).toBe(true);
    expect(`${result.stdout}${result.stderr}`).toMatch(/not an installer-managed shim/);
  }, 60_000);

  it("removes the onboard session file as part of NemoClaw state cleanup", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-session-"));
    const stateDir = path.join(tmp, ".nemoclaw");
    const sessionPath = path.join(stateDir, "onboard-session.json");

    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(sessionPath, JSON.stringify({ status: "complete" }));

    const result = spawnSync(
      "bash",
      ["-c", `source "${UNINSTALL_SCRIPT}"; remove_nemoclaw_state`],
      {
        cwd: path.join(import.meta.dirname, ".."),
        encoding: "utf-8",
        env: { ...process.env, HOME: tmp },
      },
    );

    expect(result.status).toBe(0);
    expect(fs.existsSync(sessionPath)).toBe(false);
    expect(fs.existsSync(stateDir)).toBe(false);
  }, 60_000);
});
