// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { runRealCheckoutVerifier as runExtractedRealCheckoutVerifier } from "./helpers/cua-launchable-git-verifier";
import { testTimeout } from "./helpers/timeouts";

const SCRIPT = path.join(import.meta.dirname, "..", "scripts", "brev-launchable-cua-gpu.sh");
const ARTIFACT_RUNNER_SCRIPT = path.join(
  import.meta.dirname,
  "..",
  "scripts",
  "cua-qualification-artifact-runner.sh",
);
const TARGET_CHANNEL_PROBE_SCRIPT = path.join(
  import.meta.dirname,
  "..",
  "scripts",
  "cua-qualification-target-channel-probe.ts",
);
const COMMIT = "a".repeat(40);
const SHA256 = "b".repeat(64);
const PROBE_IMAGE = `nvcr.io/nvidia/cuda@sha256:${"c".repeat(64)}`;
const SANDBOX_IMAGE = `nvcr.io/nvidia/nemocua@sha256:${"d".repeat(64)}`;
const SERVICE_BUNDLE_DIGEST = `sha256:${"4".repeat(64)}`;
const CUA_LAUNCHABLE_TEST_TIMEOUT_MS = testTimeout(60_000);
const FIXED_HELPER_PATHS = {
  AWK_BINARY: ["/usr/bin/awk", "awk"],
  CHMOD_BINARY: ["/usr/bin/chmod", "chmod"],
  CHOWN_BINARY: ["/usr/bin/chown", "chown"],
  CMP_BINARY: ["/usr/bin/cmp", "cmp"],
  CURL_BINARY: ["/usr/bin/curl", "curl"],
  ENV_BINARY: ["/usr/bin/env", "env"],
  GETENT_BINARY: ["/usr/bin/getent", "getent"],
  GIT_BINARY: ["/usr/bin/git", "git"],
  GREP_BINARY: ["/usr/bin/grep", "grep"],
  HEAD_BINARY: ["/usr/bin/head", "head"],
  ID_BINARY: ["/usr/bin/id", "id"],
  INSTALL_BINARY: ["/usr/bin/install", "install"],
  JQ_BINARY: ["/usr/bin/jq", "jq"],
  MKDIR_BINARY: ["/usr/bin/mkdir", "mkdir"],
  MKTEMP_BINARY: ["/usr/bin/mktemp", "mktemp"],
  MV_BINARY: ["/usr/bin/mv", "mv"],
  READLINK_BINARY: ["/usr/bin/readlink", "readlink"],
  REALPATH_BINARY: ["/usr/bin/realpath", "realpath"],
  RM_BINARY: ["/usr/bin/rm", "rm"],
  SED_BINARY: ["/usr/bin/sed", "sed"],
  SHA256SUM_BINARY: ["/usr/bin/sha256sum", "sha256sum"],
  SORT_BINARY: ["/usr/bin/sort", "sort"],
  STAT_BINARY: ["/usr/bin/stat", "stat"],
  SUDO_BINARY: ["/usr/bin/sudo", "sudo"],
  SYNC_BINARY: ["/usr/bin/sync", "sync"],
  SYSTEMCTL_BINARY: ["/usr/bin/systemctl", "systemctl"],
  TEE_BINARY: ["/usr/bin/tee", "tee"],
  TRUE_BINARY: ["/usr/bin/true", "true"],
  TR_BINARY: ["/usr/bin/tr", "tr"],
  USERADD_BINARY: ["/usr/sbin/useradd", "useradd"],
} as const;
const NATIVE_FIXTURE_HELPERS: Partial<Record<keyof typeof FIXED_HELPER_PATHS, string>> = {
  AWK_BINARY: "/usr/bin/awk",
  CHMOD_BINARY: "/bin/chmod",
  CHOWN_BINARY: "/usr/sbin/chown",
  CMP_BINARY: "/usr/bin/cmp",
  ENV_BINARY: "/usr/bin/env",
  GREP_BINARY: "/usr/bin/grep",
  HEAD_BINARY: "/usr/bin/head",
  INSTALL_BINARY: "/usr/bin/install",
  MKDIR_BINARY: "/bin/mkdir",
  MV_BINARY: "/bin/mv",
  READLINK_BINARY: "/usr/bin/readlink",
  RM_BINARY: "/bin/rm",
  SED_BINARY: "/usr/bin/sed",
  SORT_BINARY: "/usr/bin/sort",
  SYNC_BINARY: "/bin/sync",
  TEE_BINARY: "/usr/bin/tee",
  TRUE_BINARY: "/usr/bin/true",
  TR_BINARY: "/usr/bin/tr",
};

function executable(directory: string, name: string, source: string): void {
  fs.writeFileSync(path.join(directory, name), source, { mode: 0o755 });
}

