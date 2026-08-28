// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const INSTALLER_PAYLOAD = path.join(import.meta.dirname, "../..", "scripts", "install.sh");
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
    cwd: cwd ?? path.join(import.meta.dirname, "../.."),
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

/**
 * Builds an install tree where the active npm prefix bin has no CLI but the
 * user-local shim is present and working, and the shim directory is absent
 * from PATH. Callers that need the no-shim control remove `shimPath`.
 */
function createStaleNpmPrefixTree(): {
  tmp: string;
  fakeBin: string;
  prefix: string;
  shimPath: string;
} {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-shim-probe-"));
  const fakeBin = path.join(tmp, "bin");
  const prefix = path.join(tmp, "prefix");
  const shimPath = path.join(tmp, ".local", "bin", "nemoclaw");

  fs.mkdirSync(fakeBin);
  fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });
  fs.mkdirSync(path.dirname(shimPath), { recursive: true });

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
if [ "$1" = "uninstall" ] && [ "$2" = "-g" ] && [ "$3" = "nemoclaw" ] && [ -n "$NPM_UNINSTALL_TARGET" ]; then
  rm -f -- "$NPM_UNINSTALL_TARGET"
  exit 0
fi
exit 99
`,
  );
  writeExecutable(
    shimPath,
    `#!/usr/bin/env bash
echo "nemoclaw v0.1.0"
`,
  );

  return { tmp, fakeBin, prefix, shimPath };
}

function runVerifyNemoclaw(
  tree: ReturnType<typeof createStaleNpmPrefixTree>,
  extraEnv: Record<string, string> = {},
) {
  return runInstallerFunction(
    "_CLI_BIN=nemoclaw; verify_nemoclaw; " +
      "printf 'CLI_PATH=%s\\nREFRESH=%s\\nREADY=%s\\n' " +
      '"$_CLI_PATH" "$NEMOCLAW_CURRENT_SHELL_NEEDS_PATH_REFRESH" "$NEMOCLAW_READY_NOW"',
    tree.fakeBin,
    {
      ACTIVE_NPM_PREFIX: tree.prefix,
      HOME: tree.tmp,
      NPM_UNINSTALL_TARGET: "",
      ...extraEnv,
    },
  );
}

describe("installer npm resolution", () => {
  it("keeps an existing user-local npm PATH stable when fixing permissions", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-npm-path-"));
    const fakeBin = path.join(tmp, "bin");
    const npmBin = path.join(tmp, ".npm-global", "bin");
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.mkdirSync(npmBin, { recursive: true });
    writeExecutable(path.join(fakeBin, "uname"), "#!/usr/bin/env bash\nprintf 'Linux\\n'\n");
    writeExecutable(
      path.join(fakeBin, "npm"),
      '#!/usr/bin/env bash\nif [[ "$*" == "config get prefix" ]]; then printf \'/System/nemoclaw\\n\'; fi\n',
    );
    const initialPath = [npmBin, fakeBin, TEST_SYSTEM_PATH].join(path.delimiter);
    const result = runInstallerFunction('fix_npm_permissions; printf "%s\\n" "$PATH"', fakeBin, {
      HOME: tmp,
      PATH: initialPath,
    });

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout.trim().split("\n").at(-1)).toBe(initialPath);
  });

  it.each(["nemoclaw", "nemohermes", "nemo-deepagents"])(
    "creates user-local shims for every packaged CLI alias during the default install path [%s]",
    (cliBin) => {
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
      ["nemoclaw", "nemohermes", "nemo-deepagents"].forEach((cliBin) => {
        writeExecutable(
          path.join(prefixBin, cliBin),
          `#!/usr/bin/env bash
