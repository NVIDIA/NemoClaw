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

function writeNodeForwarder(target: string): void {
  writeExecutable(target, `#!/usr/bin/env bash\nexec ${JSON.stringify(process.execPath)} "$@"\n`);
}

function createPackagedCliTree(prefix: string): {
  fakeBin: string;
  prefixBin: string;
} {
  const fakeBin = path.join(prefix, "bin");
  const prefixBin = path.join(prefix, "prefix", "bin");
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(prefixBin, { recursive: true });

  writeNodeForwarder(path.join(fakeBin, "node"));
  writeExecutable(
    path.join(fakeBin, "npm"),
    `#!/usr/bin/env bash
if [ "$1" = "config" ] && [ "$2" = "get" ] && [ "$3" = "prefix" ]; then
  [ -z "$NPM_CALL_LOG" ] || printf '%s\n' "$*" >> "$NPM_CALL_LOG"
  echo "$ACTIVE_NPM_PREFIX"
  exit 0
fi
[ -z "$NPM_CALL_LOG" ] || printf '%s\n' "$*" >> "$NPM_CALL_LOG"
exit 99
`,
  );
  ["nemoclaw", "nemoclaw-acp", "nemohermes", "nemo-deepagents"].forEach((cliBin) => {
    writeExecutable(
      path.join(prefixBin, cliBin),
      `#!/usr/bin/env bash
echo "${cliBin} v0.1.0"
`,
    );
  });

  return { fakeBin, prefixBin };
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

  it.each(["nemoclaw", "nemoclaw-acp", "nemohermes", "nemo-deepagents"])(
    "creates user-local shims for every packaged CLI alias during the default install path [%s]",
    (cliBin) => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-package-shims-"));
      const fakeBin = path.join(tmp, "bin");
      const prefix = path.join(tmp, "prefix");
      const prefixBin = path.join(prefix, "bin");

      fs.mkdirSync(fakeBin);
      fs.mkdirSync(prefixBin, { recursive: true });

      writeNodeForwarder(path.join(fakeBin, "node"));
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
      ["nemoclaw", "nemoclaw-acp", "nemohermes", "nemo-deepagents"].forEach((cliBin) => {
        writeExecutable(
          path.join(prefixBin, cliBin),
          `#!/usr/bin/env bash
echo "${cliBin} v0.1.0"
`,
        );
      });

      const result = runInstallerFunction(
        '_CLI_BIN=nemoclaw; ensure_nemoclaw_shim; for name in nemoclaw nemoclaw-acp nemohermes nemo-deepagents; do test -x "$NEMOCLAW_SHIM_DIR/$name"; done',
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

  it("leaves a foreign nemoclaw-acp executable untouched and stops before creating sibling shims (#10947)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-acp-collision-"));
    const { fakeBin, prefixBin } = createPackagedCliTree(tmp);
    const shimPath = path.join(tmp, ".local", "bin", "nemoclaw-acp");
    const foreignContents = Buffer.from("#!/usr/bin/env bash\nprintf 'user-owned\\n'\n");
    const foreignMode = 0o755;
    fs.mkdirSync(path.dirname(shimPath), { recursive: true });
    fs.writeFileSync(shimPath, foreignContents, { mode: foreignMode });

    const result = runInstallerFunction("_CLI_BIN=nemoclaw; ensure_nemoclaw_shim", fakeBin, {
      ACTIVE_NPM_PREFIX: path.dirname(prefixBin),
      HOME: tmp,
      NO_COLOR: "1",
    });

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(1);
    expect(fs.readFileSync(shimPath)).toEqual(foreignContents);
    expect(fs.statSync(shimPath).mode & 0o777).toBe(foreignMode);
    expect(fs.existsSync(path.join(tmp, ".local", "bin", "nemoclaw"))).toBe(false);
    expect(`${result.stdout}${result.stderr}`).toContain(
      `${shimPath} already exists and is not a NemoClaw-managed shim`,
    );
    expect(`${result.stdout}${result.stderr}`).toContain("NemoClaw left it unchanged");
  });

  it("stops installation before npm links over a foreign nemoclaw-acp executable (#10947)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-acp-prefix-collision-"));
    const { fakeBin } = createPackagedCliTree(tmp);
    const npmPrefix = path.join(tmp, ".local");
    const shimPath = path.join(npmPrefix, "bin", "nemoclaw-acp");
    const npmCallLog = path.join(tmp, "npm-calls.log");
    const foreignContents = Buffer.from("#!/usr/bin/env bash\nprintf 'user-owned\\n'\n");
    fs.mkdirSync(path.dirname(shimPath), { recursive: true });
    fs.writeFileSync(shimPath, foreignContents, { mode: 0o755 });

    const result = runInstallerFunction("install_nemoclaw", fakeBin, {
      ACTIVE_NPM_PREFIX: npmPrefix,
      HOME: tmp,
      NPM_CALL_LOG: npmCallLog,
      NO_COLOR: "1",
    });

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(1);
    expect(fs.readFileSync(shimPath)).toEqual(foreignContents);
    expect(fs.readFileSync(npmCallLog, "utf-8")).not.toContain("link --ignore-scripts");
    expect(fs.existsSync(path.join(tmp, ".local", "bin", "nemoclaw"))).toBe(false);
    expect(`${result.stdout}${result.stderr}`).toContain(
      `${shimPath} already exists and is not a NemoClaw-managed shim`,
    );
  });

  it("reports npm prefix failure before classifying an existing nemoclaw-acp shim (#10947)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-acp-npm-prefix-"));
    const { fakeBin, prefixBin } = createPackagedCliTree(tmp);
    const shimPath = path.join(tmp, ".local", "bin", "nemoclaw-acp");
    const packagedCli = path.join(prefixBin, "nemoclaw-acp");
    fs.mkdirSync(path.dirname(shimPath), { recursive: true });
    writeExecutable(
      shimPath,
      [
        "#!/usr/bin/env bash",
        `export PATH="${fakeBin}:$PATH"`,
        `exec "${packagedCli}" "$@"`,
        "",
      ].join("\n"),
    );
    writeExecutable(path.join(fakeBin, "npm"), "#!/usr/bin/env bash\nexit 99\n");
    const originalContents = fs.readFileSync(shimPath);

    const result = runInstallerFunction("preflight_nemoclaw_acp_shim", fakeBin, {
      HOME: tmp,
      NO_COLOR: "1",
    });

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(1);
    expect(fs.readFileSync(shimPath)).toEqual(originalContents);
    expect(`${result.stdout}${result.stderr}`).toContain(
      `could not resolve the active npm prefix to verify ${shimPath}`,
    );
    expect(`${result.stdout}${result.stderr}`).not.toContain("is not a NemoClaw-managed shim");
  });

  it.skipIf(process.platform === "win32")(
    "accepts the exact npm-managed nemoclaw-acp link at the user-local prefix (#10947)",
    () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-acp-prefix-link-"));
      const { fakeBin } = createPackagedCliTree(tmp);
      const npmPrefix = path.join(tmp, ".local");
      const shimPath = path.join(npmPrefix, "bin", "nemoclaw-acp");
      fs.mkdirSync(path.dirname(shimPath), { recursive: true });
      fs.symlinkSync("../lib/node_modules/nemoclaw/dist/lib/acp/main.js", shimPath);

      const result = runInstallerFunction("preflight_nemoclaw_acp_shim", fakeBin, {
        ACTIVE_NPM_PREFIX: npmPrefix,
        HOME: tmp,
        NO_COLOR: "1",
      });

      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(fs.readlinkSync(shimPath)).toBe("../lib/node_modules/nemoclaw/dist/lib/acp/main.js");
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects an npm-managed nemoclaw-acp link from an inactive prefix (#10947)",
    () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-acp-stale-prefix-"));
      const { fakeBin, prefixBin } = createPackagedCliTree(tmp);
      const shimPath = path.join(tmp, ".local", "bin", "nemoclaw-acp");
      fs.mkdirSync(path.dirname(shimPath), { recursive: true });
      fs.symlinkSync("../lib/node_modules/nemoclaw/dist/lib/acp/main.js", shimPath);

      const result = runInstallerFunction("preflight_nemoclaw_acp_shim", fakeBin, {
        ACTIVE_NPM_PREFIX: path.dirname(prefixBin),
        HOME: tmp,
        NO_COLOR: "1",
      });

      expect(result.status, `${result.stdout}${result.stderr}`).toBe(1);
      expect(fs.readlinkSync(shimPath)).toBe("../lib/node_modules/nemoclaw/dist/lib/acp/main.js");
      expect(`${result.stdout}${result.stderr}`).toContain(
        `${shimPath} already exists and is not a NemoClaw-managed shim`,
      );
      expect(`${result.stdout}${result.stderr}`).toContain("NemoClaw left it unchanged");
    },
  );

  it.skipIf(process.platform === "win32")(
    "leaves a foreign nemoclaw-acp symbolic link and its target untouched (#10947)",
    () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-acp-link-collision-"));
      const { fakeBin, prefixBin } = createPackagedCliTree(tmp);
      const shimPath = path.join(tmp, ".local", "bin", "nemoclaw-acp");
      const targetPath = path.join(tmp, "user-command");
      const foreignContents = Buffer.from("#!/usr/bin/env bash\nprintf 'user-owned\\n'\n");
      fs.mkdirSync(path.dirname(shimPath), { recursive: true });
      fs.writeFileSync(targetPath, foreignContents, { mode: 0o755 });
      fs.symlinkSync(targetPath, shimPath);

      const result = runInstallerFunction('ensure_cli_shim "nemoclaw-acp"', fakeBin, {
        ACTIVE_NPM_PREFIX: path.dirname(prefixBin),
        HOME: tmp,
        NO_COLOR: "1",
      });

      expect(result.status, `${result.stdout}${result.stderr}`).toBe(1);
      expect(fs.lstatSync(shimPath).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(shimPath)).toBe(targetPath);
      expect(fs.readFileSync(targetPath)).toEqual(foreignContents);
      expect(`${result.stdout}${result.stderr}`).toContain("NemoClaw left it unchanged");
    },
  );

  it("rejects an unverified three-line nemoclaw-acp wrapper (#10947)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-acp-ambiguous-shim-"));
    const { fakeBin, prefixBin } = createPackagedCliTree(tmp);
    const shimPath = path.join(tmp, ".local", "bin", "nemoclaw-acp");
    const foreignBin = path.join(tmp, "foreign", "bin");
    const foreignCli = path.join(foreignBin, "nemoclaw-acp");
    fs.mkdirSync(path.dirname(shimPath), { recursive: true });
    fs.mkdirSync(foreignBin, { recursive: true });
    writeExecutable(foreignCli, "#!/usr/bin/env bash\nprintf 'user-owned\\n'\n");
    writeExecutable(
      shimPath,
      [
        "#!/usr/bin/env bash",
        '[[ "$(command -v node 2>/dev/null)" == "/old/node/bin/node" ]] || export PATH="/old/node/bin:$PATH"',
        `exec "${foreignCli}" "$@"`,
        "",
      ].join("\n"),
    );
    const originalContents = fs.readFileSync(shimPath);

    const result = runInstallerFunction("_CLI_BIN=nemoclaw; ensure_nemoclaw_shim", fakeBin, {
      ACTIVE_NPM_PREFIX: path.dirname(prefixBin),
      HOME: tmp,
      NO_COLOR: "1",
    });

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(1);
    expect(fs.readFileSync(shimPath)).toEqual(originalContents);
    expect(`${result.stdout}${result.stderr}`).toContain(
      `${shimPath} already exists and is not a NemoClaw-managed shim`,
    );
  });

  it("keeps the current nemoclaw-acp wrapper that targets the packaged executable (#10947)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-acp-managed-shim-"));
    const { fakeBin, prefixBin } = createPackagedCliTree(tmp);
    const shimPath = path.join(tmp, ".local", "bin", "nemoclaw-acp");
    const packagedCli = path.join(prefixBin, "nemoclaw-acp");
    fs.mkdirSync(path.dirname(shimPath), { recursive: true });
    writeExecutable(
      shimPath,
      [
        "#!/usr/bin/env bash",
        `[[ "$(command -v node 2>/dev/null)" == "${path.join(fakeBin, "node")}" ]] || export PATH="${fakeBin}:$PATH"`,
        `exec "${packagedCli}" "$@"`,
        "",
      ].join("\n"),
    );
    const originalContents = fs.readFileSync(shimPath);

    const result = runInstallerFunction(
      'ensure_cli_shim "nemoclaw-acp"; "$NEMOCLAW_SHIM_DIR/nemoclaw-acp" --version',
      fakeBin,
      {
        ACTIVE_NPM_PREFIX: path.dirname(prefixBin),
        HOME: tmp,
        NO_COLOR: "1",
      },
    );

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(fs.readFileSync(shimPath)).toEqual(originalContents);
    expect(result.stdout).toContain("nemoclaw-acp v0.1.0");
  });

  it("refreshes a managed nemoclaw-acp wrapper for the selected Node.js runtime (#10947)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-acp-stale-node-"));
    const { fakeBin, prefixBin } = createPackagedCliTree(tmp);
    const shimPath = path.join(tmp, ".local", "bin", "nemoclaw-acp");
    const packagedCli = path.join(prefixBin, "nemoclaw-acp");
    fs.mkdirSync(path.dirname(shimPath), { recursive: true });
    writeExecutable(packagedCli, "#!/usr/bin/env node\nconsole.log('nemoclaw-acp v0.1.0');\n");
    writeExecutable(
      shimPath,
      [
        "#!/usr/bin/env bash",
        '[[ "$(command -v node 2>/dev/null)" == "/removed/node/bin/node" ]] || export PATH="/removed/node/bin:$PATH"',
        `exec "${packagedCli}" "$@"`,
        "",
      ].join("\n"),
    );
    const originalContents = fs.readFileSync(shimPath);

    const result = runInstallerFunction(
      '_CLI_BIN=nemoclaw; ensure_nemoclaw_shim; PATH="$TEST_SYSTEM_PATH" "$NEMOCLAW_SHIM_DIR/nemoclaw-acp"',
      fakeBin,
      {
        ACTIVE_NPM_PREFIX: path.dirname(prefixBin),
        HOME: tmp,
        NO_COLOR: "1",
        TEST_SYSTEM_PATH,
      },
    );

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(fs.readFileSync(shimPath)).not.toEqual(originalContents);
    expect(fs.readFileSync(shimPath, "utf-8")).toContain(path.join(fakeBin, "node"));
    expect(result.stdout).toContain("nemoclaw-acp v0.1.0");
  });

  it.skipIf(process.platform === "win32")(
    "preserves a foreign path raced into place during managed ACP shim refresh (#10947)",
    () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-acp-refresh-race-"));
      const { fakeBin, prefixBin } = createPackagedCliTree(tmp);
      const shimPath = path.join(tmp, ".local", "bin", "nemoclaw-acp");
      const packagedCli = path.join(prefixBin, "nemoclaw-acp");
      const foreignPath = path.join(tmp, "user-command");
      const foreignContents = Buffer.from("#!/usr/bin/env bash\nprintf 'user-owned\\n'\n");
      fs.mkdirSync(path.dirname(shimPath), { recursive: true });
      fs.writeFileSync(foreignPath, foreignContents, { mode: 0o755 });
      writeExecutable(
        shimPath,
        [
          "#!/usr/bin/env bash",
          '[[ "$(command -v node 2>/dev/null)" == "/removed/node/bin/node" ]] || export PATH="/removed/node/bin:$PATH"',
          `exec "${packagedCli}" "$@"`,
          "",
        ].join("\n"),
      );
      fs.unlinkSync(path.join(fakeBin, "node"));
      writeExecutable(
        path.join(fakeBin, "node"),
        `#!/usr/bin/env bash
rm -f "$RACE_SHIM_PATH"
ln -s "$RACE_FOREIGN_PATH" "$RACE_SHIM_PATH"
exec ${JSON.stringify(process.execPath)} "$@"
`,
      );

      const result = runInstallerFunction('ensure_cli_shim "nemoclaw-acp"', fakeBin, {
        ACTIVE_NPM_PREFIX: path.dirname(prefixBin),
        HOME: tmp,
        NO_COLOR: "1",
        RACE_FOREIGN_PATH: foreignPath,
        RACE_SHIM_PATH: shimPath,
      });

      expect(result.status, `${result.stdout}${result.stderr}`).toBe(1);
      expect(fs.lstatSync(shimPath).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(shimPath)).toBe(foreignPath);
      expect(fs.readFileSync(foreignPath)).toEqual(foreignContents);
      expect(`${result.stdout}${result.stderr}`).toContain(`could not safely refresh ${shimPath}`);
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps a packaged nemoclaw-acp executable reached through a symlinked directory (#10947)",
    () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-acp-same-file-"));
      const { fakeBin, prefixBin } = createPackagedCliTree(tmp);
      const shimDir = path.join(tmp, ".local", "bin");
      const packagedCli = path.join(prefixBin, "nemoclaw-acp");
      const originalContents = fs.readFileSync(packagedCli);
      fs.mkdirSync(path.dirname(shimDir), { recursive: true });
      fs.symlinkSync(prefixBin, shimDir, "dir");

      const result = runInstallerFunction('ensure_cli_shim "nemoclaw-acp"', fakeBin, {
        ACTIVE_NPM_PREFIX: path.dirname(prefixBin),
        HOME: tmp,
        NO_COLOR: "1",
      });

      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(fs.readFileSync(packagedCli)).toEqual(originalContents);
      expect(fs.realpathSync(path.join(shimDir, "nemoclaw-acp"))).toBe(
        fs.realpathSync(packagedCli),
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "stops when nemoclaw-acp changes after validation and preserves the replacement target (#10947)",
    () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-acp-swap-"));
      const { fakeBin, prefixBin } = createPackagedCliTree(tmp);
      const shimPath = path.join(tmp, ".local", "bin", "nemoclaw-acp");
      const packagedCli = path.join(prefixBin, "nemoclaw-acp");
      const targetPath = path.join(tmp, "user-command");
      const foreignContents = Buffer.from("#!/usr/bin/env bash\nprintf 'user-owned\\n'\n");
      fs.mkdirSync(path.dirname(shimPath), { recursive: true });
      fs.writeFileSync(targetPath, foreignContents, { mode: 0o755 });
      writeExecutable(
        shimPath,
        [
          "#!/usr/bin/env bash",
          `[[ "$(command -v node 2>/dev/null)" == "${path.join(fakeBin, "node")}" ]] || export PATH="${fakeBin}:$PATH"`,
          `exec "${packagedCli}" "$@"`,
          "",
        ].join("\n"),
      );

      const result = runInstallerFunction(
        `shim_path=${JSON.stringify(shimPath)}
swap_target=${JSON.stringify(targetPath)}
identity_calls=${JSON.stringify(path.join(tmp, "identity-calls"))}
eval "$(declare -f cli_shim_entry_identity | sed '1s/cli_shim_entry_identity/original_cli_shim_entry_identity/')"
cli_shim_entry_identity() {
  local count=0
  [[ ! -f "$identity_calls" ]] || count="$(cat "$identity_calls")"
  count=$((count + 1))
  printf '%s\\n' "$count" >"$identity_calls"
  if [[ "$count" -eq 3 ]]; then
    rm -f "$shim_path"
    ln -s "$swap_target" "$shim_path"
  fi
  original_cli_shim_entry_identity "$@"
}
ensure_cli_shim "nemoclaw-acp"`,
        fakeBin,
        {
          ACTIVE_NPM_PREFIX: path.dirname(prefixBin),
          HOME: tmp,
          NO_COLOR: "1",
        },
      );

      expect(result.status, `${result.stdout}${result.stderr}`).toBe(1);
      expect(fs.lstatSync(shimPath).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(shimPath)).toBe(targetPath);
      expect(fs.readFileSync(targetPath)).toEqual(foreignContents);
      expect(
        fs.readdirSync(path.dirname(shimPath)).filter((name) => name.includes(".tmp.")).length,
      ).toBe(0);
      const output = `${result.stdout}${result.stderr}`;
      expect(output).toContain(shimPath);
      expect(output).toMatch(
        /(?:changed while NemoClaw prepared its shim|is no longer a NemoClaw-managed shim)/,
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "stops when nemoclaw-acp appears during publication and preserves that entry (#10947)",
    () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-acp-publish-race-"));
      const { fakeBin, prefixBin } = createPackagedCliTree(tmp);
      const shimPath = path.join(tmp, ".local", "bin", "nemoclaw-acp");
      const replacementPath = path.join(tmp, "user-command");
      const foreignContents = Buffer.from("#!/usr/bin/env bash\nprintf 'user-owned\\n'\n");
      fs.mkdirSync(path.dirname(shimPath), { recursive: true });
      fs.writeFileSync(replacementPath, foreignContents, { mode: 0o755 });

      const result = runInstallerFunction(
        `shim_path=${JSON.stringify(shimPath)}
replacement_path=${JSON.stringify(replacementPath)}
eval "$(declare -f publish_cli_shim_no_clobber | sed '1s/publish_cli_shim_no_clobber/original_publish_cli_shim_no_clobber/')"
publish_cli_shim_no_clobber() {
  command ln "$replacement_path" "$shim_path"
  original_publish_cli_shim_no_clobber "$@"
}
ensure_cli_shim "nemoclaw-acp"`,
        fakeBin,
        {
          ACTIVE_NPM_PREFIX: path.dirname(prefixBin),
          HOME: tmp,
          NO_COLOR: "1",
        },
      );

      expect(result.status, `${result.stdout}${result.stderr}`).toBe(1);
      expect(fs.readFileSync(shimPath)).toEqual(foreignContents);
      expect(
        fs.readdirSync(path.dirname(shimPath)).filter((name) => name.includes(".tmp.")).length,
      ).toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain(
        `${shimPath} changed while NemoClaw published its shim`,
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "stops when a directory symlink appears during nemoclaw-acp publication (#10947)",
    () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-acp-dir-race-"));
      const { fakeBin, prefixBin } = createPackagedCliTree(tmp);
      const shimPath = path.join(tmp, ".local", "bin", "nemoclaw-acp");
      const replacementDir = path.join(tmp, "user-directory");
      fs.mkdirSync(path.dirname(shimPath), { recursive: true });
      fs.mkdirSync(replacementDir);

      const result = runInstallerFunction(
        `shim_path=${JSON.stringify(shimPath)}
replacement_dir=${JSON.stringify(replacementDir)}
eval "$(declare -f publish_cli_shim_no_clobber | sed '1s/publish_cli_shim_no_clobber/original_publish_cli_shim_no_clobber/')"
publish_cli_shim_no_clobber() {
  command ln -s "$replacement_dir" "$shim_path"
  original_publish_cli_shim_no_clobber "$@"
}
ensure_cli_shim "nemoclaw-acp"`,
        fakeBin,
        {
          ACTIVE_NPM_PREFIX: path.dirname(prefixBin),
          HOME: tmp,
          NO_COLOR: "1",
        },
      );

      expect(result.status, `${result.stdout}${result.stderr}`).toBe(1);
      expect(fs.lstatSync(shimPath).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(shimPath)).toBe(replacementDir);
      expect(fs.readdirSync(replacementDir)).toEqual([]);
      expect(
        fs.readdirSync(path.dirname(shimPath)).filter((name) => name.includes(".tmp.")).length,
      ).toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain(
        `${shimPath} changed while NemoClaw published its shim`,
      );
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
