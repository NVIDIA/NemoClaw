// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  INSTALLER_PAYLOAD,
  TEST_SYSTEM_PATH,
  writeExecutable,
} from "../helpers/installer-sourced-env";

const INSTALL_REUSE_REVISION = "a".repeat(40);
const COMMITTED_LOCKFILE = '{"lockfileVersion":3,"packages":{"":{"name":"nemoclaw"}}}';

function writeNodeStub(fakeBin: string) {
  writeExecutable(
    path.join(fakeBin, "node"),
    `#!/usr/bin/env bash
if [ "$1" = "--version" ] || [ "$1" = "-v" ]; then echo "v22.19.0"; exit 0; fi
if [ -n "\${1:-}" ] && [ -f "$1" ]; then
  exec ${JSON.stringify(process.execPath)} "$@"
fi
if [ "$1" = "-e" ]; then
  exec ${JSON.stringify(process.execPath)} "$@"
fi
exit 99`,
  );
}

function writeManagedSource(root: string, revision: string) {
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.mkdirSync(path.join(root, "dist", "lib", "onboard"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
  fs.mkdirSync(path.join(root, "nemoclaw", "dist"), { recursive: true });
  fs.mkdirSync(path.join(root, "nemoclaw", "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(root, ".fixture-revision"), revision);
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "nemoclaw", dependencies: { openclaw: "2026.7.1" } }),
  );
  fs.writeFileSync(path.join(root, "package-lock.json"), COMMITTED_LOCKFILE);
  fs.writeFileSync(path.join(root, "nemoclaw", "package.json"), '{"name":"nemoclaw-plugin"}');
  fs.writeFileSync(path.join(root, "nemoclaw", "dist", "index.js"), "module.exports = {};\n");
  fs.writeFileSync(
    path.join(root, "dist", "lib", "onboard", "preflight.js"),
    "module.exports = {};\n",
  );
  fs.writeFileSync(
    path.join(root, "dist", "build-identity.json"),
    JSON.stringify({ nemoclawVersion: "0.0.99", sourceRevision: revision }, null, 2),
  );
  writeExecutable(
    path.join(root, "bin", "nemoclaw.js"),
    '#!/usr/bin/env bash\n[ "$1" = "--version" ] && echo "nemoclaw v0.0.99"\nexit 0\n',
  );
}

type InitialStateSetup = (fixture: {
  fakeBin: string;
  home: string;
  sourceRoot: string;
  tmp: string;
  revision: string;
}) => void;

function setupManagedSource({ fakeBin, sourceRoot, revision }: Parameters<InitialStateSetup>[0]) {
  writeManagedSource(sourceRoot, revision);
  fs.symlinkSync(path.join(sourceRoot, "bin", "nemoclaw.js"), path.join(fakeBin, "nemoclaw"));
}

function setupCleanState(_fixture: Parameters<InitialStateSetup>[0]) {}

function setupGroupAccessibleStateRoot({ home }: Parameters<InitialStateSetup>[0]) {
  fs.mkdirSync(path.join(home, ".nemoclaw"), { recursive: true });
  fs.chmodSync(path.join(home, ".nemoclaw"), 0o775);
}

function setupSymlinkStateRoot({ home, tmp }: Parameters<InitialStateSetup>[0]) {
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(tmp, "controlled"));
  fs.symlinkSync(path.join(tmp, "controlled"), path.join(home, ".nemoclaw"));
}

