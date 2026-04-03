// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const INSTALL_OPEN_SHELL = path.join(import.meta.dirname, "..", "scripts", "install-openshell.sh");
const TEST_SYSTEM_PATH = "/usr/bin:/bin";

function writeExecutable(target, contents) {
  fs.writeFileSync(target, contents, { mode: 0o755 });
}

describe("install-openshell.sh", () => {
  it("uses the blueprint minimum version when no override is provided", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-openshell-blueprint-"));
    const fakeBin = path.join(tmp, "bin");
    fs.mkdirSync(fakeBin);

    writeExecutable(
      path.join(fakeBin, "openshell"),
      `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  echo "openshell 0.0.24"
  exit 0
fi
exit 0
`,
    );

    const result = spawnSync("bash", [INSTALL_OPEN_SHELL], {
      cwd: path.join(import.meta.dirname, ".."),
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmp,
        PATH: `${fakeBin}:${TEST_SYSTEM_PATH}`,
      },
    });

    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/openshell already installed: 0\.0\.24 \(>= 0\.0\.24\)/);
  });

  it("honors an explicit minimum-version override from the caller", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-openshell-override-"));
    const fakeBin = path.join(tmp, "bin");
    fs.mkdirSync(fakeBin);

    writeExecutable(
      path.join(fakeBin, "openshell"),
      `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  echo "openshell 0.0.21"
  exit 0
fi
exit 0
`,
    );

    const result = spawnSync("bash", [INSTALL_OPEN_SHELL], {
      cwd: path.join(import.meta.dirname, ".."),
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmp,
        PATH: `${fakeBin}:${TEST_SYSTEM_PATH}`,
        NEMOCLAW_MIN_OPENSHELL_VERSION: "0.0.20",
      },
    });

    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/openshell already installed: 0\.0\.21 \(>= 0\.0\.20\)/);
  });
});