function shellLiteral(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function fileSha256(file: string): string {
  return `sha256:${createHash("sha256").update(fs.readFileSync(file)).digest("hex")}`;
}

function replaceExactlyOnce(source: string, expected: string, replacement: string): string {
  const first = source.indexOf(expected);
  if (first < 0 || source.indexOf(expected, first + expected.length) >= 0) {
    throw new Error(`fixture could not replace exactly one ${expected}`);
  }
  return `${source.slice(0, first)}${replacement}${source.slice(first + expected.length)}`;
}

function replaceExactlyTwice(source: string, expected: string, replacement: string): string {
  const parts = source.split(expected);
  if (parts.length !== 3) {
    throw new Error(`fixture could not replace exactly two ${expected}`);
  }
  return parts.join(replacement);
}

function runRealCheckoutVerifier(
  script: string,
  attack?: "--assume-unchanged" | "--skip-worktree" | "--replace-head",
) {
  const compatibilityRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "nemoclaw-cua-real-verify-source-"),
  );
  const compatibilityScript = path.join(compatibilityRoot, path.basename(script));
  let source = fs.readFileSync(script, "utf8");

  // The shared real-Git harness extracts these functions without running the
  // production helper-authority bootstrap. Bind its controlled macOS stat
  // adapter and fixed system tools without weakening the production script.
  source = replaceExactlyOnce(
    source,
    "run_git() {\n",
    `run_git() {
  local ENV_BINARY=/usr/bin/env
  local HOST_SYSTEM_PATH="$GIT_SAFE_PATH"
`,
  );
  source = replaceExactlyOnce(
    source,
    "verify_exact_git_checkout() {\n",
    `verify_exact_git_checkout() {
  local STAT_BINARY=stat
  local READLINK_BINARY=/usr/bin/readlink
  local CMP_BINARY=/usr/bin/cmp
`,
  );
  fs.writeFileSync(compatibilityScript, source);

  try {
    const fixture = runExtractedRealCheckoutVerifier(compatibilityScript, attack);
    return {
      result: fixture.result,
      cleanup: () => {
        fixture.cleanup();
        fs.rmSync(compatibilityRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    fs.rmSync(compatibilityRoot, { recursive: true, force: true });
    throw error;
  }
}

function runCandidateFixture(input: {
  ambientPathAttack?: boolean;
  directExecution?: boolean;
  stdinExecution?: boolean;
  validateFixedHelpers?: boolean;
  cloneParentIdentity?: string;
  cloneRootIdentity?: string;
  gitStatus?: string;
  gitIndexTag?: string;
  gitIndexDiffStatus?: number;
  gitTreeObject?: string;
  gitAuthoritativeSource?: string;
  candidateLaunchableSource?: string;
  trackedFileMode?: number;
  launchableAuthorityMode?: string;
  launchableAuthorityOwner?: string;
  launchableAuthorityLinks?: string;
  launchableAncestorOwner?: string;
  launchableAncestorMode?: string;
  hostToolOwner?: string;
  hostToolMode?: string;
  hostToolLinks?: string;
  hostToolSize?: string;
  gitEnvironment?: NodeJS.ProcessEnv;
  nodeStatus?: number;
  nodeOutput?: string;
  nodeServiceBundleOutput?: string;
  nodeSecondManifestSha256?: string;
  nodeSecondOutput?: string;
  nodeSecondServiceBundleOutput?: string;
  targetChannelRecord?: string;
  rootPeerAccepted?: boolean;
  runtimeAuthorityOwner?: string;
  dockerInspectOutput?: string;
  dockerPullStatus?: number;
  dockerRunStatus?: number;
  environmentOverrides?: Record<string, string | undefined>;
  cloneDirectory?: (paths: { root: string; home: string; outside: string }) => string;
  precreateBaseSymlink?: boolean;
  replaceBaseDuringGit?: boolean;
  replaceLaunchableDuringCurl?: boolean;
  mutateLaunchableDuringNvidiaSmi?: boolean;
  mutateHostToolDuringNvidiaSmi?: "node" | "docker" | "nvidia-ctk";
  nodeAuthorityPathMismatch?: boolean;
  publicationFailure?:
    | "runner-move"
    | "environment-tee"
    | "environment-move"
    | "profile-tee"
    | "profile-move"
    | "sentinel-tee"
    | "sentinel-move"
    | "sentinel-sync";
  publicationSymlink?: "environment" | "profile" | "sentinel" | "runner";
  symlinkCloneRoot?: boolean;
}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cua-launchable-")));
  const bin = path.join(root, "bin");
  const attackerBin = path.join(root, "attacker-bin");
  const home = path.join(root, "home");
  const outside = path.join(root, "outside");
  const cloneRoot = path.join(root, "root-owned-clones");
  const actualCloneRoot = input.symlinkCloneRoot ? path.join(outside, "clone-root") : cloneRoot;
  const clone = path.join(cloneRoot, COMMIT);
  const qualificationEnvironmentFile = path.join(root, "etc", "nemoclaw", "environment.json");
  const profileFile = path.join(root, "etc", "profile.d", "nemoclaw-cua.sh");
  const sentinelFile = path.join(root, "run", "nemoclaw-cua-ready");
  const artifactRunnerFile = path.join(root, "libexec", "nemoclaw-cua-artifact-runner");
  const bootstrap = `/tmp/nemoclaw-brev-launchable.test-${path.basename(root)}`;
  const fixtureScript = path.join(root, "brev-launchable-cua-gpu.sh");
  const launchableDescriptorAuthority = `${fixtureScript}.descriptor`;
  const executingScriptCopy = `${fixtureScript}.executing`;
  const basePath = path.join(bootstrap, "brev-launchable-ci-cpu.sh");
  const baseHome = path.join(bootstrap, "base-home");
  const baseLaunchLog = path.join(bootstrap, "base-launch.log");
  const symlinkVictim = path.join(root, "symlink-victim");
  const gitMarker = path.join(root, "git-environment");
  const gitCloneMarker = path.join(root, "git-clone-destination");
  const hookMarker = path.join(root, "hook-ran");
  const fsmonitorMarker = path.join(root, "fsmonitor-ran");
  const bootstrapModeMarker = path.join(root, "bootstrap-mode-invalid");
  const replacementMarker = path.join(root, "replacement-ran");
  const baseExecutionMarker = path.join(root, "base-executed-from");
  const baseEnvironmentMarker = path.join(root, "base-environment");
  const cloneRootInstallMarker = path.join(root, "clone-root-install");
  const curlMarker = path.join(root, "curl-invoked");
  const attackerPathMarker = path.join(root, "attacker-path-invoked");
  const nodeMarker = path.join(root, "node-invoked");
  const environmentMarker = path.join(root, "environment-written");
  const launchableDigestSourceMarker = path.join(root, "launchable-digest-source");
  const launchableDigestBytesMarker = path.join(root, "launchable-digest-bytes");
  const launchableDigestValueMarker = path.join(root, "launchable-digest-value");
  const launchableMutationMarker = path.join(root, "launchable-mutated");
  const dockerMarker = path.join(root, "docker-invocations");
  fs.mkdirSync(bin);
  fs.mkdirSync(attackerBin);
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, ".npmrc"), "//attacker.invalid/:_authToken=attacker\n");
  fs.mkdirSync(outside);
  fs.mkdirSync(path.dirname(qualificationEnvironmentFile), { recursive: true, mode: 0o755 });
  fs.mkdirSync(path.dirname(profileFile), { recursive: true, mode: 0o755 });
  fs.mkdirSync(path.dirname(sentinelFile), { recursive: true, mode: 0o755 });
  fs.mkdirSync(path.dirname(artifactRunnerFile), { recursive: true, mode: 0o755 });
  if (input.publicationFailure !== undefined) {
    for (const file of [qualificationEnvironmentFile, profileFile, sentinelFile]) {
      fs.writeFileSync(file, "stale\n", { mode: 0o444 });
    }
    fs.writeFileSync(artifactRunnerFile, "stale runner\n", { mode: 0o555 });
  }
  fs.mkdirSync(actualCloneRoot, { mode: 0o755 });
  if (input.symlinkCloneRoot) fs.symlinkSync(actualCloneRoot, cloneRoot);
  fs.writeFileSync(symlinkVictim, "unchanged");
  const publicationSymlinkPath =
    input.publicationSymlink === "environment"
      ? qualificationEnvironmentFile
      : input.publicationSymlink === "profile"
        ? profileFile
        : input.publicationSymlink === "sentinel"
          ? sentinelFile
          : input.publicationSymlink === "runner"
            ? artifactRunnerFile
            : undefined;
  if (publicationSymlinkPath !== undefined) {
    fs.symlinkSync(symlinkVictim, publicationSymlinkPath);
  }
  const cloneOverride = input.cloneDirectory?.({ root, home, outside });
  const safePath = `${bin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;

  const baseScriptSource = `#!/bin/bash
unsafe_environment=0
if [[ "\${PATH:-}" != ${shellLiteral(safePath)} || \
  "\${HOME:-}" != ${shellLiteral(baseHome)} || \
  "\${SUDO_USER:-}" != "fixture" || \
  "\${LAUNCH_LOG:-}" != ${shellLiteral(baseLaunchLog)} || \
  "\${NPM_CONFIG_USERCONFIG:-}" != "/dev/null" || \
  "\${NPM_CONFIG_GLOBALCONFIG:-}" != "/dev/null" || \
  "\${NEMOCLAW_REF:-}" != ${shellLiteral(COMMIT)} || \
  "\${NEMOCLAW_CLONE_DIR:-}" != ${shellLiteral(clone)} || \
  "\${GIT_CONFIG_NOSYSTEM:-}" != "1" || \
  "\${GIT_CONFIG_SYSTEM:-}" != "/dev/null" || \
  "\${GIT_CONFIG_GLOBAL:-}" != "/dev/null" || \
  "\${GIT_NO_REPLACE_OBJECTS:-}" != "1" || \
  "\${GIT_CONFIG_COUNT:-}" != "6" || \
  "\${GIT_CONFIG_KEY_0:-}" != "core.hooksPath" || \
  "\${GIT_CONFIG_VALUE_0:-}" != "/dev/null" || \
  "\${GIT_CONFIG_KEY_1:-}" != "core.fsmonitor" || \
  "\${GIT_CONFIG_VALUE_1:-}" != "false" ]]; then
  unsafe_environment=1
fi
for variable in GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
  GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_NAMESPACE GIT_CEILING_DIRECTORIES \
  GIT_CONFIG_PARAMETERS; do
  if [[ -n "\${!variable:-}" ]]; then unsafe_environment=1; fi
done
if (( unsafe_environment )); then
  printf unsafe > ${shellLiteral(baseEnvironmentMarker)}
else
  printf safe > ${shellLiteral(baseEnvironmentMarker)}
fi
git -C "$NEMOCLAW_CLONE_DIR" status --porcelain=v1 --untracked-files=normal >/dev/null
printf '%s' "$0" > ${shellLiteral(baseExecutionMarker)}
exit 0
`;
  const authoritativeTrackedSource = input.gitAuthoritativeSource ?? baseScriptSource;

  executable(
    bin,
    "curl",
    `#!/bin/bash
set -eu
printf invoked > ${shellLiteral(curlMarker)}
if ${input.replaceLaunchableDuringCurl ? "true" : "false"}; then
  mv -- ${shellLiteral(fixtureScript)} ${shellLiteral(executingScriptCopy)}
  printf '%s\n' '#!/bin/bash' 'exit 91' > ${shellLiteral(fixtureScript)}
  chmod 0700 ${shellLiteral(fixtureScript)}
fi
printf '%s' ${shellLiteral(baseScriptSource)}
`,
  );
  executable(
    bin,
    "git",
    `#!/bin/bash
set -eu
unsafe_environment=0
for variable in GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
  GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_NAMESPACE GIT_CEILING_DIRECTORIES \
  GIT_CONFIG_PARAMETERS; do
  if [[ -n "\${!variable:-}" ]]; then unsafe_environment=1; fi
done
base_bootstrap=0
if [[ "\${GIT_CONFIG_COUNT:-}" == "6" ]]; then
  base_bootstrap=1
  if [[ "\${GIT_CONFIG_KEY_0:-}" != "core.hooksPath" || \
    "\${GIT_CONFIG_VALUE_0:-}" != "/dev/null" || \
    "\${GIT_CONFIG_KEY_1:-}" != "core.fsmonitor" || \
    "\${GIT_CONFIG_VALUE_1:-}" != "false" || \
    "\${GIT_CONFIG_KEY_2:-}" != "core.untrackedCache" || \
    "\${GIT_CONFIG_VALUE_2:-}" != "false" || \
    "\${GIT_CONFIG_KEY_3:-}" != "core.attributesFile" || \
    "\${GIT_CONFIG_VALUE_3:-}" != "/dev/null" || \
    "\${GIT_CONFIG_KEY_4:-}" != "core.excludesFile" || \
    "\${GIT_CONFIG_VALUE_4:-}" != "/dev/null" || \
    "\${GIT_CONFIG_KEY_5:-}" != "credential.helper" || \
    "\${GIT_CONFIG_VALUE_5+x}" != "x" || \
    "\${GIT_CONFIG_VALUE_5}" != "" || \
    "\${HOME:-}" != ${shellLiteral(baseHome)} ]]; then
    unsafe_environment=1
  fi
elif [[ -n "\${GIT_CONFIG_COUNT:-}" || -n "\${GIT_CONFIG_KEY_0:-}" || \
  -n "\${GIT_CONFIG_VALUE_0:-}" || -n "\${GIT_CONFIG_KEY_1:-}" || \
  -n "\${GIT_CONFIG_VALUE_1:-}" || \
  "\${HOME:-}" != ${shellLiteral(path.join(bootstrap, "git-home"))} || \
  "\${XDG_CONFIG_HOME:-}" != ${shellLiteral(path.join(bootstrap, "git-xdg"))} ]]; then
  unsafe_environment=1
fi
if [[ "\${PATH:-}" != ${shellLiteral(safePath)} || \
  "\${GIT_CONFIG_NOSYSTEM:-}" != "1" || \
  "\${GIT_CONFIG_SYSTEM:-}" != "/dev/null" || \
  "\${GIT_CONFIG_GLOBAL:-}" != "/dev/null" || \
  "\${GIT_NO_REPLACE_OBJECTS:-}" != "1" || \
  ( "$base_bootstrap" == "0" && "\${1:-}" != "--no-replace-objects" ) ]]; then
  unsafe_environment=1
fi
if (( unsafe_environment )); then
  printf unsafe >> ${shellLiteral(gitMarker)}
else
  printf safe >> ${shellLiteral(gitMarker)}
fi

args=("$@")
if [[ "\${args[0]:-}" == "--no-replace-objects" ]]; then
  args=("\${args[@]:1}")
fi
hook_disabled=$base_bootstrap
fsmonitor_disabled=$base_bootstrap
while (( \${#args[@]} >= 2 )) && [[ "\${args[0]}" == "-c" ]]; do
  case "\${args[1]}" in
    core.hooksPath=/dev/null) hook_disabled=1 ;;
    core.fsmonitor=false) fsmonitor_disabled=1 ;;
  esac
  args=("\${args[@]:2}")
done
if (( ! hook_disabled )); then printf attacked > ${shellLiteral(hookMarker)}; fi
if (( ! fsmonitor_disabled )); then printf attacked > ${shellLiteral(fsmonitorMarker)}; fi
if mode="$(stat -c '%a' ${shellLiteral(bootstrap)} 2>/dev/null)"; then
  :
else
  mode="$(stat -f '%Lp' ${shellLiteral(bootstrap)})"
fi
if [[ "$mode" != "700" ]]; then printf invalid > ${shellLiteral(bootstrapModeMarker)}; fi
if [[ "\${args[0]:-}" == "-C" ]]; then args=("\${args[@]:2}"); fi
command="\${args[0]:-}"

if [[ "$command" == "clone" ]]; then
  clone_dir="\${args[\${#args[@]}-1]}"
  printf '%s' "$clone_dir" > ${shellLiteral(gitCloneMarker)}
  mkdir -p "$clone_dir/scripts"
  printf '%s' ${shellLiteral(baseScriptSource)} > "$clone_dir/scripts/brev-launchable-ci-cpu.sh"
  ${
    input.candidateLaunchableSource === undefined
      ? `cp -- ${shellLiteral(launchableDescriptorAuthority)} "$clone_dir/scripts/brev-launchable-cua-gpu.sh"`
      : `printf '%s' ${shellLiteral(input.candidateLaunchableSource)} > "$clone_dir/scripts/brev-launchable-cua-gpu.sh"`
  }
  cp -- ${shellLiteral(ARTIFACT_RUNNER_SCRIPT)} \
    "$clone_dir/scripts/cua-qualification-artifact-runner.sh"
  cp -- ${shellLiteral(TARGET_CHANNEL_PROBE_SCRIPT)} \
    "$clone_dir/scripts/cua-qualification-target-channel-probe.ts"
  chmod ${shellLiteral(((input.trackedFileMode ?? 0o644) & 0o777).toString(8))} \
    "$clone_dir/scripts/brev-launchable-ci-cpu.sh"
  if ${input.replaceBaseDuringGit ? "true" : "false"}; then
    printf '%s' ${shellLiteral(`#!/bin/bash
printf attacked > ${shellLiteral(replacementMarker)}
exit 0
`)} > ${shellLiteral(basePath)}
    chmod 0500 ${shellLiteral(basePath)}
  fi
  exit 0
fi
case "$command" in
  fetch|checkout|for-each-ref|submodule) exit 0 ;;
  rev-parse)
    if [[ "\${args[1]:-}" == "--show-toplevel" ]]; then
      printf '%s\\n' ${shellLiteral(clone)}
    else
      printf '%s\\n' ${shellLiteral(COMMIT)}
    fi
    exit 0
    ;;
  ls-files)
    printf '%s\\0' ${shellLiteral(`${input.gitIndexTag ?? "H"} scripts/brev-launchable-ci-cpu.sh`)}
    exit 0
    ;;
  diff-index) exit ${input.gitIndexDiffStatus ?? 0} ;;
  ls-tree)
    printf '100644 blob %s %s\\tscripts/brev-launchable-ci-cpu.sh\\0' \
      ${shellLiteral(input.gitTreeObject ?? "e".repeat(40))} \
      ${shellLiteral(String(Buffer.byteLength(authoritativeTrackedSource)))}
    exit 0
    ;;
  cat-file) printf '%s' ${shellLiteral(authoritativeTrackedSource)}; exit 0 ;;
  status) printf '%s' ${shellLiteral(input.gitStatus ?? "")}; exit 0 ;;
esac
exit 97
`,
  );
  executable(
    bin,
    "mktemp",
    `#!/bin/bash
set -eu
[[ "\${1:-}" == "-d" && "\${2:-}" == "/tmp/nemoclaw-brev-launchable.XXXXXXXX" ]]
mkdir -m 0777 -- ${shellLiteral(bootstrap)}
chmod 0777 ${shellLiteral(bootstrap)}
if ${input.precreateBaseSymlink ? "true" : "false"}; then
  ln -s -- ${shellLiteral(symlinkVictim)} ${shellLiteral(basePath)}
fi
printf '%s\\n' ${shellLiteral(bootstrap)}
`,
  );
  executable(
    bin,
    "sha256sum",
    `#!/bin/bash
if [[ "\${1:-}" == "--" ]]; then
  shift
fi
[[ "$#" == "1" ]]
launchable_authority=0
if cmp -s -- "$1" ${shellLiteral(launchableDescriptorAuthority)}; then
  launchable_authority=1
  printf '%s' "$1" > ${shellLiteral(launchableDigestSourceMarker)}
  printf exact > ${shellLiteral(launchableDigestBytesMarker)}