function runManagedCliInstallTwice({
  initialRevision = INSTALL_REUSE_REVISION,
  forceCliReinstall = false,
  separateInstallerRuns = false,
  failLockfileRestore = false,
  installUmask,
  setupInitialState = setupManagedSource,
}: {
  initialRevision?: string;
  forceCliReinstall?: boolean;
  separateInstallerRuns?: boolean;
  failLockfileRestore?: boolean;
  installUmask?: string;
  setupInitialState?: InitialStateSetup;
} = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-reuse-"));
  const home = path.join(tmp, "home");
  const fakeBin = path.join(tmp, "bin");
  const prefix = path.join(tmp, "prefix");
  const sourceRoot = path.join(home, ".nemoclaw", "source");
  const payloadScripts = path.join(tmp, "payload", "scripts");
  const gitLogPath = path.join(tmp, "git.log");
  const npmLogPath = path.join(tmp, "npm.log");

  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });
  fs.mkdirSync(payloadScripts, { recursive: true });
  setupInitialState({ fakeBin, home, sourceRoot, tmp, revision: initialRevision });
  writeNodeStub(fakeBin);

  writeExecutable(
    path.join(fakeBin, "git"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$GIT_LOG_PATH"
repo=""
if [ "\${1:-}" = "-C" ]; then repo="$2"; shift 2; fi
case "\${1:-}" in
  rev-parse)
    if [ "$repo" = "$MANAGED_SOURCE" ]; then
      cat "$repo/.fixture-revision"
    else
      printf '%s\n' "$EXPECTED_REVISION"
    fi
    ;;
  diff)
    if [ -n "$repo" ] && [ -f "$repo/package-lock.json" ] \
      && [ "$(cat "$repo/package-lock.json")" != "\${COMMITTED_LOCKFILE:-}" ]; then exit 1; fi
    exit 0
    ;;
  checkout)
    case "$*" in
      *package-lock.json*)
        if [ "\${FAIL_LOCKFILE_RESTORE:-}" = "1" ]; then exit 1; fi
        if [ -n "$repo" ]; then printf '%s' "\${COMMITTED_LOCKFILE:-}" > "$repo/package-lock.json"; fi
        ;;
    esac
    ;;
  init)
    node -e 'const assert = require("node:assert/strict"); const fs = require("node:fs"); assert.equal(fs.statSync(process.argv[1]).mode & 0o777, 0o700)' "$NEMOCLAW_STATE_ROOT"
    target="\${@: -1}"
    mkdir -p "$target/.git" "$target/bin" "$target/dist/lib/onboard" "$target/node_modules" \
      "$target/nemoclaw/dist" "$target/nemoclaw/node_modules"
    printf '%s' "$EXPECTED_REVISION" > "$target/.fixture-revision"
    printf '%s\n' '{"name":"nemoclaw","dependencies":{"openclaw":"2026.7.1"}}' > "$target/package.json"
    printf '%s\n' '{"name":"nemoclaw-plugin"}' > "$target/nemoclaw/package.json"
    printf '%s' "\${COMMITTED_LOCKFILE:-}" > "$target/package-lock.json"
    ;;
  describe) printf '%s\n' 'v0.0.99' ;;
