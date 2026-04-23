// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const SCRIPT = path.join(import.meta.dirname, "..", "scripts", "install-openshell.sh");

function writeExecutable(target: string, contents: string) {
  fs.writeFileSync(target, contents, { mode: 0o755 });
}

/**
 * Run install-openshell.sh with a fake `openshell` binary that reports the
 * given version. The download/install code path is never reached because we
 * either exit early (version ok / too high) or hit the upgrade warn and then
 * the script tries to download — so we stub curl and gh to fail fast.
 */
function runWithInstalledVersion(version: string) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-ver-"));
  try {
    const fakeBin = path.join(tmp, "bin");
    fs.mkdirSync(fakeBin);

    // Fake openshell that reports the given version
    writeExecutable(
      path.join(fakeBin, "openshell"),
      `#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then echo "openshell ${version}"; exit 0; fi
exit 99`,
    );

    // Stub curl to fail so the install path exits without doing real network I/O
    writeExecutable(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
echo "curl stub: not available in test" >&2
exit 1`,
    );

    // Stub gh CLI similarly
    writeExecutable(
      path.join(fakeBin, "gh"),
      `#!/usr/bin/env bash
exit 1`,
    );

    return spawnSync("bash", [SCRIPT], {
      env: { ...process.env, PATH: `${fakeBin}:/usr/bin:/bin` },
      encoding: "utf8",
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe("install-openshell.sh version check", () => {
  it("exits cleanly when openshell 0.0.32 is already installed", () => {
    const result = runWithInstalledVersion("0.0.32");
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/already installed.*0\.0\.32/);
  });

  it("triggers upgrade when openshell 0.0.28 is installed (below MIN_VERSION)", () => {
    const result = runWithInstalledVersion("0.0.28");
    // Script should warn about upgrade then fail at the download step (curl stub fails)
    expect(result.status).not.toBe(0);
    expect(result.stdout).toMatch(/below minimum.*upgrading/);
  });

  it("triggers upgrade when openshell 0.0.26 is installed (Landlock-vulnerable version)", () => {
    const result = runWithInstalledVersion("0.0.26");
    expect(result.status).not.toBe(0);
    expect(result.stdout).toMatch(/below minimum.*upgrading/);
  });

  it("triggers upgrade when openshell 0.0.24 is installed (old minimum)", () => {
    const result = runWithInstalledVersion("0.0.24");
    expect(result.status).not.toBe(0);
    expect(result.stdout).toMatch(/below minimum.*upgrading/);
  });

  it("fails with a clear error when openshell is above MAX_VERSION", () => {
    const result = runWithInstalledVersion("0.0.33");
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/above the maximum/);
  });

  it("fails with a clear error when openshell is at a much newer version", () => {
    const result = runWithInstalledVersion("0.1.0");
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/above the maximum/);
  });

  it("exits cleanly when openshell reports m-dev but sidecar records 0.0.32", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-mdev-"));
    try {
      const fakeBin = path.join(tmp, "bin");
      fs.mkdirSync(fakeBin);

      // Fake openshell that reports "m-dev" (as some OpenShell dev builds do)
      writeExecutable(
        path.join(fakeBin, "openshell"),
        `#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then echo "openshell m-dev"; exit 0; fi
exit 99`,
      );

      // Sidecar file written by a previous install
      fs.writeFileSync(path.join(fakeBin, ".openshell-installed-version"), "0.0.32\n");

      writeExecutable(path.join(fakeBin, "curl"), `#!/usr/bin/env bash\nexit 1`);
      writeExecutable(path.join(fakeBin, "gh"), `#!/usr/bin/env bash\nexit 1`);

      const result = spawnSync("bash", [SCRIPT], {
        env: { ...process.env, PATH: `${fakeBin}:/usr/bin:/bin` },
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/already installed.*0\.0\.32/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("triggers upgrade when openshell reports m-dev and sidecar records 0.0.26", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-mdev-old-"));
    try {
      const fakeBin = path.join(tmp, "bin");
      fs.mkdirSync(fakeBin);

      writeExecutable(
        path.join(fakeBin, "openshell"),
        `#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then echo "openshell m-dev"; exit 0; fi
exit 99`,
      );

      // Sidecar from an older install that pre-dates the Landlock fix
      fs.writeFileSync(path.join(fakeBin, ".openshell-installed-version"), "0.0.26\n");

      writeExecutable(
        path.join(fakeBin, "curl"),
        `#!/usr/bin/env bash\necho "curl stub" >&2\nexit 1`,
      );
      writeExecutable(path.join(fakeBin, "gh"), `#!/usr/bin/env bash\nexit 1`);

      const result = spawnSync("bash", [SCRIPT], {
        env: { ...process.env, PATH: `${fakeBin}:/usr/bin:/bin` },
        encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      expect(result.stdout).toMatch(/below minimum.*upgrading/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("proceeds to install when openshell is not present", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-noop-"));
    try {
      const fakeBin = path.join(tmp, "bin");
      fs.mkdirSync(fakeBin);

      // No openshell binary — just stub curl/gh to fail fast
      writeExecutable(
        path.join(fakeBin, "curl"),
        `#!/usr/bin/env bash
echo "curl stub: not available in test" >&2
exit 1`,
      );
      writeExecutable(
        path.join(fakeBin, "gh"),
        `#!/usr/bin/env bash
exit 1`,
      );

      const result = spawnSync("bash", [SCRIPT], {
        env: { ...process.env, PATH: `${fakeBin}:/usr/bin:/bin` },
        encoding: "utf8",
      });

      // Should attempt install (not exit 0 early) and fail at the download step
      expect(result.stdout).toMatch(/Installing openshell CLI/);
      expect(result.status).not.toBe(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