fi
if [[ -x /usr/bin/sha256sum ]]; then
  digest="$(/usr/bin/sha256sum "$1" | awk '{print $1}')"
else
  digest="$(/usr/bin/shasum -a 256 <"$1" | awk '{print $1}')"
fi
if (( launchable_authority )); then
  printf '%s' "$digest" > ${shellLiteral(launchableDigestValueMarker)}
fi
printf '%s  %s\\n' "$digest" "$1"
`,
  );
  executable(
    bin,
    "getent",
    `#!/bin/sh
if [ "\${1:-}" = "passwd" ] && [ "\${2:-}" = "nemoclaw-cua-artifact" ]; then
  printf '%s\\n' 'nemoclaw-cua-artifact:x:2000:2000::/nonexistent:/usr/sbin/nologin'
else
  printf 'fixture:x:1000:1000::%s:/bin/sh\\n' ${shellLiteral(home)}
fi
`,
  );
  executable(
    bin,
    "stat",
    `#!/bin/bash
set -eu
if [[ "\${1:-}" == "-c" && "\${2:-}" == "%u:%g:%a:%F" &&
  "\${!#}" == ${shellLiteral(cloneRoot)} ]]; then
  printf '%s\\n' ${shellLiteral(input.cloneRootIdentity ?? "0:0:755:directory")}
  exit 0
fi
if [[ "\${1:-}" == "-c" && "\${2:-}" == "%u:%g:%a:%F" &&
  "\${!#}" == ${shellLiteral(root)} ]]; then
  printf '%s\\n' ${shellLiteral(input.cloneParentIdentity ?? "0:0:755:directory")}
  exit 0
fi
if [[ "\${1:-}" == "-Lc" && "\${2:-}" == "%u:%g:%F" && -d "\${!#}" ]]; then
  printf '%s:directory\\n' ${shellLiteral(input.launchableAncestorOwner ?? "0:0")}
  exit 0
fi
if [[ "\${1:-}" == "-Lc" && "\${2:-}" == "%a" && -d "\${!#}" ]]; then
  printf '%s\\n' ${shellLiteral(input.launchableAncestorMode ?? "0755")}
  exit 0
fi
if [[ "\${!#}" == ${shellLiteral(path.dirname(qualificationEnvironmentFile))} ||
  "\${!#}" == ${shellLiteral(path.dirname(profileFile))} ||
  "\${!#}" == ${shellLiteral(path.dirname(sentinelFile))} ]]; then
  if [[ "\${1:-}" == "-Lc" && "\${2:-}" == "%u:%g:%F" ]]; then
    printf '%s\\n' '0:0:directory'
    exit 0
  fi
fi
  if [[ "\${!#}" == ${shellLiteral(qualificationEnvironmentFile)} ||
  "\${!#}" == ${shellLiteral(profileFile)} ||
  "\${!#}" == ${shellLiteral(sentinelFile)} ||
  "\${!#}" == ${shellLiteral(artifactRunnerFile)} ||
  "\${!#}" == ${shellLiteral(path.dirname(qualificationEnvironmentFile))}/* ||
  "\${!#}" == ${shellLiteral(path.dirname(profileFile))}/* ||
  "\${!#}" == ${shellLiteral(path.dirname(sentinelFile))}/* ||
  "\${!#}" == ${shellLiteral(path.dirname(artifactRunnerFile))}/* ]]; then
  if [[ "\${1:-}" == "-Lc" && "\${2:-}" == "%u:%g:%a:%h:%F" ]]; then
    ${
      process.platform === "darwin"
        ? `mode="$(/usr/bin/stat -f '%Lp' "\${!#}")"`
        : `mode="$(/usr/bin/stat -c '%a' "\${!#}")"`
    }
    printf '0:0:%s:1:regular file\\n' "$mode"
    exit 0
  fi
fi
if [[ "\${!#}" == ${shellLiteral(bin)}/* ]]; then
  helper_owner='0:0'
  helper_mode='0755'
  case "\${!#}" in
    ${shellLiteral(path.join(bin, "node"))}|\
${shellLiteral(path.join(bin, "docker"))}|\
${shellLiteral(path.join(bin, "nvidia-smi"))}|\
${shellLiteral(path.join(bin, "nvidia-ctk"))})
      helper_owner=${shellLiteral(input.hostToolOwner ?? "0:0")}
      helper_mode=${shellLiteral(input.hostToolMode ?? "0755")}
      ;;
  esac
  if [[ ( "\${1:-}" == "-c" || "\${1:-}" == "-Lc" ) &&
    "\${2:-}" == "%u:%g:%F" ]]; then
    printf '%s:regular file\n' "$helper_owner"
    exit 0
  fi
  if [[ "\${1:-}" == "-Lc" && "\${2:-}" == "%u:%g:%a:%F" ]]; then
    printf '%s:%s:regular file\n' "$helper_owner" "$helper_mode"
    exit 0
  fi
  if [[ "\${1:-}" == "-Lc" && "\${2:-}" == "%a" ]]; then
    printf '%s\n' "$helper_mode"
    exit 0
  fi
  if [[ "\${1:-}" == "-Lc" && "\${2:-}" == "%h" ]]; then
    printf '%s\n' ${shellLiteral(input.hostToolLinks ?? "1")}
    exit 0
  fi
  if ${input.hostToolSize === undefined ? "false" : "true"} &&
    [[ "\${1:-}" == "-Lc" && "\${2:-}" == "%s" ]]; then
    printf '%s\n' ${shellLiteral(input.hostToolSize ?? "")}
    exit 0
  fi
fi
if [[ "\${!#}" == /usr/bin/* || "\${!#}" == /usr/sbin/* || "\${!#}" == /bin/* ]]; then
  if [[ ( "\${1:-}" == "-c" || "\${1:-}" == "-Lc" ) &&
    "\${2:-}" == "%u:%g:%F" ]]; then
    printf '%s\n' '0:0:regular file'
    exit 0
  fi
  if [[ "\${1:-}" == "-Lc" && "\${2:-}" == "%u:%g:%a:%F" ]]; then
    printf '%s\n' '0:0:0755:regular file'
    exit 0
  fi
  if [[ "\${1:-}" == "-Lc" && "\${2:-}" == "%a" ]]; then
    printf '%s\n' '0755'
    exit 0
  fi
fi
if [[ "\${!#}" == ${shellLiteral(path.join(bin, "node"))} ||
  "\${!#}" == ${shellLiteral(path.join(bin, "docker"))} ||
  "\${!#}" == ${shellLiteral(path.join(bin, "nvidia-smi"))} ||
  "\${!#}" == ${shellLiteral(path.join(bin, "nvidia-ctk"))} ]]; then
  if [[ "\${1:-}" == "-Lc" && "\${2:-}" == "%u:%g:%F" ]]; then
    printf '%s:regular file\n' ${shellLiteral(input.hostToolOwner ?? "0:0")}
    exit 0
  fi
  if [[ "\${1:-}" == "-Lc" && "\${2:-}" == "%a" ]]; then
    printf '%s\n' ${shellLiteral(input.hostToolMode ?? "0755")}
    exit 0
  fi
  if ${input.hostToolLinks === undefined ? "false" : "true"} &&
    [[ "\${1:-}" == "-Lc" && "\${2:-}" == "%h" ]]; then
    printf '%s\n' ${shellLiteral(input.hostToolLinks ?? "")}
    exit 0
  fi
  if ${input.hostToolSize === undefined ? "false" : "true"} &&
    [[ "\${1:-}" == "-Lc" && "\${2:-}" == "%s" ]]; then
    printf '%s\n' ${shellLiteral(input.hostToolSize ?? "")}
    exit 0
  fi
fi
if [[ ( "\${1:-}" == "-c" || "\${1:-}" == "-Lc" ) && "\${2:-}" == "%a" &&
  "\${!#}" == ${shellLiteral(path.join(clone, "scripts", "brev-launchable-ci-cpu.sh"))} ]]; then
  printf '%s\\n' ${shellLiteral((input.trackedFileMode ?? 0o644).toString(8))}
  exit 0
fi
if ${input.launchableAuthorityMode === undefined ? "false" : "true"} &&
  [[ "\${1:-}" == "-Lc" && "\${2:-}" == "%a" ]]; then
  printf '%s\\n' ${shellLiteral(input.launchableAuthorityMode ?? "")}
  exit 0
fi
if [[ "\${1:-}" == "-Lc" && "\${2:-}" == "%u:%g" &&
  "\${!#}" == *"/fd/255" ]]; then
  printf '%s\\n' ${shellLiteral(input.launchableAuthorityOwner ?? "0:0")}
  exit 0
fi
if [[ "\${1:-}" == "-Lc" && "\${2:-}" == "%u:%g" &&
  "\${!#}" == ${shellLiteral(launchableDescriptorAuthority)} ]]; then
  printf '%s\\n' ${shellLiteral(input.launchableAuthorityOwner ?? "0:0")}
  exit 0
fi
if ${input.launchableAuthorityLinks === undefined ? "false" : "true"} &&
  [[ "\${1:-}" == "-Lc" && "\${2:-}" == "%h" ]]; then
  printf '%s\\n' ${shellLiteral(input.launchableAuthorityLinks ?? "")}
  exit 0
fi
${
  process.platform === "darwin"
    ? `if [[ "\${1:-}" == "-Lc" && "\${2:-}" == "%d:%i:%f:%h:%s:%y:%z:%F" ]]; then
  if [[ "\${!#}" == "/dev/fd/8" ]]; then
    opened_inode="$(/usr/bin/stat -f '%i' "\${!#}")"
    for host_tool in \
      ${shellLiteral(path.join(bin, "node"))} \
      ${shellLiteral(path.join(bin, "docker"))} \
      ${shellLiteral(path.join(bin, "nvidia-smi"))} \
      ${shellLiteral(path.join(bin, "nvidia-ctk"))}; do
      if [[ "$(/usr/bin/stat -f '%i' "$host_tool")" == "$opened_inode" ]]; then
        exec /usr/bin/stat -f '%d:%i:%p:%l:%z:%m:%c:regular file' "$host_tool"
      fi
    done
    exit 98
  fi
  exec /usr/bin/stat -f '%d:%i:%p:%l:%z:%m:%c:regular file' "\${!#}"
fi
if [[ "\${1:-}" == "-Lc" && "\${2:-}" == "%a" ]]; then
  exec /usr/bin/stat -f '%Lp' "\${!#}"
fi
if [[ "\${1:-}" == "-Lc" && "\${2:-}" == "%h" ]]; then
  exec /usr/bin/stat -f '%l' "\${!#}"
fi
if [[ "\${1:-}" == "-Lc" && "\${2:-}" == "%s" ]]; then
  exec /usr/bin/stat -f '%z' "\${!#}"
fi
if [[ "\${1:-}" == "-c" && "\${2:-}" == "%a" ]]; then
  exec /usr/bin/stat -f '%Lp' "\${!#}"
fi`
    : ""
}
exec /usr/bin/stat "$@"
`,
  );
  executable(
    bin,
    "nvidia-smi",
    `#!/bin/sh
if ${input.mutateLaunchableDuringNvidiaSmi ? "true" : "false"} &&
  [ ! -e ${shellLiteral(launchableMutationMarker)} ]; then
  mutation_target=${
    process.platform === "darwin"
      ? shellLiteral(launchableDescriptorAuthority)
      : '"/proc/$PPID/fd/255"'
  }
  chmod 0755 "$mutation_target"
  printf '%s\\n' '# concurrent mutation' >> "$mutation_target"
  chmod 0555 "$mutation_target"
  printf mutated > ${shellLiteral(launchableMutationMarker)}
fi
${
  input.mutateHostToolDuringNvidiaSmi
    ? `if [ ! -e ${shellLiteral(launchableMutationMarker)} ]; then
  mutation_target=${shellLiteral(path.join(bin, input.mutateHostToolDuringNvidiaSmi))}
  chmod 0755 "$mutation_target"
  printf '%s\\n' '# concurrent host tool mutation' >> "$mutation_target"
  chmod 0555 "$mutation_target"
  printf mutated > ${shellLiteral(launchableMutationMarker)}
fi`
    : ""
}
case "$*" in
  *--query-gpu=name*) printf '%s\\n' 'NVIDIA A100-SXM4-80GB' ;;
  *--query-gpu=driver_version*) printf '%s\\n' '550.54.15' ;;
  *) printf '%s\\n' '| NVIDIA-SMI 550.54.15 Driver Version: 550.54.15 CUDA Version: 12.4 |' ;;
esac
`,
  );
  executable(
    bin,
    "nvidia-ctk",
    `#!/bin/sh
if [ "\${1:-}" = "--version" ]; then
  printf '%s\\n' 'NVIDIA Container Toolkit CLI version 1.17.5'
fi
`,
  );
  executable(bin, "docker", "#!/bin/sh\nexit 0\n");
  executable(
    bin,
    "jq",
    `#!/bin/bash
set -eu
while (( $# > 0 )); do
  case "$1" in
    --arg|--argjson)
      case "$2" in
        schemaVersion) schemaVersion="$3" ;;
        launchableVersion) launchableVersion="$3" ;;
        launchableDigest) launchableDigest="$3" ;;
        nemoclawCommit) nemoclawCommit="$3" ;;
        bundleReceiptSha256) bundleReceiptSha256="$3" ;;
        gpuCount) gpuCount="$3" ;;
        gpuModel) gpuModel="$3" ;;
        driverVersion) driverVersion="$3" ;;
        cudaVersion) cudaVersion="$3" ;;
        toolkitVersion) toolkitVersion="$3" ;;
        probeImageDigest) probeImageDigest="$3" ;;
        nodeToolDigest) nodeToolDigest="$3" ;;
        dockerToolDigest) dockerToolDigest="$3" ;;
        nvidiaSmiToolDigest) nvidiaSmiToolDigest="$3" ;;
        nvidiaCtkToolDigest) nvidiaCtkToolDigest="$3" ;;
        targetChannelProtocol) targetChannelProtocol="$3" ;;
        targetChannelServiceBundleDigest) targetChannelServiceBundleDigest="$3" ;;
        targetChannelTargetImageDigest) targetChannelTargetImageDigest="$3" ;;
      esac
      shift 3
      ;;
    *) shift ;;
  esac
done
printf '{"schemaVersion":"%s","kind":"cua-qualification-environment","launchable":{"version":"%s","digest":"%s"},"nemoclawCommit":"%s","bundleReceiptSha256":"%s","gpu":{"count":%s,"model":"%s","driverVersion":"%s","cudaVersion":"%s","containerToolkitVersion":"%s","probeImageDigest":"%s"},"hostTools":{"node":"%s","docker":"%s","nvidiaSmi":"%s","nvidiaCtk":"%s"},"targetChannel":{"schemaVersion":"1.0.0","kind":"cua-qualification-target-channel-identity","protocol":"%s","serviceBundleDigest":"%s","targetImageDigest":"%s"}}\n' \
  "$schemaVersion" \
  "$launchableVersion" \
  "$launchableDigest" \
  "$nemoclawCommit" \
  "$bundleReceiptSha256" \
  "$gpuCount" \
  "$gpuModel" \
  "$driverVersion" \
  "$cudaVersion" \
  "$toolkitVersion" \
  "$probeImageDigest" \
  "$nodeToolDigest" \
  "$dockerToolDigest" \
  "$nvidiaSmiToolDigest" \
  "$nvidiaCtkToolDigest" \
  "$targetChannelProtocol" \
  "$targetChannelServiceBundleDigest" \
  "$targetChannelTargetImageDigest"
`,
  );
  executable(bin, "findmnt", "#!/bin/sh\nexit 0\n");
  executable(bin, "unshare", "#!/bin/sh\nexit 0\n");
  executable(bin, "setpriv", "#!/bin/sh\nexit 0\n");
  executable(bin, "useradd", "#!/bin/sh\nexit 0\n");
  executable(
    bin,
    "id",
    `#!/bin/sh
if [ "\${1:-}" = "-G" ] && [ "\${2:-}" = "nemoclaw-cua-artifact" ]; then
  printf '%s\\n' '2000'
else
  exec /usr/bin/id "$@"
fi
`,
  );
  executable(
    bin,
    "realpath",
    `#!/bin/sh
target=''
for argument in "$@"; do target="$argument"; done
case "$target" in
  /proc/*/fd/255) printf '%s\\n' ${shellLiteral(fixtureScript)} ;;
  ${shellLiteral(path.join(bin, "node"))})
    printf '%s\\n' ${shellLiteral(
      input.nodeAuthorityPathMismatch ? path.join(bin, "docker") : path.join(bin, "node"),
    )}
    ;;
  *) printf '%s\\n' "$target" ;;