esac
exit 0`,
  );

  writeExecutable(
    path.join(fakeBin, "npm"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s|%s\n' "$PWD" "$*" >> "$NPM_LOG_PATH"
if [ "\${1:-}" = "--version" ]; then printf '%s\n' '10.9.2'; exit 0; fi
if [ "\${1:-}" = "config" ] && [ "\${2:-}" = "get" ] && [ "\${3:-}" = "prefix" ]; then
  printf '%s\n' "$NPM_PREFIX"
  exit 0
fi
if [ "\${1:-}" = "pack" ]; then exit 1; fi
if [ "\${1:-}" = "install" ]; then
  printf '%s' '{"lockfileVersion":3,"packages":{"":{"name":"nemoclaw","bin":{}}}}' \
    > "$PWD/package-lock.json"
fi
if [ "\${1:-}" = "run" ]; then
  case "$*" in
    "run --if-present build:cli")
      mkdir -p "$PWD/dist/lib/onboard"
      printf '%s\n' 'module.exports = {};' > "$PWD/dist/lib/onboard/preflight.js"
      printf '{\n  "nemoclawVersion": "0.0.99",\n  "sourceRevision": "%s"\n}\n' "$EXPECTED_REVISION" \
        > "$PWD/dist/build-identity.json"
      ;;
    "run build")
      mkdir -p "$PWD/dist"
      printf '%s\n' 'module.exports = {};' > "$PWD/dist/index.js"
      ;;
    *)
      printf 'unsupported npm run command: %s\n' "$*" >&2
      exit 1
      ;;
  esac
fi
if [ "\${1:-}" = "link" ]; then
  mkdir -p "$PWD/bin" "$NPM_PREFIX/bin"
  cat > "$PWD/bin/nemoclaw.js" <<'CLI'
#!/usr/bin/env bash
[ "$1" = "--version" ] && echo "nemoclaw v0.0.99"
exit 0
CLI
  chmod +x "$PWD/bin/nemoclaw.js"
  ln -sfn "$PWD/bin/nemoclaw.js" "$NPM_PREFIX/bin/nemoclaw"
fi
exit 0`,
  );

  const result = spawnSync(
    "bash",
    [
      "-c",
      `set -euo pipefail
${installUmask === undefined ? "" : `umask ${installUmask}`}
source "$INSTALLER_UNDER_TEST" >/dev/null 2>&1
SCRIPT_DIR="$PAYLOAD_SCRIPTS"
NEMOCLAW_BOOTSTRAP_PAYLOAD=1
NEMOCLAW_DEFER_OPENSHELL_INSTALL=1
install_nemoclaw
${separateInstallerRuns ? "_NEMOCLAW_CLI_INSTALL_PREPARED=false" : ""}
install_nemoclaw
printf 'PREPARED=%s MODE=%s SOURCE=%s\n' \
  "$_NEMOCLAW_CLI_INSTALL_PREPARED" "$_NEMOCLAW_CLI_INSTALL_MODE" "$NEMOCLAW_SOURCE_ROOT"`,
    ],
    {
      encoding: "utf-8",
      env: {
        ...process.env,
        COMMITTED_LOCKFILE,
        EXPECTED_REVISION: INSTALL_REUSE_REVISION,
        FAIL_LOCKFILE_RESTORE: failLockfileRestore ? "1" : "",
        GIT_LOG_PATH: gitLogPath,
        HOME: home,
        INSTALLER_UNDER_TEST: INSTALLER_PAYLOAD,
        MANAGED_SOURCE: sourceRoot,
        NEMOCLAW_REINSTALL_CLI: forceCliReinstall ? "1" : "",
        NEMOCLAW_STATE_ROOT: path.join(home, ".nemoclaw"),
        NPM_LOG_PATH: npmLogPath,
        NPM_PREFIX: prefix,
        PATH: `${fakeBin}:${TEST_SYSTEM_PATH}`,
        PAYLOAD_SCRIPTS: payloadScripts,
      },
    },
  );

  const lockfilePath = path.join(sourceRoot, "package-lock.json");
  const gitLog = fs.existsSync(gitLogPath) ? fs.readFileSync(gitLogPath, "utf-8") : "";
  const npmLog = fs.existsSync(npmLogPath) ? fs.readFileSync(npmLogPath, "utf-8") : "";
  const lockfile = fs.existsSync(lockfilePath) ? fs.readFileSync(lockfilePath, "utf-8") : "";
  const stateMode = fs.existsSync(path.join(home, ".nemoclaw"))
    ? fs.statSync(path.join(home, ".nemoclaw")).mode & 0o777
    : null;
  fs.rmSync(tmp, { force: true, recursive: true });
  return { result, gitLog, npmLog, lockfile, sourceRoot, stateMode };
}

