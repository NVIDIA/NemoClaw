// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const UNINSTALL_SCRIPT = path.join(__dirname, "..", "uninstall.sh");

describe("uninstall CLI flags", () => {
  it("--help exits 0 and shows usage", () => {
    const result = spawnSync("bash", [UNINSTALL_SCRIPT, "--help"], {
      cwd: path.join(__dirname, ".."),
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
        cwd: path.join(__dirname, ".."),
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmp,
          PATH: `${fakeBin}:/usr/bin:/bin`,
          SCRIPT_DIR: path.join(__dirname, ".."),
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

describe("uninstall helpers", () => {
  it("returns the expected gateway volume candidate", () => {
    const result = spawnSync(
      "bash",
      ["-lc", `source "${UNINSTALL_SCRIPT}"; gateway_volume_candidates nemoclaw`],
      {
        cwd: path.join(__dirname, ".."),
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
        cwd: path.join(__dirname, ".."),
        encoding: "utf-8",
      },
    );

    expect(result.status).toBe(0);
    expect(fs.existsSync(shimPath)).toBe(false);
  });
});
