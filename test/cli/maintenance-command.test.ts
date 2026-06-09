// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { run, runWithEnv } from "./helpers";

describe("maintenance CLI dispatch", () => {
  it("maintenance command help exits 0 and shows migrated usage", () => {
    const backup = run("backup-all --help");
    expect(backup.code).toBe(0);
    expect(backup.out).toContain("backup-all");
    expect(backup.out).toContain("Back up all sandbox state before upgrade");

    const upgrade = run("upgrade-sandboxes --help");
    expect(upgrade.code).toBe(0);
    expect(upgrade.out).toContain("upgrade-sandboxes [--check] [--auto] [--yes|-y]");
    expect(upgrade.out).toContain("Detect and rebuild stale sandboxes");

    const gc = run("gc --help");
    expect(gc.code).toBe(0);
    expect(gc.out).toContain("gc [--dry-run] [--yes|-y|--force]");
    expect(gc.out).toContain("Remove orphaned sandbox Docker images");
  });

  it("maintenance commands dispatch through oclif", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-maintenance-"));
    const localBin = path.join(home, "bin");
    fs.mkdirSync(localBin, { recursive: true });
    fs.writeFileSync(
      path.join(localBin, "docker"),
      ["#!/bin/sh", 'if [ "$1" = "images" ]; then exit 0; fi', "exit 0"].join("\n"),
      { mode: 0o755 },
    );

    const backup = runWithEnv("backup-all", { HOME: home });
    expect(backup.code).toBe(0);
    expect(backup.out).toContain("No sandboxes registered. Nothing to back up.");

    const upgrade = runWithEnv("upgrade-sandboxes --check", { HOME: home });
    expect(upgrade.code).toBe(0);
    expect(upgrade.out).toContain("No sandboxes found in the registry.");

    const gc = runWithEnv("gc --dry-run", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });
    expect(gc.code).toBe(0);
    expect(gc.out).toContain("No sandbox images found on the host.");
  });
});