describe("installer-managed CLI reuse", () => {
  it("creates owner-only managed state under an account umask of 0002 (#8795)", () => {
    const { result, stateMode } = runManagedCliInstallTwice({
      installUmask: "0002",
      setupInitialState: setupCleanState,
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(stateMode).toBe(0o700);
  });

  it("repairs an existing group-accessible managed state root before cloning source (#8795)", () => {
    const { result, gitLog, stateMode } = runManagedCliInstallTwice({
      setupInitialState: setupGroupAccessibleStateRoot,
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(stateMode).toBe(0o700);
    expect(gitLog).toMatch(/^init\b/m);
  });

  it("rejects a symbolic-link managed state root before cloning source (#8795)", () => {
    const { result, gitLog } = runManagedCliInstallTwice({
      setupInitialState: setupSymlinkStateRoot,
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "Refusing symbolic link in NemoClaw state path",
    );
    expect(gitLog).not.toMatch(/^init\b/m);
  });

  it("reuses an exact healthy managed source without clone, build, or link (#7898)", () => {
    const { result, gitLog, npmLog, sourceRoot } = runManagedCliInstallTwice();

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("Reusing the installed NemoClaw CLI at the selected revision");
    expect(result.stdout).toContain("NemoClaw CLI was already prepared during this installer run");
    expect(result.stdout).toContain(`PREPARED=true MODE=managed SOURCE=${sourceRoot}`);
    expect(gitLog).not.toMatch(/^init\b/m);
    expect(npmLog).not.toMatch(/\|(install|ci|run|link)\b/);
  });

  it("builds a changed managed revision once across backup preparation and install (#7898)", () => {
    const { result, gitLog, npmLog } = runManagedCliInstallTwice({
      initialRevision: "b".repeat(40),
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).not.toContain(
      "Reusing the installed NemoClaw CLI at the selected revision",
    );
    expect(result.stdout).toContain("NemoClaw CLI was already prepared during this installer run");
    expect(gitLog.match(/^init\b/gm)).toHaveLength(1);
    expect(npmLog.match(/\|install --ignore-scripts$/gm)).toHaveLength(1);
    expect(npmLog.match(/\|run --if-present build:cli$/gm)).toHaveLength(1);
    expect(npmLog.match(/\|ci --ignore-scripts$/gm)).toHaveLength(1);
    expect(npmLog.match(/\|run build$/gm)).toHaveLength(1);
    expect(npmLog.match(/\|link --ignore-scripts$/gm)).toHaveLength(1);
  });

  it("reuses the managed checkout on a later installer run after its own dependency install (#8305)", () => {
    const { result, gitLog, npmLog, lockfile } = runManagedCliInstallTwice({
      initialRevision: "b".repeat(40),
      separateInstallerRuns: true,
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("Reusing the installed NemoClaw CLI at the selected revision");
    expect(lockfile).toBe(COMMITTED_LOCKFILE);
    expect(gitLog.match(/^init\b/gm)).toHaveLength(1);
    expect(npmLog.match(/\|install --ignore-scripts$/gm)).toHaveLength(1);
    expect(npmLog.match(/\|link --ignore-scripts$/gm)).toHaveLength(1);
  });

  it("warns and completes when the managed lockfile cannot be restored (#8305)", () => {
    const { result, gitLog, lockfile } = runManagedCliInstallTwice({
      initialRevision: "b".repeat(40),
      separateInstallerRuns: true,
      failLockfileRestore: true,
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("Could not restore package-lock.json");
    expect(result.stdout).toContain("re-clones that checkout instead of reusing it");
    expect(result.stdout).not.toContain(
      "Reusing the installed NemoClaw CLI at the selected revision",
    );
    expect(lockfile).not.toBe(COMMITTED_LOCKFILE);
    expect(gitLog.match(/^init\b/gm)).toHaveLength(2);
  });

  it("reinstalls the exact managed CLI once when update --fresh requests repair (#7898)", () => {
    const { result, gitLog, npmLog } = runManagedCliInstallTwice({ forceCliReinstall: true });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).not.toContain(
      "Reusing the installed NemoClaw CLI at the selected revision",
    );
    expect(result.stdout).toContain("NemoClaw CLI was already prepared during this installer run");
    expect(gitLog.match(/^init\b/gm)).toHaveLength(1);
    expect(npmLog.match(/\|install --ignore-scripts$/gm)).toHaveLength(1);
    expect(npmLog.match(/\|run --if-present build:cli$/gm)).toHaveLength(1);
    expect(npmLog.match(/\|ci --ignore-scripts$/gm)).toHaveLength(1);
    expect(npmLog.match(/\|run build$/gm)).toHaveLength(1);
    expect(npmLog.match(/\|link --ignore-scripts$/gm)).toHaveLength(1);
  });
});
