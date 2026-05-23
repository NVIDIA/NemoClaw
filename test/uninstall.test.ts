// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const UNINSTALL_SCRIPT = path.join(import.meta.dirname, "..", "uninstall.sh");

describe("uninstall CLI flags", () => {
  function writeFakeTools(fakeBin: string) {
    fs.mkdirSync(fakeBin);
    for (const cmd of ["npm", "openshell", "docker", "ollama", "pgrep"]) {
      fs.writeFileSync(path.join(fakeBin, cmd), "#!/usr/bin/env bash\nexit 0\n", {
        mode: 0o755,
      });
    }
  }

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

  it("--help uses NemoHermes branding when Hermes is the active agent", () => {
    const result = spawnSync("bash", [UNINSTALL_SCRIPT, "--help"], {
      cwd: path.join(import.meta.dirname, ".."),
      encoding: "utf-8",
      env: {
        ...process.env,
        NEMOCLAW_AGENT: "hermes",
        NEMOCLAW_NODE: process.execPath,
      },
    });

    expect(result.status).toBe(0);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toMatch(/NemoHermes Uninstaller/);
    expect(output).toMatch(/Remove host-side NemoHermes resources/);
    expect(output).toMatch(/Remove NemoHermes-pulled Ollama models/);
    expect(output).not.toMatch(/NemoClaw Uninstaller/);
  });

  it("--yes skips the confirmation prompt and completes successfully", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-yes-"));
    const fakeBin = path.join(tmp, "bin");
    writeFakeTools(fakeBin);

    try {
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

  it("--yes uses NemoHermes branding when Hermes is the active agent", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemohermes-uninstall-yes-"));
    const fakeBin = path.join(tmp, "bin");
    writeFakeTools(fakeBin);

    try {
      const result = spawnSync("bash", [UNINSTALL_SCRIPT, "--yes"], {
        cwd: path.join(import.meta.dirname, ".."),
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmp,
          NEMOCLAW_AGENT: "hermes",
          PATH: `${fakeBin}:/usr/bin:/bin`,
          NEMOCLAW_NODE: process.execPath,
          TMPDIR: tmp,
        },
      });

      expect(result.status).toBe(0);
      const output = `${result.stdout}${result.stderr}`;
      expect(output).toMatch(/NemoHermes Uninstaller/);
      expect(output).toMatch(/\[3\/6\] NemoHermes CLI/);
      expect(output).toMatch(/Removed global NemoHermes CLI package/);
      expect(output).toMatch(/Hermes has left the tidepool/);
      expect(output).not.toMatch(/NemoClaw Uninstaller/);
      expect(output).not.toMatch(/\[3\/6\] NemoClaw CLI/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});
