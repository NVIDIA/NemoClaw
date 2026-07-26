// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const LAUNCHABLE = path.join(REPO_ROOT, "scripts", "brev-launchable-ci-cpu.sh");

function resolveLaunchableVersion(options: { channel: string; explicit?: string }) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-launchable-channel-"));
  const fakeBin = path.join(tempDir, "bin");
  fs.mkdirSync(fakeBin);
  const getent = path.join(fakeBin, "getent");
  fs.writeFileSync(
    getent,
    "#!/usr/bin/env bash\nprintf 'tester:x:501:20:tester:%s:/bin/bash\\n' \"$HOME\"\n",
    { encoding: "utf8", mode: 0o755 },
  );
  try {
    return spawnSync("bash", [LAUNCHABLE, "--print-openshell-version"], {
      encoding: "utf8",
      env: {
        HOME: tempDir,
        LAUNCH_LOG: path.join(tempDir, "launch.log"),
        LOGNAME: "tester",
        NEMOCLAW_OPENSHELL_CHANNEL: options.channel,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        SUDO_USER: "tester",
        USER: "tester",
        ...(options.explicit === undefined ? {} : { OPENSHELL_VERSION: options.explicit }),
      },
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function runLaunchableDevGate() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-launchable-dev-gate-"));
  try {
    return spawnSync("bash", [LAUNCHABLE], {
      encoding: "utf8",
      env: {
        HOME: tempDir,
        LAUNCH_LOG: path.join(tempDir, "launch.log"),
        LOGNAME: "tester",
        NEMOCLAW_OPENSHELL_CHANNEL: "dev",
        PATH: "/usr/bin:/bin",
        SUDO_USER: "tester",
        USER: "tester",
      },
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

describe("OpenShell channel workflow boundary", () => {
  it.each([
    { channel: "dev", expected: "dev" },
    { channel: "stable", expected: "v0.0.85" },
    { channel: "auto", expected: "v0.0.85" },
    { channel: "dev", explicit: "v9.9.9", expected: "v9.9.9" },
  ])("resolves launchable channel $channel to $expected", ({ channel, explicit, expected }) => {
    const result = resolveLaunchableVersion({ channel, explicit });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout.trim()).toBe(expected);
  });

  it("rejects an invalid launchable channel", () => {
    const result = resolveLaunchableVersion({ channel: "artifact" });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "NEMOCLAW_OPENSHELL_CHANNEL must be one of: stable, dev, auto",
    );
  });

  it("requires explicit opt-in before a launchable consumes unverified dev artifacts", () => {
    const result = runLaunchableDevGate();
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "NEMOCLAW_ACCEPT_DEV_UNVERIFIED_INSTALL=1",
    );

    const source = fs.readFileSync(LAUNCHABLE, "utf8");
    expect(source).toContain(
      'if [[ "$OPENSHELL_VERSION" != "dev" ]]; then\n    verify_openshell_cli_asset',
    );
  });
});
