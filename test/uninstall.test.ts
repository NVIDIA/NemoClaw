// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

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

  function seedPreservedState(tmp: string): string {
    const stateDir = path.join(tmp, ".nemoclaw");
    fs.mkdirSync(path.join(stateDir, "rebuild-backups", "sb1", "20260101"), { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "rebuild-backups", "sb1", "20260101", "manifest.json"),
      "{}",
    );
    fs.mkdirSync(path.join(stateDir, "backups", "20260320-120000"), { recursive: true });
    fs.writeFileSync(path.join(stateDir, "backups", "20260320-120000", "USER.md"), "hello");
    fs.writeFileSync(path.join(stateDir, "sandboxes.json"), "[]");
    return stateDir;
  }

  function sanitizedParentEnv(): NodeJS.ProcessEnv {
    return Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("NEMOCLAW_")),
    ) as NodeJS.ProcessEnv;
  }

  function runUninstall(
    tmp: string,
    args: string[],
    extraEnv: NodeJS.ProcessEnv = {},
  ): ReturnType<typeof spawnSync> {
    return spawnSync("bash", [UNINSTALL_SCRIPT, ...args], {
      cwd: path.join(import.meta.dirname, ".."),
      encoding: "utf-8",
      env: {
        ...sanitizedParentEnv(),
        HOME: tmp,
        PATH: `${path.join(tmp, "bin")}:/usr/bin:/bin`,
        NEMOCLAW_NODE: process.execPath,
        TMPDIR: tmp,
        ...extraEnv,
      },
    });
  }

  it("exits 0 and shows usage for --help", () => {
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
    expect(output).toMatch(/--destroy-user-data/);
  });

  it("uses NemoHermes branding for --help when Hermes is active", () => {
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

  it("skips the confirmation prompt and completes successfully for --yes", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-yes-"));
    writeFakeTools(path.join(tmp, "bin"));
    try {
      const result = runUninstall(tmp, ["--yes"]);

      expect(result.status).toBe(0);
      const output = `${result.stdout}${result.stderr}`;
      expect(output).toMatch(/NemoClaw/);
      expect(output).toMatch(/Claws retracted/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);

  it("preserves rebuild-backups, backups, and sandboxes.json under ~/.nemoclaw for --yes", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-yes-preserve-"));
    writeFakeTools(path.join(tmp, "bin"));
    const stateDir = seedPreservedState(tmp);
    try {
      const result = runUninstall(tmp, ["--yes"]);

      expect(result.status).toBe(0);
      expect(
        fs.existsSync(path.join(stateDir, "rebuild-backups", "sb1", "20260101", "manifest.json")),
      ).toBe(true);
      expect(fs.existsSync(path.join(stateDir, "backups", "20260320-120000", "USER.md"))).toBe(
        true,
      );
      expect(fs.existsSync(path.join(stateDir, "sandboxes.json"))).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);

  it("purges preserved ~/.nemoclaw entries through the public wrapper for --yes --destroy-user-data", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-destroy-"));
    writeFakeTools(path.join(tmp, "bin"));
    const stateDir = seedPreservedState(tmp);
    try {
      const result = runUninstall(tmp, ["--yes", "--destroy-user-data"]);

      expect(result.status).toBe(0);
      const output = `${result.stdout}${result.stderr}`;
      expect(output).toMatch(/--destroy-user-data set; purging user data under ~\/\.nemoclaw\//);
      expect(fs.existsSync(stateDir)).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);

  it("uses NemoHermes branding for --yes when Hermes is active", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemohermes-uninstall-yes-"));
    writeFakeTools(path.join(tmp, "bin"));
    try {
      const result = runUninstall(tmp, ["--yes"], { NEMOCLAW_AGENT: "hermes" });

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
