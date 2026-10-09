// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO_ROOT = path.join(import.meta.dirname, "../../..");
const INSTALLER_PAYLOAD = path.join(REPO_ROOT, "scripts", "install.sh");
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

function buildIsolatedSystemPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-acp-contract-sysbin-"));
  const exclude = new Set(["node", "npm", "npx"]);
  for (const sysDir of [
    "/usr/bin",
    "/bin",
    ...(process.platform === "win32" ? [path.dirname(BASH_BIN)] : []),
  ]) {
    if (!path.isAbsolute(sysDir) || !fs.existsSync(sysDir)) continue;
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

export function runInstallerFunction(
  scenario: { tmp: string; fakeBin: string; prefixBin: string },
  extraEnv: Record<string, string | undefined> = {},
  command = 'ensure_cli_shim "nemoclaw-acp"',
) {
  const cmd = `source "${INSTALLER_PAYLOAD}" >/dev/null 2>&1; ${command}`;
  return spawnSync(BASH_BIN, ["-c", cmd], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    env: {
      ...process.env,
      PATH: [scenario.fakeBin, TEST_SYSTEM_PATH].join(path.delimiter),
      ACTIVE_NPM_PREFIX: path.dirname(scenario.prefixBin),
      HOME: scenario.tmp,
      NO_COLOR: "1",
      ...extraEnv,
    },
  });
}

function writeExecutable(target: string, contents: string): void {
  fs.writeFileSync(target, contents, { mode: 0o755 });
}

function writeNodeForwarder(target: string): void {
  writeExecutable(target, `#!/usr/bin/env bash\nexec ${JSON.stringify(process.execPath)} "$@"\n`);
}

function fixtureGitEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
}

function runFixtureGit(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf-8", env: fixtureGitEnv() });
}

export function createPackagedCliTree(prefix: string): { fakeBin: string; prefixBin: string } {
  const fakeBin = path.join(prefix, "bin");
  const prefixBin = path.join(prefix, "prefix", "bin");
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(prefixBin, { recursive: true });
  writeNodeForwarder(path.join(fakeBin, "node"));
  writeExecutable(
    path.join(fakeBin, "npm"),
    `#!/usr/bin/env bash
if [ "$1" = "config" ] && [ "$2" = "get" ] && [ "$3" = "prefix" ]; then
  [ -z "$NPM_CALL_LOG" ] || printf '%s\\n' "$*" >> "$NPM_CALL_LOG"
  echo "$ACTIVE_NPM_PREFIX"
  exit 0
fi
[ -z "$NPM_CALL_LOG" ] || printf '%s\\n' "$*" >> "$NPM_CALL_LOG"
exit 99
`,
  );
  ["nemoclaw", "nemoclaw-acp", "nemohermes", "nemo-deepagents"].forEach((cliBin) => {
    writeExecutable(path.join(prefixBin, cliBin), `#!/usr/bin/env bash\necho "${cliBin} v0.1.0"\n`);
  });
  return { fakeBin, prefixBin };
}

export function writeInstallerGeneratedAcpShim(
  shimPath: string,
  fakeBin: string,
  target: string,
): void {
  fs.mkdirSync(path.dirname(shimPath), { recursive: true });
  writeExecutable(
    shimPath,
    [
      "#!/usr/bin/env bash",
      `[[ "$(command -v node 2>/dev/null)" == "${path.join(fakeBin, "node")}" ]] || export PATH="${fakeBin}:$PATH"`,
      `exec "${target}" "$@"`,
      "",
    ].join("\n"),
  );
}

/** Build isolated npm-package-shaped fixtures for installer shim contract tests. */
export function createManagedSourceNemoClawAcp(home: string, prefix: string): string {
  const sourceRoot = path.join(home, ".nemoclaw", "source");
  const packageRoot = sourceRoot;
  const acpEntry = path.join(packageRoot, "dist", "lib", "acp", "main.js");
  const linkedPackage = path.join(prefix, "lib", "node_modules", "nemoclaw");
  const binEntry = path.join(prefix, "bin", "nemoclaw-acp");
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.mkdirSync(path.dirname(linkedPackage), { recursive: true });
  fs.mkdirSync(path.dirname(binEntry), { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      name: "nemoclaw",
      version: "0.0.131",
      bin: { "nemoclaw-acp": "./dist/lib/acp/main.js" },
    }),
  );
  runFixtureGit(["-c", "core.hooksPath=/dev/null", "-C", packageRoot, "init", "--quiet"]);
  runFixtureGit(["-C", packageRoot, "add", "package.json"]);
  runFixtureGit([
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "user.name=Installer test",
    "-c",
    "user.email=installer-test@example.invalid",
    "-C",
    packageRoot,
    "commit",
    "--quiet",
    "-m",
    "fixture managed NemoClaw source",
  ]);
  const sourceRevision = runFixtureGit(["-C", packageRoot, "rev-parse", "HEAD"]).trim();
  fs.mkdirSync(path.dirname(acpEntry), { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "dist", "build-identity.json"),
    JSON.stringify({ nemoclawVersion: "0.0.131", sourceRevision }),
  );
  writeExecutable(acpEntry, "#!/usr/bin/env node\nconsole.log('0.0.131');\n");
  fs.symlinkSync(packageRoot, linkedPackage);
  fs.symlinkSync("../lib/node_modules/nemoclaw/dist/lib/acp/main.js", binEntry);
  return binEntry;
}

export function createNpmManagedNemoClawAcp(prefix: string, reportedVersion = "0.0.131"): string {
  const packageRoot = path.join(prefix, "lib", "node_modules", "nemoclaw");
  const acpEntry = path.join(packageRoot, "dist", "lib", "acp", "main.js");
  const binEntry = path.join(prefix, "bin", "nemoclaw-acp");
  fs.mkdirSync(path.dirname(acpEntry), { recursive: true });
  fs.mkdirSync(path.dirname(binEntry), { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      name: "nemoclaw",
      version: "0.0.131",
      bin: { "nemoclaw-acp": "./dist/lib/acp/main.js" },
    }),
  );
  fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "dist", "build-identity.json"),
    JSON.stringify({
      nemoclawVersion: "0.0.131",
      sourceRevision: "0123456789012345678901234567890123456789",
    }),
  );
  writeExecutable(
    acpEntry,
    `#!/usr/bin/env node\nconsole.log(${JSON.stringify(reportedVersion)});\n`,
  );
  fs.symlinkSync("../lib/node_modules/nemoclaw/dist/lib/acp/main.js", binEntry);
  return binEntry;
}

export function createCleanManagedSourceAcpWorkTree(home: string, destination: string): void {
  const packageFile = path.join(home, ".nemoclaw", "source", "package.json");
  fs.mkdirSync(destination, { recursive: true });
  fs.copyFileSync(packageFile, path.join(destination, "package.json"));
}

export function dirtyManagedSourceNemoClawAcp(home: string): void {
  const packageFile = path.join(home, ".nemoclaw", "source", "package.json");
  const pkg = JSON.parse(fs.readFileSync(packageFile, "utf8")) as { version: string };
  pkg.version = "0.0.132";
  fs.writeFileSync(packageFile, JSON.stringify(pkg));
}