esac
`,
  );
  const forwardedHostCommands: Record<string, string | undefined> = {
    awk: "/usr/bin/awk",
    chmod: "/bin/chmod",
    chown: "/usr/sbin/chown",
    cmp: "/usr/bin/cmp",
    env: "/usr/bin/env",
    find: "/usr/bin/find",
    grep: "/usr/bin/grep",
    head: "/usr/bin/head",
    install: "/usr/bin/install",
    mkdir: "/bin/mkdir",
    mv: "/bin/mv",
    readlink: "/usr/bin/readlink",
    rm: "/bin/rm",
    sed: "/usr/bin/sed",
    sort: "/usr/bin/sort",
    sync: "/bin/sync",
    systemctl: undefined,
    tee: "/usr/bin/tee",
    true: "/usr/bin/true",
    tr: "/usr/bin/tr",
  };
  for (const [command, hostCommand] of Object.entries(forwardedHostCommands)) {
    if (fs.existsSync(path.join(bin, command))) continue;
    executable(
      bin,
      command,
      hostCommand === undefined
        ? "#!/bin/sh\nexit 0\n"
        : `#!/bin/sh\nexec ${shellLiteral(hostCommand)} "$@"\n`,
    );
  }
  for (const command of [
    "bash",
    "node",
    "docker",
    "nvidia-smi",
    "nvidia-ctk",
    ...Object.values(FIXED_HELPER_PATHS).map(([, command]) => command),
  ]) {
    executable(
      attackerBin,
      command,
      `#!/bin/sh
printf attacked > ${shellLiteral(attackerPathMarker)}
exit 91
`,
    );
  }
  executable(
    bin,
    "sudo",
    `#!/bin/bash
sudo_command="\${1##*/}"
if [[ "$sudo_command" == "env" ]]; then
  if [[ "\${CUA_TEST_ROOT_PEER_ACCEPTED:-0}" == "1" ]]; then
    exit 0
  fi
  exit 1
fi
if [[ "$sudo_command" == "docker" ]]; then
  shift
  for argument in "$@"; do
    printf '<%s>' "$argument" >> "$CUA_TEST_DOCKER_MARKER"
  done
  printf '\\n' >> "$CUA_TEST_DOCKER_MARKER"
  if [[ "\${1:-}" == "pull" ]]; then
    exit "\${CUA_TEST_DOCKER_PULL_STATUS:-0}"
  fi
  if [[ "\${1:-}" == "image" && "\${2:-}" == "inspect" ]]; then
    printf '%s\\n' "\${CUA_TEST_DOCKER_INSPECT_OUTPUT:-}"
    exit 0
  fi
  if [[ "\${1:-}" == "run" ]]; then
    exit "\${CUA_TEST_DOCKER_RUN_STATUS:-0}"
  fi
  exit 97
fi
if [[ "$sudo_command" == "install" && "\${!#}" == ${shellLiteral(cloneRoot)} ]]; then
  printf invoked > ${shellLiteral(cloneRootInstallMarker)}
fi
if [[ "$sudo_command" == "tee" ]]; then
  case "\${CUA_TEST_PUBLICATION_FAILURE:-}:\${!#}" in
    environment-tee:*cua-qualification-environment*) exit 61 ;;
    profile-tee:*nemoclaw-cua.*) exit 62 ;;
    sentinel-tee:*nemoclaw-cua-ready.*) exit 63 ;;
  esac
  printf written > "$CUA_TEST_ENVIRONMENT_MARKER"
  exec /usr/bin/tee "\${@:2}"
fi
if [[ "$sudo_command" == "mktemp" ]]; then
  exec /usr/bin/mktemp "\${@:2}"
fi
if [[ "$sudo_command" == "chmod" ]]; then
  exec /bin/chmod "\${@:2}"
fi
if [[ "$sudo_command" == "sync" ]]; then
  if [[ "\${CUA_TEST_PUBLICATION_FAILURE:-}" == "sentinel-sync" &&
    "\${!#}" == ${shellLiteral(path.dirname(sentinelFile))} ]]; then
    exit 68
  fi
  exit 0
fi
if [[ "$sudo_command" == "chown" || "$sudo_command" == "systemctl" ||
  "$sudo_command" == "nvidia-ctk" ]]; then
  exit 0
fi
if [[ "$sudo_command" == "mv" ]]; then
  destination="\${!#}"
  case "\${CUA_TEST_PUBLICATION_FAILURE:-}:$destination" in
    runner-move:${shellLiteral(artifactRunnerFile)}) exit 64 ;;
    environment-move:${shellLiteral(qualificationEnvironmentFile)}) exit 65 ;;
    profile-move:${shellLiteral(profileFile)}) exit 66 ;;
    sentinel-move:${shellLiteral(sentinelFile)}) exit 67 ;;
  esac
  shift
  args=()
  for argument in "$@"; do
    if [[ "$argument" == "-fT" ]]; then args+=("-f"); else args+=("$argument"); fi
  done
  exec /bin/mv "\${args[@]}"
fi
if [[ "$sudo_command" == "rm" ]]; then
  for argument in "$@"; do
    if [[ "$argument" == ${shellLiteral(qualificationEnvironmentFile)} ||
      "$argument" == ${shellLiteral(profileFile)} ||
      "$argument" == ${shellLiteral(sentinelFile)} ||
      "$argument" == ${shellLiteral(artifactRunnerFile)} ||
      "$argument" == ${shellLiteral(path.dirname(qualificationEnvironmentFile))}/* ||
      "$argument" == ${shellLiteral(path.dirname(profileFile))}/* ||
      "$argument" == ${shellLiteral(path.dirname(sentinelFile))}/* ||
      "$argument" == ${shellLiteral(path.dirname(artifactRunnerFile))}/* ]]; then
      /bin/rm -f -- "$argument"
    fi
  done
  exit 0
fi
if [[ "$sudo_command" == "install" && "\${2:-}" == "-d" ]]; then
  directory="\${!#}"
  if [[ "$directory" != ${shellLiteral(cloneRoot)} ]]; then
    /bin/mkdir -p "$directory"
    /bin/chmod 0755 "$directory"
  fi
  exit 0
fi
if [[ "$sudo_command" == "install" ]]; then
  source="\${@: -2:1}"
  destination="\${@: -1}"
  /bin/cp "$source" "$destination"
  /bin/chmod 0555 "$destination"
  exit 0
fi
exit 0
`,
  );
  executable(
    bin,
    "node",
    `#!/bin/sh
if [ "\${CUA_TEST_RUNTIME_AUTHORITY_OWNER:-0:0}" != "0:0" ]; then
  printf '%s\n' 'CUA runtime authority must be root-owned' >&2
  exit 74
fi
if [ -e "$CUA_TEST_NODE_MARKER" ]; then
  manifest_sha256="\${CUA_TEST_NODE_SECOND_MANIFEST_SHA256:-}"
  target_digest="\${CUA_TEST_NODE_SECOND_OUTPUT:-}"
  service_bundle_digest="\${CUA_TEST_NODE_SECOND_SERVICE_BUNDLE_OUTPUT:-}"
else
  manifest_sha256="\${CUA_TEST_NODE_MANIFEST_SHA256:-}"
  target_digest="\${CUA_TEST_NODE_OUTPUT:-}"
  service_bundle_digest="\${CUA_TEST_NODE_SERVICE_BUNDLE_OUTPUT:-}"
fi
printf invoked >> "$CUA_TEST_NODE_MARKER"
printf '%s\t%s\t%s' "$manifest_sha256" "$target_digest" "$service_bundle_digest"
exit "\${CUA_TEST_NODE_STATUS:-1}"
`,
  );

  let fixtureScriptSource = fs.readFileSync(SCRIPT, "utf8");
  fixtureScriptSource = replaceExactlyOnce(
    fixtureScriptSource,
    'readonly CUA_SENTINEL="/run/nemoclaw-cua-launchable-ready"',
    `readonly CUA_SENTINEL=${shellLiteral(sentinelFile)}`,
  );
  fixtureScriptSource = replaceExactlyOnce(
    fixtureScriptSource,
    'readonly QUALIFICATION_ENVIRONMENT_FILE="/etc/nemoclaw/cua-qualification-environment.json"',
    `readonly QUALIFICATION_ENVIRONMENT_FILE=${shellLiteral(qualificationEnvironmentFile)}`,
  );
  fixtureScriptSource = replaceExactlyOnce(
    fixtureScriptSource,
    'readonly CUA_PROFILE_FILE="/etc/profile.d/nemoclaw-cua.sh"',
    `readonly CUA_PROFILE_FILE=${shellLiteral(profileFile)}`,
  );
  fixtureScriptSource = replaceExactlyOnce(
    fixtureScriptSource,
    'readonly CUA_ARTIFACT_RUNNER="/usr/local/libexec/nemoclaw-cua-qualification-artifact-runner"',
    `readonly CUA_ARTIFACT_RUNNER=${shellLiteral(artifactRunnerFile)}`,
  );
  fixtureScriptSource = replaceExactlyOnce(
    fixtureScriptSource,
    'readonly CLONE_ROOT="/opt/nemoclaw-cua"',
    `readonly CLONE_ROOT=${shellLiteral(cloneRoot)}`,
  );
  fixtureScriptSource = replaceExactlyOnce(
    fixtureScriptSource,
    'readonly HOST_SYSTEM_PATH="/usr/sbin:/usr/bin:/sbin:/bin"',
    `readonly HOST_SYSTEM_PATH=${shellLiteral(safePath)}`,
  );
  fixtureScriptSource = replaceExactlyOnce(
    fixtureScriptSource,
    'readonly RUNTIME_TOOL_DISCOVERY_PATH="/usr/local/sbin:/usr/local/bin:${HOST_SYSTEM_PATH}"',
    `readonly RUNTIME_TOOL_DISCOVERY_PATH=${shellLiteral(safePath)}`,
  );
  fixtureScriptSource = replaceExactlyOnce(
    fixtureScriptSource,
    'readonly NODE_TARGET_BINARY="/usr/bin/node"',
    `readonly NODE_TARGET_BINARY=${shellLiteral(path.join(bin, "node"))}`,
  );
  for (const [variable, [source, command]] of Object.entries(FIXED_HELPER_PATHS)) {
    const fixtureAuthority =
      NATIVE_FIXTURE_HELPERS[variable as keyof typeof FIXED_HELPER_PATHS] ??
      path.join(bin, command);
    fixtureScriptSource = replaceExactlyOnce(
      fixtureScriptSource,
      `${variable}="${source}"`,
      `${variable}=${shellLiteral(fixtureAuthority)}`,
    );
  }
  if (!input.validateFixedHelpers) {
    const fixtureFunctionBody = (command: string): string =>
      fs
        .readFileSync(path.join(bin, command), "utf8")
        .split("\n")
        .slice(1)
        .join("\n")
        .replaceAll(/^(\s*)exit(?:\s+(.*))?$/gm, (_match, indent: string, status?: string) =>
          status === undefined ? `${indent}return` : `${indent}return ${status}`,
        )
        .replaceAll(/^(\s*)exec (\/[^\n]*)$/gm, "$1$2\n$1return $?");
    const fixtureStatFunction = fs
      .readFileSync(path.join(bin, "stat"), "utf8")
      .split("\n")
      .slice(1)
      .join("\n")
      .replaceAll(/\bexit ([0-9]+)/g, "return $1")
      .replaceAll(/^(\s*)exec (\/usr\/bin\/stat[^\n]*)$/gm, "$1$2\n$1return $?");
    const fixtureRealpathFunction = fs
      .readFileSync(path.join(bin, "realpath"), "utf8")
      .split("\n")
      .slice(1)
      .join("\n");
    const inlineHelpers = [
      ["fixture_getent", "GETENT_BINARY", "getent"],
      ["fixture_id", "ID_BINARY", "id"],
      ["fixture_jq", "JQ_BINARY", "jq"],
      ["fixture_sha256sum", "SHA256SUM_BINARY", "sha256sum"],
      ["fixture_sudo", "SUDO_BINARY", "sudo"],
    ] as const;
    const inlineHelperFunctions = inlineHelpers
      .map(
        ([functionName, _variable, command]) =>
          `${functionName}() (\n${fixtureFunctionBody(command)}\n)`,
      )
      .join("\n");
    const inlineHelperAssignments = inlineHelpers
      .map(([functionName, variable]) => `${variable}=${functionName}`)
      .join("\n");
    fixtureScriptSource = replaceExactlyOnce(
      fixtureScriptSource,
      'bootstrap_fixed_host_helpers \\\n  || fail "the Launchable image contains an untrusted fixed host helper authority"',
      `fixture_stat() {
${fixtureStatFunction}
}
fixture_realpath() {
${fixtureRealpathFunction}
}
${inlineHelperFunctions}
STAT_BINARY=fixture_stat
REALPATH_BINARY=fixture_realpath
${inlineHelperAssignments}
readonly STAT_BINARY REALPATH_BINARY "\${FIXED_HOST_HELPER_VARIABLES[@]}"`,
    );
  }
  fixtureScriptSource = replaceExactlyTwice(
    fixtureScriptSource,
    "/usr/bin/sha256sum %q",
    `${path.join(bin, "sha256sum")} %q`,
  );
  fixtureScriptSource = replaceExactlyOnce(
    fixtureScriptSource,
    `"$CUA_ARTIFACT_RUNNER" \\
  --no-target-channel \\
  --artifact-sha256 "$true_sha256" \\
  -- \\
  "$TRUE_BINARY" </dev/null \\
  || fail "the CUA qualification artifact isolation boundary is unavailable"`,
    '"$TRUE_BINARY" \\\n  || fail "the CUA qualification artifact isolation boundary is unavailable"',
  );
  fixtureScriptSource = replaceExactlyOnce(
    fixtureScriptSource,
    `target_channel_record="$({
  "$CUA_ARTIFACT_RUNNER" \\
    --require-target-channel \\
    --artifact-sha256 "$target_channel_probe_sha256" \\
    -- \\
    "$target_channel_probe_path" \\
    --isolated \\
    "$artifact_gid" \\
    "$service_bundle_digest" \\
    "$target_image_digest" </dev/null
})" || fail "the image-provided CUA qualification target channel is unavailable"`,
    'target_channel_record="$CUA_TEST_TARGET_CHANNEL_RECORD"',
  );
  if (process.platform === "darwin" && !input.stdinExecution) {
    fixtureScriptSource = replaceExactlyOnce(
      fixtureScriptSource,
      'readonly CUA_LAUNCHABLE_DESCRIPTOR="/proc/${CUA_LAUNCHABLE_BASH_PID}/fd/255"',
      `readonly CUA_LAUNCHABLE_DESCRIPTOR=${shellLiteral(launchableDescriptorAuthority)}`,
    );
  }
  fs.writeFileSync(fixtureScript, fixtureScriptSource, { mode: 0o555 });
  fs.copyFileSync(fixtureScript, launchableDescriptorAuthority);
  fs.chmodSync(launchableDescriptorAuthority, 0o555);

  const runtimeTargetDigest = input.nodeOutput ?? `sha256:${"c".repeat(64)}`;
  const runtimeServiceBundleDigest = input.nodeServiceBundleOutput ?? SERVICE_BUNDLE_DIGEST;
  const environment: NodeJS.ProcessEnv = {
    PATH: bin,
    NEMOCLAW_REF: COMMIT,
    NEMOCLAW_CUA_GPU_PROBE_IMAGE: PROBE_IMAGE,
    NEMOCLAW_CUA_RUNTIME_MANIFEST: "/opt/nemoclaw/cua-runtime/runtime-manifest.json",
    NEMOCLAW_CUA_RUNTIME_MANIFEST_SHA256: SHA256,
    NEMOCLAW_CUA_SANDBOX_IMAGE_REF: SANDBOX_IMAGE,
    NEMOCLAW_CUA_BUNDLE_RECEIPT_SHA256: SHA256,
    SUDO_USER: "fixture",
    CUA_TEST_NODE_MARKER: nodeMarker,
    CUA_TEST_NODE_STATUS: String(input.nodeStatus ?? 1),
    CUA_TEST_NODE_MANIFEST_SHA256: SHA256,
    CUA_TEST_NODE_OUTPUT: runtimeTargetDigest,
    CUA_TEST_NODE_SERVICE_BUNDLE_OUTPUT: runtimeServiceBundleDigest,
    CUA_TEST_NODE_SECOND_MANIFEST_SHA256: input.nodeSecondManifestSha256 ?? SHA256,
    CUA_TEST_NODE_SECOND_OUTPUT: input.nodeSecondOutput ?? runtimeTargetDigest,
    CUA_TEST_NODE_SECOND_SERVICE_BUNDLE_OUTPUT:
      input.nodeSecondServiceBundleOutput ?? runtimeServiceBundleDigest,
    CUA_TEST_TARGET_CHANNEL_RECORD:
      input.targetChannelRecord ??
      `{"schemaVersion":"1.0.0","kind":"cua-qualification-target-channel-identity","protocol":"cua.qualification.target-channel/v1","serviceBundleDigest":"${runtimeServiceBundleDigest}","targetImageDigest":"${runtimeTargetDigest}"}`,
    CUA_TEST_ROOT_PEER_ACCEPTED: input.rootPeerAccepted ? "1" : "0",
    CUA_TEST_RUNTIME_AUTHORITY_OWNER: input.runtimeAuthorityOwner ?? "0:0",
    CUA_TEST_ENVIRONMENT_MARKER: environmentMarker,
    CUA_TEST_DOCKER_MARKER: dockerMarker,
    CUA_TEST_DOCKER_INSPECT_OUTPUT: input.dockerInspectOutput ?? PROBE_IMAGE,
    CUA_TEST_DOCKER_PULL_STATUS: String(input.dockerPullStatus ?? 0),
    CUA_TEST_DOCKER_RUN_STATUS: String(input.dockerRunStatus ?? 0),
    CUA_TEST_PUBLICATION_FAILURE: input.publicationFailure ?? "",
    ...(cloneOverride === undefined ? {} : { NEMOCLAW_CLONE_DIR: cloneOverride }),
    ...input.gitEnvironment,
    ...(input.ambientPathAttack ? { PATH: attackerBin } : {}),
  };
  for (const [key, value] of Object.entries(input.environmentOverrides ?? {})) {
    if (value === undefined) delete environment[key];
    else environment[key] = value;
  }
  const result = input.stdinExecution
    ? spawnSync("/bin/bash", ["-s"], {
        encoding: "utf8",
        env: environment,
        input: fixtureScriptSource,
        timeout: 30_000,
      })
    : spawnSync(
        input.directExecution ? fixtureScript : "/bin/bash",
        input.directExecution ? [] : [fixtureScript],
        {
          encoding: "utf8",
          env: environment,
          timeout: 30_000,
        },
      );
  return {
    result,
    root,
    bin,
    home,
    clone,
    cloneRoot,
    bootstrap,
    symlinkVictim,
    gitMarker,
    gitCloneMarker,
    hookMarker,
    fsmonitorMarker,
    bootstrapModeMarker,
    replacementMarker,
    baseExecutionMarker,
    baseEnvironmentMarker,
    baseHome,
    baseLaunchLog,
    cloneRootInstallMarker,
    curlMarker,
    attackerPathMarker,
    nodeMarker,
    environmentMarker,
    qualificationEnvironmentFile,
    profileFile,
    sentinelFile,
    artifactRunnerFile,
    fixtureScript,
    launchableDescriptorAuthority,
    executingScriptCopy,
    launchableDigestSourceMarker,
    launchableDigestBytesMarker,
    launchableDigestValueMarker,
    launchableMutationMarker,
    dockerMarker,
  };
}

