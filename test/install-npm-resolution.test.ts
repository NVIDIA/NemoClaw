// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const INSTALLER_PAYLOAD = path.join(import.meta.dirname, "..", "scripts", "install.sh");

function buildIsolatedSystemPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-npm-sysbin-"));
  const exclude = new Set(["node", "npm", "npx"]);

  for (const sysDir of ["/usr/bin", "/bin"]) {
    if (!fs.existsSync(sysDir)) continue;
    for (const name of fs.readdirSync(sysDir)) {
      if (exclude.has(name)) continue;
      try {
        fs.symlinkSync(path.join(sysDir, name), path.join(dir, name));
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
          continue;
        }
        throw error;
      }
    }
  }

  return dir;
}

const TEST_SYSTEM_PATH = buildIsolatedSystemPath();

function writeExecutable(target: string, contents: string): void {
  fs.writeFileSync(target, contents, { mode: 0o755 });
}

function runInstallerFunction(
  bashSnippet: string,
  fakeBin: string,
  extraEnv: Record<string, string | undefined> = {},
  cwd?: string,
  /** When true, bashSnippet is run verbatim (caller handles sourcing). */
  rawSnippet = false,
) {
  const cmd = rawSnippet
    ? bashSnippet
    : `source "${INSTALLER_PAYLOAD}" >/dev/null 2>&1; ${bashSnippet}`;
  return spawnSync("bash", ["-c", cmd], {
    cwd: cwd ?? path.join(import.meta.dirname, ".."),
    encoding: "utf-8",
    env: {
      ...process.env,
      PATH: `${fakeBin}:${TEST_SYSTEM_PATH}`,
      ...extraEnv,
    },
  });
}

/**
 * Returns true when the test suite is running as root on Linux and should
 * drop privileges for permission-sensitive assertions.
 */
function isLinuxRoot(): boolean {
  return (
    typeof process.getuid === "function" && process.getuid() === 0 && process.platform === "linux"
  );
}

