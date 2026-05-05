// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";

const repoRoot = path.join(import.meta.dirname, "..");
const scriptUnderTest = path.join(repoRoot, "scripts", "npm-link-or-shim.sh");
const SHIM_MARKER = "# NemoClaw dev-shim - managed by scripts/npm-link-or-shim.sh";

function setupFakeRepo(): { tmpDir: string; repoDir: string; homeDir: string; fakeBin: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-link-shim-"));
  const repoDir = path.join(tmpDir, "repo");
  const homeDir = path.join(tmpDir, "home");
  const fakeBin = path.join(tmpDir, "bin");

  fs.mkdirSync(path.join(repoDir, "bin"), { recursive: true });
  fs.mkdirSync(path.join(repoDir, "scripts"), { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });

  fs.writeFileSync(
    path.join(repoDir, "bin", "nemoclaw.js"),
    "#!/usr/bin/env node\nconsole.log('nemoclaw stub ok');\n",
    { mode: 0o755 },
  );
  fs.copyFileSync(scriptUnderTest, path.join(repoDir, "scripts", "npm-link-or-shim.sh"));
  fs.chmodSync(path.join(repoDir, "scripts", "npm-link-or-shim.sh"), 0o755);

  return { tmpDir, repoDir, homeDir, fakeBin };
}

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

function runScript(spec: { repoDir: string; homeDir: string; fakeBin: string }): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync("bash", [path.join(spec.repoDir, "scripts", "npm-link-or-shim.sh")], {
    cwd: spec.repoDir,
    encoding: "utf-8",
    env: {
      PATH: `${spec.fakeBin}:${process.env.PATH || ""}`,
      HOME: spec.homeDir,
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
    const { repoDir, homeDir, fakeBin } = setupFakeRepo();
    writeFakeNpm(fakeBin, "fail");

    const result = runScript({ repoDir, homeDir, fakeBin });

    expect(result.status).toBe(0);
    const shimPath = path.join(homeDir, ".local", "bin", "nemoclaw");
    expect(fs.existsSync(shimPath)).toBe(true);
    const stat = fs.lstatSync(shimPath);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.isFile()).toBe(true);
    expect((stat.mode & 0o111) !== 0).toBe(true);

    const contents = fs.readFileSync(shimPath, "utf-8");
    expect(contents).toContain(SHIM_MARKER);
    expect(contents).toContain(`exec "${path.join(repoDir, "bin", "nemoclaw.js")}"`);
    expect(contents).toMatch(/export PATH="[^"]+:\$PATH"/);

    expect(result.stderr).toContain("npm link failed");
    expect(result.stderr).toContain("Created user-local shim");
    expect(result.stderr).toContain("EACCES");
  });

  it("does not create a shim when npm link succeeds", () => {
    const { repoDir, homeDir, fakeBin } = setupFakeRepo();
    writeFakeNpm(fakeBin, "succeed");

    const result = runScript({ repoDir, homeDir, fakeBin });

    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(homeDir, ".local", "bin", "nemoclaw"))).toBe(false);
    expect(result.stderr).toBe("");
  });

  it("is a no-op when NEMOCLAW_INSTALLING is already set (avoids prepare-script recursion)", () => {
    const { repoDir, homeDir, fakeBin } = setupFakeRepo();
    writeFakeNpm(fakeBin, "fail");

    const result = spawnSync("bash", [path.join(repoDir, "scripts", "npm-link-or-shim.sh")], {
      cwd: repoDir,
      encoding: "utf-8",
      env: {
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
        HOME: homeDir,
        NEMOCLAW_INSTALLING: "1",
      },
    });

    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(homeDir, ".local", "bin", "nemoclaw"))).toBe(false);
    expect(result.stderr ?? "").toBe("");
  });

  it("refuses to overwrite a foreign file at the shim path and exits non-zero", () => {
    const { repoDir, homeDir, fakeBin } = setupFakeRepo();
    writeFakeNpm(fakeBin, "fail");

    const shimDir = path.join(homeDir, ".local", "bin");
    fs.mkdirSync(shimDir, { recursive: true });
    const shimPath = path.join(shimDir, "nemoclaw");
    fs.writeFileSync(shimPath, "user-script\n", { mode: 0o755 });

    const result = runScript({ repoDir, homeDir, fakeBin });

    expect(result.status).not.toBe(0);
    expect(fs.readFileSync(shimPath, "utf-8")).toBe("user-script\n");
    expect(result.stderr).toContain("not managed by NemoClaw");
  });

  it("refreshes an existing NemoClaw-managed shim (idempotent re-run)", () => {
    const { repoDir, homeDir, fakeBin } = setupFakeRepo();
    writeFakeNpm(fakeBin, "fail");

    const shimDir = path.join(homeDir, ".local", "bin");
    fs.mkdirSync(shimDir, { recursive: true });
    const shimPath = path.join(shimDir, "nemoclaw");
    fs.writeFileSync(shimPath, `#!/usr/bin/env bash\n${SHIM_MARKER}\nexec /old/stale/path "$@"\n`, {
      mode: 0o755,
    });

    const result = runScript({ repoDir, homeDir, fakeBin });

    expect(result.status).toBe(0);
    const refreshed = fs.readFileSync(shimPath, "utf-8");
    expect(refreshed).toContain(SHIM_MARKER);
    expect(refreshed).toContain(`exec "${path.join(repoDir, "bin", "nemoclaw.js")}"`);
    expect(refreshed).not.toContain("/old/stale/path");
    expect(result.stderr).toContain("Created user-local shim");
  });

  it("fails clearly without claiming success when ~/.local exists as a regular file", () => {
    const { repoDir, homeDir, fakeBin } = setupFakeRepo();
    writeFakeNpm(fakeBin, "fail");

    fs.writeFileSync(path.join(homeDir, ".local"), "not-a-directory\n");

    const result = runScript({ repoDir, homeDir, fakeBin });

    expect(result.status).not.toBe(0);
    expect(fs.existsSync(path.join(homeDir, ".local", "bin", "nemoclaw"))).toBe(false);
    expect(result.stderr).not.toContain("Created user-local shim");
    expect(fs.readFileSync(path.join(homeDir, ".local"), "utf-8")).toBe("not-a-directory\n");
  });
});