describe("CUA GPU Brev Launchable (#7753)", { timeout: CUA_LAUNCHABLE_TEST_TIMEOUT_MS }, () => {
  it("rejects a mutable candidate before invoking Launchable prerequisites", () => {
    const fixture = runCandidateFixture({ environmentOverrides: { NEMOCLAW_REF: "main" } });
    try {
      expect(fixture.result.status, fixture.result.stderr).toBe(1);
      expect(fixture.result.stderr).toContain(
        "NEMOCLAW_REF must be an exact lowercase 40-hex commit",
      );
      expect(fixture.result.stderr).not.toContain("does not expose nvidia-smi");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("requires an immutable GPU probe image before invoking Launchable prerequisites", () => {
    const fixture = runCandidateFixture({
      environmentOverrides: { NEMOCLAW_CUA_GPU_PROBE_IMAGE: undefined },
    });
    try {
      expect(fixture.result.status).toBe(1);
      expect(fixture.result.stderr).toContain(
        "NEMOCLAW_CUA_GPU_PROBE_IMAGE must be an immutable OCI digest reference",
      );
      expect(fixture.result.stderr).not.toContain("does not expose nvidia-smi");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "NEMOCLAW_CUA_RUNTIME_MANIFEST",
      {
        NEMOCLAW_REF: COMMIT,
        NEMOCLAW_CUA_GPU_PROBE_IMAGE: PROBE_IMAGE,
      },
      "NEMOCLAW_CUA_RUNTIME_MANIFEST must be one canonical absolute path",
    ],
    [
      "NEMOCLAW_CUA_RUNTIME_MANIFEST_SHA256",
      {
        NEMOCLAW_REF: COMMIT,
        NEMOCLAW_CUA_GPU_PROBE_IMAGE: PROBE_IMAGE,
        NEMOCLAW_CUA_RUNTIME_MANIFEST: "/opt/nemoclaw/cua-runtime/runtime-manifest.json",
      },
      "NEMOCLAW_CUA_RUNTIME_MANIFEST_SHA256 must be a lowercase SHA-256",
    ],
    [
      "NEMOCLAW_CUA_SANDBOX_IMAGE_REF",
      {
        NEMOCLAW_REF: COMMIT,
        NEMOCLAW_CUA_GPU_PROBE_IMAGE: PROBE_IMAGE,
        NEMOCLAW_CUA_RUNTIME_MANIFEST: "/opt/nemoclaw/cua-runtime/runtime-manifest.json",
        NEMOCLAW_CUA_RUNTIME_MANIFEST_SHA256: SHA256,
      },
      "NEMOCLAW_CUA_SANDBOX_IMAGE_REF must be an immutable OCI digest reference",
    ],
    [
      "NEMOCLAW_CUA_BUNDLE_RECEIPT_SHA256",
      {
        NEMOCLAW_REF: COMMIT,
        NEMOCLAW_CUA_GPU_PROBE_IMAGE: PROBE_IMAGE,
        NEMOCLAW_CUA_RUNTIME_MANIFEST: "/opt/nemoclaw/cua-runtime/runtime-manifest.json",
        NEMOCLAW_CUA_RUNTIME_MANIFEST_SHA256: SHA256,
        NEMOCLAW_CUA_SANDBOX_IMAGE_REF: SANDBOX_IMAGE,
      },
      "NEMOCLAW_CUA_BUNDLE_RECEIPT_SHA256 must be a lowercase SHA-256",
    ],
  ])("requires immutable %s before invoking host prerequisites (#7753)", (_name, env, message) => {
    const fixture = runCandidateFixture({
      environmentOverrides: { ...env, [_name]: undefined },
    });
    try {
      expect(fixture.result.status).toBe(1);
      expect(fixture.result.stderr).toContain(message);
      expect(fixture.result.stderr).not.toContain("does not expose nvidia-smi");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it.each([
    "environment",
    "profile",
    "sentinel",
    "runner",
  ] as const)("atomically replaces a pre-positioned %s publication symlink without touching its target", (publicationSymlink) => {
    const fixture = runCandidateFixture({ nodeStatus: 0, publicationSymlink });
    try {
      expect(fixture.result.status, fixture.result.stderr).toBe(0);
      expect(fs.readFileSync(fixture.symlinkVictim, "utf8")).toBe("unchanged");
      const published =
        publicationSymlink === "environment"
          ? fixture.qualificationEnvironmentFile
          : publicationSymlink === "profile"
            ? fixture.profileFile
            : publicationSymlink === "sentinel"
              ? fixture.sentinelFile
              : fixture.artifactRunnerFile;
      const stat = fs.lstatSync(published);
      expect(stat.isFile()).toBe(true);
      expect(stat.isSymbolicLink()).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("is valid shell syntax", () => {
    const result = spawnSync("bash", ["-n", SCRIPT], {
      encoding: "utf8",
      timeout: 10_000,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  // source-shape-contract: security -- Exact privileged helper paths prevent caller PATH from replacing launch authority
  it("pins the privileged interpreter and fixed host helpers outside caller PATH", () => {
    const source = fs.readFileSync(SCRIPT, "utf8");
    const helperCommands = new Set(
      Object.values(FIXED_HELPER_PATHS)
        .map(([, command]) => command)
        .filter((command) => command !== "true"),
    );
    const unqualifiedCommands: string[] = [];
    for (const [index, line] of source.split("\n").entries()) {
      const code = line.trimStart();
      if (code.startsWith("#")) continue;
      for (const command of helperCommands) {
        const commandPattern = new RegExp(
          `(?:^|[|;&(]\\s*)${command.replaceAll("-", "\\-")}(?=\\s|$)`,
        );
        if (commandPattern.test(code)) unqualifiedCommands.push(`${index + 1}:${command}`);
      }
    }

    expect(source.startsWith("#!/bin/bash\n")).toBe(true);
    expect(unqualifiedCommands).toEqual([]);
    expect(source.match(/command -v/g)).toHaveLength(1);
    expect(source).toContain(
      'discovered="$(PATH="$RUNTIME_TOOL_DISCOVERY_PATH" command -v -- "$command_name")"',
    );
    expect(source).toContain('readonly HOST_SYSTEM_PATH="/usr/sbin:/usr/bin:/sbin:/bin"');
  });

  // source-shape-contract: security -- Shipped launch bytes must bind every privileged artifact execution to reviewed digests
  it("binds every qualification artifact execution to the exact source digest", () => {
    const source = fs.readFileSync(SCRIPT, "utf8");

    expect(source.match(/--artifact-sha256/g)).toHaveLength(2);
    expect(source).toContain('--artifact-sha256 "$true_sha256"');
    expect(source).toContain('--artifact-sha256 "$target_channel_probe_sha256"');
    expect(source).toContain(
      'target_channel_probe_path="$clone_dir/scripts/cua-qualification-target-channel-probe.ts"',
    );
    expect(source).toContain('"$SHA256SUM_BINARY" -- "$target_channel_probe_path"');
  });

  it("rejects stdin execution because it has no stable regular Launchable descriptor", () => {
    const fixture = runCandidateFixture({ stdinExecution: true });
    try {
      expect(fixture.result.status).toBe(1);
      expect(fixture.result.stderr).toContain(
        "Launchable must be executed from a supported regular file descriptor",
      );
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  // source-shape-contract: security -- The production launcher must reject Git replacement objects before privileged setup
  it("rejects a real Git replacement that conceals replacement-controlled source bytes", () => {
    const fixture = runRealCheckoutVerifier(SCRIPT, "--replace-head");
    try {
      expect(fixture.result.status).not.toBe(0);
    } finally {
      fixture.cleanup();
    }
  });

  it.each([
    ["an unsafe mode", { launchableAuthorityMode: "0777" }, "file mode is unsafe"],
    ["an owner-writable mode", { launchableAuthorityMode: "0755" }, "file mode is unsafe"],
    [
      "a non-root owner",
      { launchableAuthorityOwner: "1000:1000" },
      "executing Launchable must be root-owned",
    ],
    [
      "a non-root path ancestor",
      { launchableAncestorOwner: "1000:1000" },
      "executing Launchable path has an untrusted ancestor",
    ],
    [
      "a writable path ancestor",
      { launchableAncestorMode: "0777" },
      "executing Launchable path has an untrusted ancestor",
    ],
    ["multiple hard links", { launchableAuthorityLinks: "2" }, "one authority link"],
  ])("rejects an executing Launchable with %s", (_label, input, message) => {
    const fixture = runCandidateFixture(input);
    try {
      expect(fixture.result.status).toBe(1);
      expect(fixture.result.stderr).toContain(message);
      expect(fs.existsSync(fixture.curlMarker)).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it.each([
    ["a non-root owner", { hostToolOwner: "1000:1000" }],
    ["group-writable permissions", { hostToolMode: "0775" }],
    ["special permissions", { hostToolMode: "4755" }],
    ["multiple authority links", { hostToolLinks: "2" }],
    ["an empty executable", { hostToolSize: "0" }],
    ["an oversized executable", { hostToolSize: "268435457" }],
  ])("rejects a qualification host tool with %s", (_label, input) => {
    const fixture = runCandidateFixture(input);
    try {
      expect(fixture.result.status).toBe(1);
      expect(fixture.result.stderr).toContain(
        "qualification Node executable is not a trusted root authority",
      );
      expect(fs.existsSync(fixture.nodeMarker)).toBe(false);
      expect(fs.existsSync(fixture.environmentMarker)).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects a Node authority that does not match the target-channel interpreter", () => {
    const fixture = runCandidateFixture({ nodeAuthorityPathMismatch: true });
    try {
      expect(fixture.result.status).toBe(1);
      expect(fixture.result.stderr).toContain(
        "qualification Node executable must resolve to /usr/bin/node for the target-channel probe",
      );
      expect(fs.existsSync(fixture.nodeMarker)).toBe(false);
      expect(fs.existsSync(fixture.environmentMarker)).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects executing bytes that differ from the exact candidate Launchable", () => {
    const fixture = runCandidateFixture({ candidateLaunchableSource: "#!/bin/bash\nexit 0\n" });
    try {
      expect(fixture.result.status).toBe(1);
      expect(fixture.result.stderr).toContain(
        "executing Launchable does not match the exact candidate checkout",
      );
      expect(fs.existsSync(fixture.baseExecutionMarker)).toBe(false);
      expect(fs.existsSync(fixture.nodeMarker)).toBe(false);
      expect(fs.existsSync(fixture.dockerMarker)).toBe(false);
      expect(fs.existsSync(fixture.environmentMarker)).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it.each([
    ["assume-unchanged", "h"],
    ["skip-worktree", "S"],
  ])("rejects a %s index flag before executing candidate bootstrap bytes", (_label, tag) => {
    const fixture = runCandidateFixture({ gitIndexTag: tag });
    try {
      expect(fixture.result.status).toBe(1);
      expect(fixture.result.stderr).toContain("installed checkout is not an exact clean candidate");
      expect(fs.existsSync(fixture.baseExecutionMarker)).toBe(false);
      expect(fs.existsSync(fixture.nodeMarker)).toBe(false);
      expect(fs.existsSync(fixture.dockerMarker)).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  // source-shape-contract: security -- A real clean checkout proves the production verifier accepts only exact source bytes
  it("accepts an exact checkout through the production verifier with real Git", () => {
    const fixture = runRealCheckoutVerifier(SCRIPT);
    try {
      expect(fixture.result.status, fixture.result.stderr).toBe(0);
    } finally {
      fixture.cleanup();
    }
  });

  // source-shape-contract: security -- Real Git concealment flags must remain rejected by the production bootstrap verifier
  it.each([
    "--assume-unchanged",
    "--skip-worktree",
  ] as const)("rejects real Git %s concealment in the production bootstrap verifier", (indexFlag) => {
    const fixture = runRealCheckoutVerifier(SCRIPT, indexFlag);
    try {
      expect(fixture.result.status).not.toBe(0);
    } finally {
      fixture.cleanup();
    }
  });

  it.each([
    ["index bytes", { gitIndexDiffStatus: 1 }],
    ["tracked filesystem bytes", { gitAuthoritativeSource: "replacement-controlled source\n" }],
  ])("rejects mismatched %s before executing candidate bootstrap bytes", (_label, input) => {
    const fixture = runCandidateFixture(input);
    try {
      expect(fixture.result.status).toBe(1);
      expect(fixture.result.stderr).toContain("installed checkout is not an exact clean candidate");
      expect(fs.existsSync(fixture.baseExecutionMarker)).toBe(false);
      expect(fs.existsSync(fixture.nodeMarker)).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it.each([
    ["0664", 0o664],
    ["0646", 0o646],
    ["4644", 0o4644],
    ["2644", 0o2644],
    ["1644", 0o1644],
  ])("rejects unsafe tracked mode %s before executing candidate bootstrap bytes", (_label, trackedFileMode) => {
    const fixture = runCandidateFixture({ trackedFileMode });
    try {
      expect(fixture.result.status).toBe(1);
      expect(fixture.result.stderr).toContain("installed checkout is not an exact clean candidate");
      expect(fs.existsSync(fixture.baseExecutionMarker)).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("accepts a read-only exact tracked file through pre-bootstrap verification", () => {
    const fixture = runCandidateFixture({ trackedFileMode: 0o444 });
    try {
      expect(fixture.result.status).toBe(1);
      expect(fixture.result.stderr).toContain(
        "sanitized CUA runtime payload failed exact candidate validation",
      );
      expect(fs.readFileSync(fixture.baseExecutionMarker, "utf8")).toMatch(/^\/dev\/fd\/\d+$/);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it.each([
    ["an empty override", () => ""],
    ["an option-like relative path", () => "--config=core.hooksPath=/attacker"],
    ["a relative path", () => "relative/clone"],
    ["path traversal", ({ home }: { home: string }) => `${home}/../outside/clone`],
    [
      "an absolute path outside the target home",
      ({ outside }: { outside: string }) => path.join(outside, "clone"),
    ],
    [
      "a symbolic-link ancestor",
      ({ home, outside }: { home: string; outside: string }) => {
        const linked = path.join(home, "linked");
        fs.symlinkSync(outside, linked);
        return path.join(linked, "clone");
      },
    ],
  ])("rejects %s clone override before download or Git execution", (_label, cloneDirectory) => {
    const fixture = runCandidateFixture({ cloneDirectory });
    try {
      expect(fixture.result.status).toBe(1);
      expect(fixture.result.stderr).toContain(
        "NEMOCLAW_CLONE_DIR must not be set for CUA qualification",
      );
      expect(fs.existsSync(fixture.curlMarker)).toBe(false);
      expect(fs.existsSync(fixture.gitMarker)).toBe(false);
      expect(fs.existsSync(fixture.cloneRootInstallMarker)).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "an untrusted clone parent",
      { cloneParentIdentity: "1000:1000:755:directory" },
      "clone parent must remain root-owned and non-writable",
    ],
    [
      "a writable clone parent",
      { cloneParentIdentity: "0:0:777:directory" },
      "clone parent must remain root-owned and non-writable",
    ],
    [
      "an untrusted clone root",
      { cloneRootIdentity: "1000:1000:755:directory" },
      "clone root must remain root-owned and non-writable",
    ],
    [
      "a writable clone root",
      { cloneRootIdentity: "0:0:775:directory" },
      "clone root must remain root-owned and non-writable",
    ],
  ])("rejects %s before download or Git execution", (_label, input, message) => {
    const fixture = runCandidateFixture(input);
    try {
      expect(fixture.result.status).toBe(1);
      expect(fixture.result.stderr).toContain(message);
      expect(fs.existsSync(fixture.curlMarker)).toBe(false);
      expect(fs.existsSync(fixture.gitMarker)).toBe(false);
      expect(fs.existsSync(fixture.cloneRootInstallMarker)).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects an existing clone-root symlink without passing it to install", () => {
    const fixture = runCandidateFixture({ symlinkCloneRoot: true });
    try {
      expect(fixture.result.status).toBe(1);
      expect(fixture.result.stderr).toContain("clone root is not a regular directory");
      expect(fs.existsSync(fixture.curlMarker)).toBe(false);
      expect(fs.existsSync(fixture.gitMarker)).toBe(false);
      expect(fs.existsSync(fixture.cloneRootInstallMarker)).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("does not follow a pre-positioned bootstrap symlink", () => {
    const fixture = runCandidateFixture({ precreateBaseSymlink: true });
    try {
      expect(fixture.result.status).toBe(1);
      expect(fixture.result.stderr).toContain(
        "exact base Launchable script could not be downloaded privately",
      );
      expect(fs.readFileSync(fixture.symlinkVictim, "utf8")).toBe("unchanged");
      expect(fs.existsSync(fixture.curlMarker)).toBe(false);
      expect(fs.existsSync(fixture.gitMarker)).toBe(false);
      expect(fs.existsSync(fixture.bootstrap)).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("executes the opened bootstrap descriptor after its pathname is replaced", () => {
    const fixture = runCandidateFixture({ replaceBaseDuringGit: true });
    try {
      expect(fixture.result.status).toBe(1);
      expect(fixture.result.stderr).toContain(
        "sanitized CUA runtime payload failed exact candidate validation",
      );
      expect(fs.readFileSync(fixture.baseExecutionMarker, "utf8")).toMatch(/^\/dev\/fd\/\d+$/);
      expect(fs.readFileSync(fixture.baseEnvironmentMarker, "utf8")).toBe("safe");
      expect(fs.existsSync(fixture.replacementMarker)).toBe(false);
      expect(fs.existsSync(fixture.bootstrapModeMarker)).toBe(false);
      expect(fs.existsSync(fixture.cloneRootInstallMarker)).toBe(false);
      expect(fs.existsSync(fixture.bootstrap)).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("hashes the executing Launchable descriptor after its pathname is replaced", () => {
    const fixture = runCandidateFixture({ replaceLaunchableDuringCurl: true });
    try {
      expect(fixture.result.status).toBe(1);
      expect(fixture.result.stderr).toContain(
        "sanitized CUA runtime payload failed exact candidate validation",
      );
      const digestSource = fs.readFileSync(fixture.launchableDigestSourceMarker, "utf8");
      if (process.platform === "darwin") {
        expect(digestSource).toBe(fixture.launchableDescriptorAuthority);
      } else {
        expect(digestSource).toMatch(/^\/proc\/[0-9]+\/fd\/255$/);
      }
      expect(fs.readFileSync(fixture.launchableDigestBytesMarker, "utf8")).toBe("exact");
      expect(fs.readFileSync(fixture.launchableDigestValueMarker, "utf8")).toBe(
        createHash("sha256").update(fs.readFileSync(fixture.executingScriptCopy)).digest("hex"),
      );
      expect(fs.readFileSync(fixture.fixtureScript, "utf8")).toContain("exit 91");
      expect(fs.readFileSync(fixture.baseExecutionMarker, "utf8")).toMatch(/^\/dev\/fd\/\d+$/);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects an in-place post-hash mutation before any privileged CUA state is published", () => {
    const fixture = runCandidateFixture({
      mutateLaunchableDuringNvidiaSmi: true,
      nodeStatus: 0,
    });
    try {
      expect(fixture.result.status).toBe(1);
      expect(fixture.result.stderr).toContain(
        "executing Launchable authority changed before publication",
      );
      expect(fs.readFileSync(fixture.launchableMutationMarker, "utf8")).toBe("mutated");
      expect(fs.existsSync(fixture.qualificationEnvironmentFile)).toBe(false);
      expect(fs.existsSync(fixture.profileFile)).toBe(false);
      expect(fs.existsSync(fixture.sentinelFile)).toBe(false);
      expect(fs.existsSync(fixture.environmentMarker)).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it.each([
    ["manifest", { nodeSecondManifestSha256: "f".repeat(64) }],
    ["target image", { nodeSecondOutput: `sha256:${"f".repeat(64)}` }],
    ["service bundle", { nodeSecondServiceBundleOutput: `sha256:${"f".repeat(64)}` }],
  ])(
    "rejects a changed runtime %s during immediate prepublication revalidation",
    (_label, input) => {
      const fixture = runCandidateFixture({ nodeStatus: 0, ...input });
      try {
        expect(fixture.result.status).toBe(1);
        expect(fixture.result.stderr).toContain(
          "CUA runtime manifest, target image, or service bundle changed before publication",
        );
        expect(fs.readFileSync(fixture.nodeMarker, "utf8")).toBe("invokedinvoked");
        expect(fs.existsSync(fixture.qualificationEnvironmentFile)).toBe(false);
        expect(fs.existsSync(fixture.profileFile)).toBe(false);
        expect(fs.existsSync(fixture.sentinelFile)).toBe(false);
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it.each([
    ["missing", ""],
    [
      "service bundle mismatch",
      `{"schemaVersion":"1.0.0","kind":"cua-qualification-target-channel-identity","protocol":"cua.qualification.target-channel/v1","serviceBundleDigest":"sha256:${"f".repeat(64)}","targetImageDigest":"sha256:${"c".repeat(64)}"}`,
    ],
    [
      "target image mismatch",
      `{"schemaVersion":"1.0.0","kind":"cua-qualification-target-channel-identity","protocol":"cua.qualification.target-channel/v1","serviceBundleDigest":"${SERVICE_BUNDLE_DIGEST}","targetImageDigest":"sha256:${"f".repeat(64)}"}`,
    ],
  ])(
    "rejects a %s target-channel identity before qualification publication",
    (_label, record) => {
      const fixture = runCandidateFixture({ nodeStatus: 0, targetChannelRecord: record });
      try {
        expect(fixture.result.status).toBe(1);
        expect(fixture.result.stderr).toContain(
          "image-provided CUA qualification target channel identity is invalid",
        );
        expect(fs.existsSync(fixture.qualificationEnvironmentFile)).toBe(false);
        expect(fs.existsSync(fixture.profileFile)).toBe(false);
        expect(fs.existsSync(fixture.sentinelFile)).toBe(false);
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it("rejects a target channel that accepts the privileged controller peer", () => {
    const fixture = runCandidateFixture({ nodeStatus: 0, rootPeerAccepted: true });
    try {
      expect(fixture.result.status).toBe(1);
      expect(fixture.result.stderr).toContain(
        "CUA qualification target channel accepts an unauthorized root peer",
      );
      expect(fs.existsSync(fixture.qualificationEnvironmentFile)).toBe(false);
      expect(fs.existsSync(fixture.profileFile)).toBe(false);
      expect(fs.existsSync(fixture.sentinelFile)).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 60_000);

  it("rejects a GPU probe digest that differs from the pinned target image manifest", () => {
    const fixture = runCandidateFixture({
      nodeStatus: 0,
      nodeOutput: `sha256:${"f".repeat(64)}`,
    });
    try {
      expect(fixture.result.status).toBe(1);
      expect(fixture.result.stderr).toContain(
        "GPU probe image does not match the pinned target image manifest digest",
      );
      expect(fs.existsSync(fixture.dockerMarker)).toBe(false);
      expect(fs.existsSync(fixture.environmentMarker)).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects a pulled probe whose inspected identities omit the pinned manifest", () => {
    const fixture = runCandidateFixture({
      nodeStatus: 0,
      dockerInspectOutput: `nvcr.io/nvidia/cuda@sha256:${"f".repeat(64)}`,
    });
    try {
      expect(fixture.result.status).toBe(1);
      expect(fixture.result.stderr).toContain(
        "pulled GPU probe image does not expose the pinned manifest identity",
      );
      expect(fs.readFileSync(fixture.dockerMarker, "utf8").trim().split("\n")).toEqual([
        `<pull><--quiet><${PROBE_IMAGE}>`,
        `<image><inspect><--format><{{range .RepoDigests}}{{println .}}{{end}}><${PROBE_IMAGE}>`,
      ]);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("pulls and inspects before running the pinned probe under the bounded profile", () => {
    const fixture = runCandidateFixture({ nodeStatus: 0, dockerRunStatus: 17 });
    try {
      expect(fixture.result.status).toBe(1);
      expect(fixture.result.stderr).toContain("bounded pinned GPU probe failed");
      expect(fs.readFileSync(fixture.dockerMarker, "utf8").trim().split("\n")).toEqual([
        `<pull><--quiet><${PROBE_IMAGE}>`,
        `<image><inspect><--format><{{range .RepoDigests}}{{println .}}{{end}}><${PROBE_IMAGE}>`,
        `<run><--rm><--pull=never><--gpus=all><--env=NVIDIA_VISIBLE_DEVICES=all><--env=NVIDIA_DRIVER_CAPABILITIES=utility><--network=none><--read-only><--cap-drop=ALL><--security-opt=no-new-privileges=true><--pids-limit=32><--cpus=1.0><--memory=256m><--ulimit=nofile=64:64><--user=65534:65534><--entrypoint=/usr/bin/nvidia-smi><${PROBE_IMAGE}>`,
      ]);
      expect(fs.existsSync(fixture.environmentMarker)).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("publishes one content-bound root authority tuple and activates only while it matches", () => {
    const fixture = runCandidateFixture({ nodeStatus: 0 });
    try {
      expect(fixture.result.status, fixture.result.stderr).toBe(0);
      expect(fixture.result.stdout).toContain(`ready (version 1.0.0, candidate ${COMMIT})`);
      for (const file of [
        fixture.qualificationEnvironmentFile,
        fixture.profileFile,
        fixture.sentinelFile,
      ]) {
        const stat = fs.lstatSync(file);
        expect(stat.isFile()).toBe(true);
        expect(stat.isSymbolicLink()).toBe(false);
        expect(stat.mode & 0o777).toBe(0o444);
      }

      const qualificationEnvironment = JSON.parse(
        fs.readFileSync(fixture.qualificationEnvironmentFile, "utf8"),
      ) as {
        hostTools: Record<string, string>;
        targetChannel: Record<string, string>;
      };
      expect(fs.readFileSync(fixture.nodeMarker, "utf8")).toBe("invokedinvoked");
      expect(qualificationEnvironment.hostTools).toEqual({
        node: fileSha256(path.join(fixture.bin, "node")),
        docker: fileSha256(path.join(fixture.bin, "docker")),
        nvidiaSmi: fileSha256(path.join(fixture.bin, "nvidia-smi")),
        nvidiaCtk: fileSha256(path.join(fixture.bin, "nvidia-ctk")),
      });
      expect(qualificationEnvironment.targetChannel).toEqual({
        schemaVersion: "1.0.0",
        kind: "cua-qualification-target-channel-identity",
        protocol: "cua.qualification.target-channel/v1",
        serviceBundleDigest: SERVICE_BUNDLE_DIGEST,
        targetImageDigest: `sha256:${"c".repeat(64)}`,
      });

      const environmentDigest = fileSha256(fixture.qualificationEnvironmentFile).slice(7);
      const profileDigest = fileSha256(fixture.profileFile).slice(7);
      const sentinel = fs.readFileSync(fixture.sentinelFile, "utf8").trimEnd().split("\n");
      expect(sentinel).toHaveLength(2);
      expect(sentinel[0]).toBe(
        `nemoclaw-cua-launchable-ready/v1 commit=${COMMIT} environment=sha256:${environmentDigest} launchable=${fileSha256(fixture.launchableDescriptorAuthority)}`,
      );
      expect(sentinel[1]).toBe(`profile=sha256:${profileDigest}`);

      const enabled = spawnSync(
        "/bin/sh",
        [
          "-c",
          `. ${shellLiteral(fixture.profileFile)}; printf '%s\\n' \
              "\${NEMOCLAW_CUA_ENABLED:-}" \
              "\${NEMOCLAW_CUA_QUALIFICATION:-}" \
              "\${NEMOCLAW_AGENT:-}" \
              "\${NEMOCLAW_CUA_RUNTIME_MANIFEST:-}" \
              "\${NEMOCLAW_CUA_RUNTIME_MANIFEST_SHA256:-}" \
              "\${NEMOCLAW_CUA_SANDBOX_IMAGE_REF:-}" \
              "\${NEMOCLAW_CUA_DOCKER_BIN:-}" \
              "\${NEMOCLAW_CUA_NVIDIA_SMI_BIN:-}" \
              "\${NEMOCLAW_CUA_NVIDIA_CTK_BIN:-}" \
              "\${NEMOCLAW_CUA_QUALIFICATION_ENVIRONMENT:-}" \
              "\${NEMOCLAW_CUA_QUALIFICATION_ARTIFACT_RUNNER:-}"`,
        ],
        { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } },
      );
      expect(enabled.status, enabled.stderr).toBe(0);
      expect(enabled.stdout.trimEnd().split("\n")).toEqual([
        "1",
        "1",
        "nemocua",
        "/opt/nemoclaw/cua-runtime/runtime-manifest.json",
        SHA256,
        SANDBOX_IMAGE,
        path.join(fixture.bin, "docker"),
        path.join(fixture.bin, "nvidia-smi"),
        path.join(fixture.bin, "nvidia-ctk"),
        fixture.qualificationEnvironmentFile,
        fixture.artifactRunnerFile,
      ]);

      const originals = new Map(
        [fixture.qualificationEnvironmentFile, fixture.profileFile, fixture.sentinelFile].map(
          (file) => [file, fs.readFileSync(file, "utf8")] as const,
        ),
      );
      const rewriteAuthority = (file: string, contents: string): void => {
        fs.chmodSync(file, 0o644);
        fs.writeFileSync(file, contents);
        fs.chmodSync(file, 0o444);
      };
      const activateFlags = () =>
        spawnSync(
          "/bin/sh",
          [
            "-c",
            `. ${shellLiteral(fixture.profileFile)}; printf '%s:%s' "\${NEMOCLAW_CUA_ENABLED:-}" "\${NEMOCLAW_CUA_QUALIFICATION:-}"`,
          ],
          { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } },
        );
      const mutations: [string, string][] = [
        [
          fixture.qualificationEnvironmentFile,
          `${originals.get(fixture.qualificationEnvironmentFile)!}tampered\n`,
        ],
        [fixture.profileFile, `${originals.get(fixture.profileFile)!}# tampered\n`],
        [
          fixture.sentinelFile,
          originals
            .get(fixture.sentinelFile)!
            .replace("nemoclaw-cua-launchable-ready/v1", "nemoclaw-cua-launchable-ready/v2"),
        ],
        [
          fixture.sentinelFile,
          originals
            .get(fixture.sentinelFile)!
            .replace(`profile=sha256:${profileDigest}`, `profile=sha256:${"0".repeat(64)}`),
        ],
        [fixture.sentinelFile, `${originals.get(fixture.sentinelFile)!}extra\n`],
      ];
      for (const [file, contents] of mutations) {
        for (const [authority, original] of originals) rewriteAuthority(authority, original);
        rewriteAuthority(file, contents);
        const disabled = activateFlags();
        expect(disabled.status, disabled.stderr.toString()).toBe(0);
        expect(disabled.stdout).toBe(":");
      }
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 60_000);

  it.each([
    "node",
    "docker",
    "nvidia-ctk",
  ] as const)("rejects a mutated %s authority immediately before atomic publication", (hostTool) => {
    const fixture = runCandidateFixture({
      nodeStatus: 0,
      mutateHostToolDuringNvidiaSmi: hostTool,
    });
    try {
      expect(fixture.result.status).toBe(1);
      expect(fixture.result.stderr).toContain(
        "a qualification host executable changed before publication",
      );
      expect(fs.existsSync(fixture.qualificationEnvironmentFile)).toBe(false);
      expect(fs.existsSync(fixture.profileFile)).toBe(false);
      expect(fs.existsSync(fixture.sentinelFile)).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 60_000);

  it.each([
    "runner-move",
    "environment-tee",
    "environment-move",
    "profile-tee",
    "profile-move",
    "sentinel-tee",
    "sentinel-move",
    "sentinel-sync",
  ] as const)("revokes stale CUA state when %s publication fails", (publicationFailure) => {
    const fixture = runCandidateFixture({ nodeStatus: 0, publicationFailure });
    try {
      expect(fixture.result.status).not.toBe(0);
      for (const file of [
        fixture.qualificationEnvironmentFile,
        fixture.profileFile,
        fixture.sentinelFile,
        fixture.artifactRunnerFile,
      ]) {
        expect(fs.existsSync(file)).toBe(false);
      }
      for (const directory of [
        path.dirname(fixture.qualificationEnvironmentFile),
        path.dirname(fixture.profileFile),
        path.dirname(fixture.sentinelFile),
        path.dirname(fixture.artifactRunnerFile),
      ]) {
        expect(fs.readdirSync(directory).filter((entry) => entry.startsWith("."))).toEqual([]);
      }
      expect(fs.existsSync(fixture.bootstrap)).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 60_000);

  it("directly executes without resolving the interpreter or fixed helpers through caller PATH", () => {
    const fixture = runCandidateFixture({
      ambientPathAttack: true,
      directExecution: true,
      validateFixedHelpers: true,
      gitEnvironment: {
        HOME: "/attacker/home",
        LAUNCH_LOG: "/tmp/launch-plugin.log",
        NPM_CONFIG_USERCONFIG: "/attacker/user.npmrc",
        NPM_CONFIG_GLOBALCONFIG: "/attacker/global.npmrc",
        GIT_DIR: "/redirected/repository",
        GIT_WORK_TREE: "/redirected/worktree",
        GIT_INDEX_FILE: "/redirected/index",
        GIT_CONFIG_GLOBAL: "/attacker/global.gitconfig",
        GIT_CONFIG_SYSTEM: "/attacker/system.gitconfig",
        GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: "core.hooksPath",
        GIT_CONFIG_VALUE_0: "/attacker/hooks",
        GIT_CONFIG_KEY_1: "core.fsmonitor",
        GIT_CONFIG_VALUE_1: "/attacker/fsmonitor",
        GIT_CONFIG_PARAMETERS: "'url.https://attacker.invalid/.insteadOf'='https://github.com/'",
      },
    });
    try {
      expect(fixture.result.status).toBe(1);
      expect(fixture.result.stderr).toContain(
        "sanitized CUA runtime payload failed exact candidate validation",
      );
      expect(fs.readFileSync(fixture.gitMarker, "utf8")).toMatch(/^(safe)+$/);
      expect(fs.readFileSync(fixture.gitCloneMarker, "utf8")).toBe(fixture.clone);
      expect(fs.readFileSync(fixture.baseEnvironmentMarker, "utf8")).toBe("safe");
      expect(fs.existsSync(fixture.hookMarker)).toBe(false);
      expect(fs.existsSync(fixture.fsmonitorMarker)).toBe(false);
      expect(fs.existsSync(fixture.bootstrapModeMarker)).toBe(false);
      expect(fs.existsSync(fixture.attackerPathMarker)).toBe(false);
      expect(fs.existsSync(fixture.cloneRootInstallMarker)).toBe(false);
      expect(fs.readFileSync(fixture.nodeMarker, "utf8")).toBe("invoked");
      expect(fs.existsSync(fixture.environmentMarker)).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 60_000);

  it("rejects failed compiled identity validation before writing qualification state", () => {
    const fixture = runCandidateFixture({ gitStatus: "", nodeStatus: 1 });
    try {
      expect(fixture.result.status).toBe(1);
      expect(fixture.result.stderr).toContain(
        "sanitized CUA runtime payload failed exact candidate validation",
      );
      expect(fs.readFileSync(fixture.gitMarker, "utf8")).toMatch(/^(safe)+$/);
      expect(fs.readFileSync(fixture.gitCloneMarker, "utf8")).toBe(fixture.clone);
      expect(fs.readFileSync(fixture.baseEnvironmentMarker, "utf8")).toBe("safe");
      expect(fs.existsSync(fixture.hookMarker)).toBe(false);
      expect(fs.existsSync(fixture.fsmonitorMarker)).toBe(false);
      expect(fs.existsSync(fixture.bootstrapModeMarker)).toBe(false);
      expect(fs.existsSync(fixture.attackerPathMarker)).toBe(false);
      expect(fs.existsSync(fixture.cloneRootInstallMarker)).toBe(false);
      expect(fs.readFileSync(fixture.nodeMarker, "utf8")).toBe("invoked");
      expect(fs.existsSync(fixture.environmentMarker)).toBe(false);
      expect(fs.existsSync(fixture.bootstrap)).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 60_000);

  it("rejects a user-owned or mutable runtime authority before writing qualification state", () => {
    const fixture = runCandidateFixture({
      nodeStatus: 0,
      runtimeAuthorityOwner: "1000:1000",
    });
    try {
      expect(fixture.result.status).toBe(1);
      expect(fixture.result.stderr).toContain("CUA runtime authority must be root-owned");
      expect(fs.existsSync(fixture.nodeMarker)).toBe(false);
      expect(fs.existsSync(fixture.dockerMarker)).toBe(false);
      expect(fs.existsSync(fixture.qualificationEnvironmentFile)).toBe(false);
      expect(fs.existsSync(fixture.profileFile)).toBe(false);
      expect(fs.existsSync(fixture.sentinelFile)).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