describe("installer npm resolution", () => {
  it("prefers the active npm on PATH over a hostile nvm environment", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-path-npm-"));
    const fakeBin = path.join(tmp, "bin");
    const activePrefix = path.join(tmp, "active-prefix");
    const nvmDir = path.join(tmp, ".nvm");
    const nvmBin = path.join(tmp, "nvm-bin");
    const marker = path.join(tmp, "nvm-sourced");

    fs.mkdirSync(fakeBin);
    fs.mkdirSync(path.join(activePrefix, "bin"), { recursive: true });
    fs.mkdirSync(nvmDir, { recursive: true });
    fs.mkdirSync(nvmBin);

    writeExecutable(
      path.join(fakeBin, "npm"),
      `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "10.9.2"; exit 0; fi
if [ "$1" = "config" ] && [ "$2" = "get" ] && [ "$3" = "prefix" ]; then
  echo "$ACTIVE_NPM_PREFIX"
  exit 0
fi
exit 99
`,
    );

    writeExecutable(
      path.join(nvmBin, "npm"),
      `#!/usr/bin/env bash
if [ "$1" = "config" ] && [ "$2" = "get" ] && [ "$3" = "prefix" ]; then
  echo "$HOSTILE_NPM_PREFIX"
  exit 0
fi
exit 98
`,
    );

    fs.writeFileSync(
      path.join(nvmDir, "nvm.sh"),
      `printf 'sourced\n' > "$NVM_MARKER_PATH"\nexport PATH="$NVM_FAKE_BIN:$PATH"\n`,
    );

    const result = runInstallerFunction("resolve_npm_bin", fakeBin, {
      HOME: tmp,
      NVM_DIR: nvmDir,
      NVM_FAKE_BIN: nvmBin,
      NVM_MARKER_PATH: marker,
      ACTIVE_NPM_PREFIX: activePrefix,
      HOSTILE_NPM_PREFIX: path.join(tmp, "hostile-prefix"),
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(path.join(activePrefix, "bin"));
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("falls back to nvm when npm is missing from PATH", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-nvm-fallback-"));
    const fakeBin = path.join(tmp, "bin");
    const nvmDir = path.join(tmp, ".nvm");
    const nvmBin = path.join(tmp, "nvm-bin");
    const nvmPrefix = path.join(tmp, "nvm-prefix");
    const marker = path.join(tmp, "nvm-sourced");

    fs.mkdirSync(fakeBin);
    fs.mkdirSync(nvmDir, { recursive: true });
    fs.mkdirSync(nvmBin);
    fs.mkdirSync(path.join(nvmPrefix, "bin"), { recursive: true });

    writeExecutable(
      path.join(nvmBin, "npm"),
      `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "10.9.2"; exit 0; fi
if [ "$1" = "config" ] && [ "$2" = "get" ] && [ "$3" = "prefix" ]; then
  echo "$NVM_NPM_PREFIX"
  exit 0
fi
exit 98
`,
    );

    fs.writeFileSync(
      path.join(nvmDir, "nvm.sh"),
      `printf 'sourced\n' > "$NVM_MARKER_PATH"\nexport PATH="$NVM_FAKE_BIN:$PATH"\n`,
    );

    const result = runInstallerFunction("resolve_npm_bin", fakeBin, {
      HOME: tmp,
      NVM_DIR: nvmDir,
      NVM_FAKE_BIN: nvmBin,
      NVM_MARKER_PATH: marker,
      NVM_NPM_PREFIX: nvmPrefix,
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(path.join(nvmPrefix, "bin"));
    expect(fs.readFileSync(marker, "utf-8")).toContain("sourced");
  });

  it("reports npm link targets as unwritable when npm_prefix/lib exists but cannot create node_modules", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-npm-targets-"));
    const fakeBin = path.join(tmp, "bin");
    const prefix = path.join(tmp, "prefix");
    const prefixBin = path.join(prefix, "bin");
    const prefixLib = path.join(prefix, "lib");
    const needsDrop = isLinuxRoot();

    fs.mkdirSync(fakeBin);
    fs.mkdirSync(prefixBin, { recursive: true });
    fs.mkdirSync(prefixLib, { recursive: true });
    fs.chmodSync(tmp, 0o755);
    fs.chmodSync(fakeBin, 0o755);
    // When running as root, we wrap the snippet in `runuser` to drop to
    // nobody so `test -w` behaves like a normal installer user. Make bin
    // world-writable in that mode so the lib directory is the actual blocker.
    fs.chmodSync(prefixBin, needsDrop ? 0o777 : 0o755);
    fs.chmodSync(prefixLib, 0o555);

    const innerSnippet =
      'if npm_link_targets_writable "$TARGET_PREFIX"; then echo WRITABLE; else echo BLOCKED; fi';

    let result;
    if (needsDrop) {
      // WSL does not support setuid via Node's uid/gid spawn options (EACCES).
      // Copy the installer payload into the temp dir (world-readable) and use
      // su to drop to nobody for the permission-sensitive assertion.
      const localPayload = path.join(tmp, "install.sh");
      fs.copyFileSync(INSTALLER_PAYLOAD, localPayload);
      fs.chmodSync(localPayload, 0o644);
      const wrapped = `su -s /bin/bash nobody -c 'source "${localPayload}" >/dev/null 2>&1; ${innerSnippet}'`;
      result = runInstallerFunction(
        wrapped,
        fakeBin,
        {
          HOME: tmp,
          TARGET_PREFIX: prefix,
        },
        tmp,
        true,
      );
    } else {
      result = runInstallerFunction(innerSnippet, fakeBin, {
        HOME: tmp,
        TARGET_PREFIX: prefix,
      });
    }

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("BLOCKED");
  });

  it("reports npm link targets as writable when bin and lib/node_modules are writable", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-npm-targets-"));
    const fakeBin = path.join(tmp, "bin");
    const prefix = path.join(tmp, "prefix");

    fs.mkdirSync(fakeBin);
    fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });
    fs.mkdirSync(path.join(prefix, "lib", "node_modules"), { recursive: true });

    const result = runInstallerFunction(
      'if npm_link_targets_writable "$TARGET_PREFIX"; then echo WRITABLE; else echo BLOCKED; fi',
      fakeBin,
      {
        HOME: tmp,
        TARGET_PREFIX: prefix,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("WRITABLE");
  });
});
