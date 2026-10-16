// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runOpenshellInstall } from "../../src/lib/onboard/openshell-pin";

// Runs the real onboarding wrapper against a stand-in installer and inspects
// the directories it leaves behind. The sibling command-contract test only
// checks the spawned command line.
describe("runOpenshellInstall user-local directory modes (#12496)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("leaves a fresh ~/.local without group write under umask 0002", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-openshell-umask-"));
    const home = path.join(tmp, "home");
    const scriptsDir = path.join(tmp, "scripts");
    fs.mkdirSync(home);
    fs.mkdirSync(scriptsDir);
    // Stands in for the user-local fallback of install-openshell.sh, which creates ~/.local/bin.
    fs.writeFileSync(
      path.join(scriptsDir, "install-openshell.sh"),
      'mkdir -p "$HOME/.local/bin"\n',
    );
    vi.stubEnv("HOME", home);
    vi.stubEnv("XDG_BIN_HOME", "");

    const previousUmask = process.umask(0o002);
    try {
      runOpenshellInstall({
        getBlueprintMaxOpenshellVersion: () => null,
        versionGte: () => true,
        scriptsDir,
        cwd: tmp,
        resolveOpenshell: () => null,
        getFutureShellPathHint: () => null,
        setOpenshellBin: () => {},
      });
    } finally {
      process.umask(previousUmask);
    }

    try {
      expect({
        local: fs.statSync(path.join(home, ".local")).mode & 0o777,
        bin: fs.statSync(path.join(home, ".local", "bin")).mode & 0o777,
      }).toEqual({ local: 0o755, bin: 0o755 });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
