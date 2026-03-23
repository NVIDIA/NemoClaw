// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const UNINSTALL_SCRIPT = path.join(import.meta.dirname, "..", "uninstall.sh");

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
      // Provide stub executables so the uninstaller can run its steps as no-ops
      for (const cmd of ["npm", "openshell", "docker", "ollama", "pgrep"]) {
        fs.writeFileSync(path.join(fakeBin, cmd), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
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
      // Banner and bye statement should be present
      const output = `${result.stdout}${result.stderr}`;
      expect(output).toMatch(/NemoClaw/);
      expect(output).toMatch(/Claws retracted/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("uninstall CLI flags", () => {
  it("--help exits 0 and shows usage", () => {
    const result = spawnSync("bash", [UNINSTALL_SCRIPT, "--help"], {
      cwd: path.join(__dirname, ".."),
      encoding: "utf-8",
    });

    assert.equal(result.status, 0);
    const output = `${result.stdout}${result.stderr}`;
    assert.match(output, /NemoClaw Uninstaller/);
    assert.match(output, /--yes/);
    assert.match(output, /--keep-openshell/);
    assert.match(output, /--delete-models/);
  });

  it("--yes skips the confirmation prompt and completes successfully", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-yes-"));
    const fakeBin = path.join(tmp, "bin");
    fs.mkdirSync(fakeBin);

    try {
      // Provide stub executables so the uninstaller can run its steps as no-ops
      for (const cmd of ["npm", "openshell", "docker", "ollama", "pgrep"]) {
        fs.writeFileSync(path.join(fakeBin, cmd), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
      }

      const result = spawnSync("bash", [UNINSTALL_SCRIPT, "--yes"], {
        cwd: path.join(__dirname, ".."),
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmp,
          PATH: `${fakeBin}:/usr/bin:/bin`,
          SCRIPT_DIR: path.join(__dirname, ".."),
        },
      });

      assert.equal(result.status, 0);
      // Banner and bye statement should be present
      const output = `${result.stdout}${result.stderr}`;
      assert.match(output, /NemoClaw/);
      assert.match(output, /Claws retracted/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("uninstall helpers", () => {
  it("returns the expected gateway volume candidate", () => {
    const result = spawnSync(
      "bash",
      ["-lc", `source "${UNINSTALL_SCRIPT}"; gateway_volume_candidates nemoclaw`],
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
    fs.mkdirSync(shimDir, { recursive: true });
    fs.writeFileSync(shimPath, "#!/usr/bin/env bash\n", { mode: 0o755 });

    const result = spawnSync(
      "bash",
      ["-lc", `HOME="${tmp}" source "${UNINSTALL_SCRIPT}"; remove_nemoclaw_cli`],
      {
        cwd: path.join(import.meta.dirname, ".."),
        encoding: "utf-8",
      },
    );

    expect(result.status).toBe(0);
    expect(fs.existsSync(shimPath)).toBe(false);
  });
});
