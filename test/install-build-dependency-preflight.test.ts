// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeExecutable } from "./helpers/installer-sourced-env";

const INSTALLER = path.join(import.meta.dirname, "..", "install.sh");

function writeNodeStub(fakeBin: string) {
  writeExecutable(
    path.join(fakeBin, "node"),
    `#!/usr/bin/env bash
if [ "$1" = "--version" ] || [ "$1" = "-v" ]; then echo "v22.16.0"; exit 0; fi
if [ -n "\${1:-}" ] && [ -f "$1" ]; then exec ${JSON.stringify(process.execPath)} "$@"; fi
if [ "$1" = "-e" ]; then exec ${JSON.stringify(process.execPath)} "$@"; fi
exit 99`,
  );
}

function writeNpmStub(fakeBin: string, installSnippet = "exit 0") {
  writeExecutable(
    path.join(fakeBin, "npm"),
    `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "--version" ]; then echo "10.9.2"; exit 0; fi
if [ "$1" = "config" ] && [ "$2" = "get" ] && [ "$3" = "prefix" ]; then echo "$NPM_PREFIX"; exit 0; fi
if [ "$1" = "install" ] || [ "$1" = "link" ] || [ "$1" = "uninstall" ] || [ "$1" = "pack" ] || [ "$1" = "run" ]; then
  ${installSnippet}
fi
echo "unexpected npm invocation: $*" >&2; exit 98`,
  );
}

function writeDockerOkStub(fakeBin: string) {
  writeExecutable(
    path.join(fakeBin, "docker"),
    `#!/usr/bin/env bash
if [ "$1" = "info" ]; then
  echo '{"ServerVersion":"29.3.1","OperatingSystem":"Ubuntu 24.04","CgroupVersion":"2"}'
fi
exit 0`,
  );
  writeExecutable(
    path.join(fakeBin, "systemctl"),
    `#!/usr/bin/env bash
if [ "$1" = "is-active" ] && [ "$2" = "docker" ]; then echo "active"; fi
exit 0`,
  );
}

function buildSystemPathWithout(nameToExclude: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-preflight-nodep-"));
  const exclude = new Set(["node", "npm", "npx", nameToExclude]);
  for (const sysDir of ["/usr/bin", "/bin"]) {
    for (const name of (fs.existsSync(sysDir) ? fs.readdirSync(sysDir) : []).filter(
      (entry) => !exclude.has(entry),
    )) {
      try {
        fs.symlinkSync(path.join(sysDir, name), path.join(dir, name));
      } catch (err) {
        (err as NodeJS.ErrnoException).code === "EEXIST" || throwError(err);
      }
    }
  }
  return dir;
}

function throwError(error: unknown): never {
  throw error;
}

function runWithoutStrings(env: Record<string, string> = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-no-strings-"));
  const fakeBin = path.join(tmp, "bin");
  fs.mkdirSync(fakeBin);
  writeNodeStub(fakeBin);
  writeDockerOkStub(fakeBin);
  env.NEMOCLAW_DEFER_OPENSHELL_INSTALL === "1" &&
    (() => {
      writeNpmStub(fakeBin, 'echo "npm stub stop" >&2; exit 91');
      env.NPM_PREFIX = path.join(tmp, "prefix");
    })();
  return spawnSync("bash", [INSTALLER], {
    cwd: path.join(import.meta.dirname, ".."),
    encoding: "utf-8",
    env: {
      ...process.env,
      HOME: tmp,
      PATH: `${fakeBin}:${buildSystemPathWithout("strings")}`,
      NEMOCLAW_NON_INTERACTIVE: "1",
      NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
      ...env,
    },
  });
}

describe("installer build-dependency preflight (#4415)", { timeout: 30_000 }, () => {
  it("fails fast when binutils strings is missing, before clone/build work", () => {
    const result = runWithoutStrings();
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(output).toMatch(/'strings' \(from binutils\) is required/);
    expect(output).toMatch(/sudo apt-get install -y binutils/);
    expect(output).not.toMatch(/Installing OpenShell/);
    expect(output).not.toMatch(/Cloning into/);
  });

  it("does not fire the binutils preflight when OpenShell install is deferred", () => {
    const result = runWithoutStrings({ NEMOCLAW_DEFER_OPENSHELL_INSTALL: "1" });
    expect(`${result.stdout}${result.stderr}`).not.toMatch(
      /'strings' \(from binutils\) is required/,
    );
  });
});
