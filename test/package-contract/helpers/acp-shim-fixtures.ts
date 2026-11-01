// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { INSTALLER_PAYLOAD, TEST_SYSTEM_PATH } from "../../helpers/installer-sourced-env.js";

const REPO_ROOT = path.join(import.meta.dirname, "../../..");

export function runInstallerFunction(
  scenario: { tmp: string; fakeBin: string; prefixBin: string },
  extraEnv: Record<string, string | undefined> = {},
  command = 'ensure_cli_shim "nemoclaw-acp"',
) {
  const cmd = `source "${INSTALLER_PAYLOAD}" >/dev/null 2>&1; ${command}`;
  return spawnSync("bash", ["-c", cmd], {
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
export function createManagedSourceNemoClawAcp(
  home: string,
  prefix: string,
  packageJsonSymlinkTarget?: string,
  sourceRoot = path.join(home, ".nemoclaw", "source"),
): string {
  const packageRoot = sourceRoot;
  const packageJson = path.join(packageRoot, "package.json");
  const acpEntry = path.join(packageRoot, "dist", "lib", "acp", "main.js");
  const linkedPackage = path.join(prefix, "lib", "node_modules", "nemoclaw");
  const binEntry = path.join(prefix, "bin", "nemoclaw-acp");
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.mkdirSync(path.dirname(linkedPackage), { recursive: true });
  fs.mkdirSync(path.dirname(binEntry), { recursive: true });
  fs.writeFileSync(
    packageJson,
    JSON.stringify({
      name: "nemoclaw",
      version: "0.0.131",
      bin: { "nemoclaw-acp": "./dist/lib/acp/main.js" },
    }),
  );
  if (packageJsonSymlinkTarget !== undefined) {
    fs.copyFileSync(packageJson, packageJsonSymlinkTarget);
    fs.unlinkSync(packageJson);
    fs.symlinkSync(packageJsonSymlinkTarget, packageJson);
  }
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

/** Point repository configuration at a clean copy of the committed package.json. */
export function redirectSourceCheckoutWorkTree(sourceRoot: string, destination: string): void {
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(
    path.join(destination, "package.json"),
    runFixtureGit(["-C", sourceRoot, "show", "HEAD:package.json"]),
  );
  runFixtureGit(["-C", sourceRoot, "config", "core.worktree", destination]);
}

export function linkSourceCheckoutWorktree(
  sourceRoot: string,
  prefix: string,
  worktreeRoot = `${sourceRoot}-worktree`,
): void {
  runFixtureGit([
    "-c",
    "core.hooksPath=/dev/null",
    "-C",
    sourceRoot,
    "worktree",
    "add",
    "--quiet",
    "--detach",
    worktreeRoot,
    "HEAD",
  ]);
  fs.cpSync(path.join(sourceRoot, "dist"), path.join(worktreeRoot, "dist"), { recursive: true });
  const packageLink = path.join(prefix, "lib", "node_modules", "nemoclaw");
  fs.unlinkSync(packageLink);
  fs.symlinkSync(worktreeRoot, packageLink);
}

export function configureSourceCheckoutGitFilters(
  sourceRoot: string,
  sentinel: string,
  filterType: "clean" | "process",
  configScope: "local" | "global",
  filterName = `marker-${filterType}`,
): void {
  const filter = path.join(path.dirname(sourceRoot), `${filterName}.js`);
  fs.writeFileSync(
    filter,
    filterType === "clean"
      ? `#!/usr/bin/env node\nrequire("node:fs").appendFileSync(${JSON.stringify(sentinel)}, "executed\\n");\nprocess.stdin.pipe(process.stdout);\n`
      : `#!/usr/bin/env node
require("node:fs").appendFileSync(${JSON.stringify(sentinel)}, "executed\\n");
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(sourceRoot, ".gitattributes"), `package.json filter=${filterName}\n`);
  runFixtureGit(["-C", sourceRoot, "add", ".gitattributes"]);
  runFixtureGit([
    "-c",
    "commit.gpgsign=false",
    "-c",
    "user.name=Installer test",
    "-c",
    "user.email=installer-test@example.invalid",
    "-C",
    sourceRoot,
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "--quiet",
    "-m",
    "fixture marker filter",
  ]);
  const home = path.dirname(sentinel);
  const configArgs = configScope === "global" ? ["--file", path.join(home, ".gitconfig")] : [];
  runFixtureGit([
    "-C",
    sourceRoot,
    "config",
    ...configArgs,
    `filter.${filterName}.${filterType}`,
    filter,
  ]);
  const sourceRevision = runFixtureGit(["-C", sourceRoot, "rev-parse", "HEAD"]).trim();
  fs.writeFileSync(
    path.join(sourceRoot, "dist", "build-identity.json"),
    JSON.stringify({ nemoclawVersion: "0.0.131", sourceRevision }),
  );
  const packageFile = path.join(sourceRoot, "package.json");
  // hash-object forces conversion; diff can skip it when the index stat cache matches.
  const probe = spawnSync(
    "git",
    ["-C", sourceRoot, "hash-object", "--path=package.json", "--stdin"],
    {
      encoding: "utf8",
      env: { ...fixtureGitEnv(), HOME: home },
      input: fs.readFileSync(packageFile),
      timeout: 3000,
    },
  );
  if (!fs.existsSync(sentinel))
    throw new Error(`${filterType} filter did not execute through Git: ${probe.stderr}`);
  fs.rmSync(sentinel);
  // Make preflight compare bytes rather than accept the cached stat for package.json.
  fs.utimesSync(packageFile, new Date(1000), new Date(1000));
}

export function configureSourceCheckoutGitHooks(sourceRoot: string, sentinel: string): void {
  const hook = path.join(path.dirname(sourceRoot), "verification-hook");
  writeExecutable(hook, `#!/usr/bin/env bash\nprintf executed > ${JSON.stringify(sentinel)}\n`);
  runFixtureGit(["-C", sourceRoot, "config", "core.fsmonitor", hook]);
  runFixtureGit(["-C", sourceRoot, "config", "diff.external", hook]);
}

/**
 * Turn the fixture checkout into a promisor repository whose committed
 * package.json blob is missing, with a remote helper that records execution.
 * A verification step that lazily fetches runs the helper; a local-only one does not.
 */
export function configureSourceCheckoutPromisorRemote(sourceRoot: string, sentinel: string): void {
  const remote = path.join(path.dirname(sourceRoot), "promisor-remote.sh");
  writeExecutable(remote, `#!/bin/sh\nprintf executed > ${JSON.stringify(sentinel)}\nexit 1\n`);
  const blob = runFixtureGit(["-C", sourceRoot, "rev-parse", "HEAD:package.json"]).trim();
  fs.rmSync(path.join(sourceRoot, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
  [
    ["remote.origin.url", `ext::${remote}`],
    ["remote.origin.promisor", "true"],
    ["remote.origin.partialclonefilter", "blob:none"],
    ["extensions.partialClone", "origin"],
    ["protocol.ext.allow", "always"],
  ].forEach(([key, value]) => runFixtureGit(["-C", sourceRoot, "config", key, value]));
  // Make preflight compare bytes rather than accept the cached stat for package.json.
  fs.utimesSync(path.join(sourceRoot, "package.json"), new Date(1000), new Date(1000));
  // Confirm the fixture would fetch without the guard, so the assertion cannot pass vacuously.
  const probe = spawnSync("git", ["-C", sourceRoot, "diff", "--quiet", "--"], {
    encoding: "utf8",
    env: fixtureGitEnv(),
    timeout: 3000,
  });
  if (!fs.existsSync(sentinel))
    throw new Error(`promisor remote did not fetch through Git: ${probe.stderr}`);
  fs.rmSync(sentinel);
}

export function dirtyManagedSourceNemoClawAcp(
  home: string,
  sourceRoot = path.join(home, ".nemoclaw", "source"),
): void {
  const packageFile = path.join(sourceRoot, "package.json");
  const pkg = JSON.parse(fs.readFileSync(packageFile, "utf8")) as { version: string };
  pkg.version = "0.0.132";
  fs.writeFileSync(packageFile, JSON.stringify(pkg));
}
