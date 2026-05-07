// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { DEV_SHIM_MARKER } from "../../domain/dev/npm-link-or-shim";
import { runNpmLinkOrShim } from "./npm-link-or-shim";

function setupRepo(): { binPath: string; homeDir: string; repoDir: string; tmpDir: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dev-shim-action-"));
  const repoDir = path.join(tmpDir, "repo");
  const homeDir = path.join(tmpDir, "home");
  const binPath = path.join(repoDir, "bin", "nemoclaw.js");
  fs.mkdirSync(path.dirname(binPath), { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  fs.writeFileSync(binPath, "#!/usr/bin/env node\n", { mode: 0o755 });
  return { binPath, homeDir, repoDir, tmpDir };
}

function failingNpm() {
  return vi.fn(() => ({ status: 1, stdout: "", stderr: "npm error code EACCES\n" }));
}

describe("runNpmLinkOrShim", () => {
  it("returns without side effects during prepare recursion", () => {
    const { homeDir, repoDir } = setupRepo();
    const run = failingNpm();

    const result = runNpmLinkOrShim({ env: { HOME: homeDir, NEMOCLAW_INSTALLING: "1" }, repoRoot: repoDir }, { run });

    expect(result.status).toBe(0);
    expect(run).not.toHaveBeenCalled();
  });

  it("does not create a shim when npm link succeeds", () => {
    const { homeDir, repoDir } = setupRepo();
    const result = runNpmLinkOrShim(
      { env: { HOME: homeDir }, repoRoot: repoDir },
      { run: () => ({ status: 0, stdout: "", stderr: "" }) },
    );

    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(homeDir, ".local", "bin", "nemoclaw"))).toBe(false);
  });

  it("creates a managed shim after npm link fails", () => {
    const { binPath, homeDir, repoDir } = setupRepo();
    const errors: string[] = [];

    const result = runNpmLinkOrShim(
      { env: { HOME: homeDir, PATH: "/usr/bin" }, repoRoot: repoDir },
      {
        commandPath: () => process.execPath,
        logError: (message) => errors.push(message),
        run: failingNpm(),
      },
    );

    const shimPath = path.join(homeDir, ".local", "bin", "nemoclaw");
    expect(result.status).toBe(0);
    expect(fs.existsSync(shimPath)).toBe(true);
    expect((fs.statSync(shimPath).mode & 0o111) !== 0).toBe(true);
    const shim = fs.readFileSync(shimPath, "utf-8");
    expect(shim).toContain(DEV_SHIM_MARKER);
    expect(shim).toContain(`exec "${binPath}" "$@"`);
    expect(errors.join("\n")).toContain("npm link failed");
    expect(errors.join("\n")).toContain("Created user-local shim");
  });

  it("refuses to overwrite a foreign shim", () => {
    const { homeDir, repoDir } = setupRepo();
    const shimPath = path.join(homeDir, ".local", "bin", "nemoclaw");
    fs.mkdirSync(path.dirname(shimPath), { recursive: true });
    fs.writeFileSync(shimPath, "user-script\n", { mode: 0o755 });
    const errors: string[] = [];

    const result = runNpmLinkOrShim(
      { env: { HOME: homeDir }, repoRoot: repoDir },
      { commandPath: () => process.execPath, logError: (message) => errors.push(message), run: failingNpm() },
    );

    expect(result.status).toBe(1);
    expect(fs.readFileSync(shimPath, "utf-8")).toBe("user-script\n");
    expect(errors.join("\n")).toContain("not managed by NemoClaw");
  });

  it("refreshes an existing managed shim", () => {
    const { binPath, homeDir, repoDir } = setupRepo();
    const shimPath = path.join(homeDir, ".local", "bin", "nemoclaw");
    fs.mkdirSync(path.dirname(shimPath), { recursive: true });
    fs.writeFileSync(shimPath, `#!/usr/bin/env bash\n${DEV_SHIM_MARKER}\nexec /old/stale "$@"\n`, {
      mode: 0o755,
    });

    const result = runNpmLinkOrShim(
      { env: { HOME: homeDir }, repoRoot: repoDir },
      { commandPath: () => process.execPath, logError: vi.fn(), run: failingNpm() },
    );

    expect(result.status).toBe(0);
    const refreshed = fs.readFileSync(shimPath, "utf-8");
    expect(refreshed).toContain(`exec "${binPath}" "$@"`);
    expect(refreshed).not.toContain("/old/stale");
  });

  it("fails clearly when the shim directory cannot be created", () => {
    const { homeDir, repoDir } = setupRepo();
    fs.writeFileSync(path.join(homeDir, ".local"), "not-a-directory\n");
    const errors: string[] = [];

    const result = runNpmLinkOrShim(
      { env: { HOME: homeDir }, repoRoot: repoDir },
      { commandPath: () => process.execPath, logError: (message) => errors.push(message), run: failingNpm() },
    );

    expect(result.status).toBe(1);
    expect(errors.join("\n")).toContain("shim creation failed");
    expect(fs.readFileSync(path.join(homeDir, ".local"), "utf-8")).toBe("not-a-directory\n");
  });
});
