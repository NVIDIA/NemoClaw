// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const INSTALLER_PAYLOAD = path.join(import.meta.dirname, "..", "scripts", "install.sh");
const BASH_BIN = resolveBashBin();

function resolveBashBin(): string {
  const whereResult =
    process.platform === "win32" ? spawnSync("where.exe", ["bash"], { encoding: "utf-8" }) : null;
  const firstWindowsBash =
    typeof whereResult?.stdout === "string"
      ? whereResult.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find(Boolean)
      : undefined;
  return firstWindowsBash ?? "bash";
}

function systemBinDirs(): string[] {
  return [
    "/usr/bin",
    "/bin",
    ...(process.platform === "win32" && path.isAbsolute(BASH_BIN) ? [path.dirname(BASH_BIN)] : []),
  ];
}

function buildIsolatedSystemPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-npm-sysbin-"));
  const exclude = new Set(["node", "npm", "npx"]);

  for (const sysDir of systemBinDirs()) {
    if (!fs.existsSync(sysDir)) continue;
    for (const name of fs.readdirSync(sysDir)) {
      if (exclude.has(name)) continue;
      try {
        fs.symlinkSync(path.join(sysDir, name), path.join(dir, name));
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          (error.code === "EEXIST" ||
            (process.platform === "win32" && (error.code === "EPERM" || error.code === "EACCES")))
        ) {
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

function normalizeShellPathForAssert(value: string): string {
  return value.replace(/\\/g, "/");
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
  return spawnSync(BASH_BIN, ["-c", cmd], {
    cwd: cwd ?? path.join(import.meta.dirname, ".."),
    encoding: "utf-8",
    env: {
      ...process.env,
      PATH: [fakeBin, TEST_SYSTEM_PATH].join(path.delimiter),
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
  it("creates user-local shims for every packaged CLI alias during the default install path", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-package-shims-"));
    const fakeBin = path.join(tmp, "bin");
    const prefix = path.join(tmp, "prefix");
    const prefixBin = path.join(prefix, "bin");

    fs.mkdirSync(fakeBin);
    fs.mkdirSync(prefixBin, { recursive: true });

    writeExecutable(
      path.join(fakeBin, "node"),
      `#!/usr/bin/env bash
exit 0
`,
    );
    writeExecutable(
      path.join(fakeBin, "npm"),
      `#!/usr/bin/env bash
if [ "$1" = "config" ] && [ "$2" = "get" ] && [ "$3" = "prefix" ]; then
  echo "$ACTIVE_NPM_PREFIX"
  exit 0
fi
exit 99
`,
    );
    for (const cliBin of ["nemoclaw", "nemohermes", "nemo-deepagents"]) {
      writeExecutable(
        path.join(prefixBin, cliBin),
        `#!/usr/bin/env bash
echo "${cliBin} v0.1.0"
`,
      );
    }

    const result = runInstallerFunction(
      '_CLI_BIN=nemoclaw; ensure_nemoclaw_shim; for name in nemoclaw nemohermes nemo-deepagents; do test -x "$NEMOCLAW_SHIM_DIR/$name"; done',
      fakeBin,
      {
        ACTIVE_NPM_PREFIX: prefix,
        HOME: tmp,
      },
    );

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    for (const cliBin of ["nemoclaw", "nemohermes", "nemo-deepagents"]) {
      expect(
        normalizeShellPathForAssert(
          fs.readFileSync(path.join(tmp, ".local", "bin", cliBin), "utf-8"),
        ),
      ).toContain(normalizeShellPathForAssert(path.join(prefixBin, cliBin)));
    }
  });

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
    expect(normalizeShellPathForAssert(result.stdout.trim())).toBe(
      normalizeShellPathForAssert(path.join(activePrefix, "bin")),
    );
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
    expect(normalizeShellPathForAssert(result.stdout.trim())).toBe(
      normalizeShellPathForAssert(path.join(nvmPrefix, "bin")),
    );
    expect(fs.readFileSync(marker, "utf-8")).toContain("sourced");
  });

  it.skipIf(process.platform === "win32")(
    "reports npm link targets as unwritable when npm_prefix/lib exists but cannot create node_modules",
    () => {
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
    },
  );

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
