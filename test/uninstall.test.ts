// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
          // The wrapper needs Node even when the test constrains PATH to fake system tools.
          NEMOCLAW_NODE: process.execPath,
          // Keep helper-service glob cleanup isolated from concurrently running tests.
          TMPDIR: tmp,
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