echo "${cliBin} v0.1.0"
`,
        );
      });

      const result = runInstallerFunction(
        '_CLI_BIN=nemoclaw; ensure_nemoclaw_shim; for name in nemoclaw nemohermes nemo-deepagents; do test -x "$NEMOCLAW_SHIM_DIR/$name"; done',
        fakeBin,
        {
          ACTIVE_NPM_PREFIX: prefix,
          HOME: tmp,
        },
      );

      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);

      expect(
        normalizeShellPathForAssert(
          fs.readFileSync(path.join(tmp, ".local", "bin", cliBin), "utf-8"),
        ),
      ).toContain(normalizeShellPathForAssert(path.join(prefixBin, cliBin)));
    },
  );

  it("keeps PATH stable only when the generated shim resolves its selected Node", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-stable-shim-path-"));
    const fakeBin = path.join(tmp, "bin");
    const prefix = path.join(tmp, "prefix");
    const prefixBin = path.join(prefix, "bin");
    fs.mkdirSync(fakeBin);
    fs.mkdirSync(prefixBin, { recursive: true });

    writeExecutable(path.join(fakeBin, "node"), "#!/usr/bin/env bash\nexit 0\n");
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
    writeExecutable(
      path.join(prefixBin, "nemoclaw"),
      "#!/usr/bin/env bash\nprintf '%s\\n' \"$PATH\"\n",
    );
    const initialPath = [path.join(tmp, "first"), fakeBin, TEST_SYSTEM_PATH].join(path.delimiter);
    const create = runInstallerFunction('_CLI_BIN=nemoclaw; ensure_cli_shim "nemoclaw"', fakeBin, {
      ACTIVE_NPM_PREFIX: prefix,
      HOME: tmp,
      PATH: initialPath,
    });
    expect(create.status, `${create.stdout}${create.stderr}`).toBe(0);

    const shimPath = path.join(tmp, ".local", "bin", "nemoclaw");
    const existingNodePath = spawnSync(BASH_BIN, [shimPath], {
      encoding: "utf-8",
      env: { ...process.env, HOME: tmp, PATH: initialPath },
    });
    expect(existingNodePath.status, `${existingNodePath.stdout}${existingNodePath.stderr}`).toBe(0);
    expect(existingNodePath.stdout.trim()).toBe(initialPath);

    const shadowBin = path.join(tmp, "shadow-bin");
    fs.mkdirSync(shadowBin);
    writeExecutable(path.join(shadowBin, "node"), "#!/usr/bin/env bash\nexit 0\n");
    const shadowedPath = `${shadowBin}${path.delimiter}${initialPath}`;
    const repairedShadowedPath = spawnSync(BASH_BIN, [shimPath], {
      encoding: "utf-8",
      env: { ...process.env, HOME: tmp, PATH: shadowedPath },
    });
    expect(
      repairedShadowedPath.status,
      `${repairedShadowedPath.stdout}${repairedShadowedPath.stderr}`,
    ).toBe(0);
    expect(repairedShadowedPath.stdout.trim()).toBe(`${fakeBin}${path.delimiter}${shadowedPath}`);

    const missingNodePath = TEST_SYSTEM_PATH;
    const repairedNodePath = spawnSync(BASH_BIN, [shimPath], {
      encoding: "utf-8",
      env: { ...process.env, HOME: tmp, PATH: missingNodePath },
    });
    expect(repairedNodePath.status, `${repairedNodePath.stdout}${repairedNodePath.stderr}`).toBe(0);
    expect(repairedNodePath.stdout.trim()).toBe(`${fakeBin}${path.delimiter}${missingNodePath}`);
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

  it("verifies through the user-local shim when the active npm prefix has no CLI (#8311)", () => {
    const tree = createStaleNpmPrefixTree();

    const result = runVerifyNemoclaw(tree);

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(normalizeShellPathForAssert(result.stdout)).toContain(
      `CLI_PATH=${normalizeShellPathForAssert(tree.shimPath)}`,
    );
    expect(result.stdout).toContain("REFRESH=true");
    expect(result.stdout).toContain("READY=false");
  });

  it("keeps the PATH-refresh hint when a rejected binary still shadows the shim (#8311)", () => {
    const tree = createStaleNpmPrefixTree();
    writeExecutable(
      path.join(tree.fakeBin, "nemoclaw"),
      `#!/usr/bin/env bash
echo "placeholder package"
`,
    );

    const result = runVerifyNemoclaw(tree, {
      PATH: [tree.fakeBin, path.dirname(tree.shimPath), TEST_SYSTEM_PATH].join(path.delimiter),
    });

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(normalizeShellPathForAssert(result.stdout)).toContain(
      `CLI_PATH=${normalizeShellPathForAssert(tree.shimPath)}`,
    );
    expect(result.stdout).toContain("REFRESH=true");
    expect(result.stdout).toContain("READY=false");
  });

  it("reports the CLI as ready when the shim itself resolves on PATH (#8311)", () => {
    const tree = createStaleNpmPrefixTree();

    const result = runVerifyNemoclaw(tree, {
      PATH: [path.dirname(tree.shimPath), tree.fakeBin, TEST_SYSTEM_PATH].join(path.delimiter),
    });

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(normalizeShellPathForAssert(result.stdout)).toContain(
      `CLI_PATH=${normalizeShellPathForAssert(tree.shimPath)}`,
    );
    expect(result.stdout).toContain("READY=true");
    expect(result.stdout).toContain("REFRESH=false");
  });

  it("resolves the CLI name to the user-local shim after npm removes a rejected PATH command (#8311)", () => {
    const tree = createStaleNpmPrefixTree();
    const shadowPath = path.join(tree.fakeBin, "nemoclaw");
    writeExecutable(
      shadowPath,
      `#!/usr/bin/env bash
echo "placeholder package"
`,
    );

    const result = runVerifyNemoclaw(tree, {
      NPM_UNINSTALL_TARGET: shadowPath,
      PATH: [tree.fakeBin, path.dirname(tree.shimPath), TEST_SYSTEM_PATH].join(path.delimiter),
    });

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(fs.existsSync(shadowPath)).toBe(false);
    expect(normalizeShellPathForAssert(result.stdout)).toContain(
      `CLI_PATH=${normalizeShellPathForAssert(tree.shimPath)}`,
    );
    expect(result.stdout).toContain("READY=true");
    expect(result.stdout).toContain("REFRESH=false");
  });

  it("still fails the install when neither the npm prefix nor the shim has a CLI (#8311)", () => {
    const tree = createStaleNpmPrefixTree();
    fs.rmSync(tree.shimPath);

    const result = runVerifyNemoclaw(tree);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("nemoclaw binary not found");
  });
});
