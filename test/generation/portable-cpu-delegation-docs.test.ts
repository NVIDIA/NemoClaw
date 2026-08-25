// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PORTABLE_CPU_DELEGATION_PROOF_CONTRACT } from "../../scripts/checks/run-portable-cpu-delegation-proof.mts";

const repoRoot = path.join(import.meta.dirname, "../..");
const troubleshootingPath = path.join(repoRoot, "docs", "reference", "troubleshooting.mdx");
const temporaryDirectories: string[] = [];

type CommandFixture = {
  appSliceDropIn: string;
  command: string;
  delegationDropIn: string;
  environment: NodeJS.ProcessEnv;
  mkdirCallMarker: string;
  userSliceDropIn: string;
};

type RollbackFixture = {
  appSliceDropIn: string;
  appSliceDropInDirectory: string;
  command: string;
  delegationDropIn: string;
  delegationDropInDirectory: string;
  environment: NodeJS.ProcessEnv;
  systemctlCallMarker: string;
  userSliceDropIn: string;
  userSliceDropInDirectory: string;
};

type RollbackFixtureOptions = {
  appSliceDropInCreated?: boolean;
  delegationDropInCreated?: boolean;
  expectedDelegationDropInId?: string;
  userSliceDropInCreated?: boolean;
};

function extractFirstBashCommandAfter(anchor: string): string {
  const markdown = fs.readFileSync(troubleshootingPath, "utf8");
  const sectionStart = markdown.indexOf(anchor);
  expect(sectionStart).toBeGreaterThanOrEqual(0);
  const section = markdown.slice(sectionStart);
  const block = section.match(/```bash\n([\s\S]*?)\n```/u);
  expect(block).not.toBeNull();
  return block?.[1] ?? "";
}

function extractDropInCreationCommand(): string {
  return extractFirstBashCommandAfter("Use the three dedicated NemoClaw drop-in paths below.");
}

function extractControllerClassificationCommand(): string {
  return extractFirstBashCommandAfter("### Portable CPU Delegation Preflight Fails");
}

function extractMalformedEvidenceInspectionCommand(): string {
  return extractFirstBashCommandAfter("Do not print malformed bytes directly to a terminal.");
}

function extractPartialCreationRollbackCommand(): string {
  return extractFirstBashCommandAfter("#### Clean Up a Partial Drop-In Creation");
}

function extractUnrecordedDirectoryRecoveryCommand(): string {
  return extractFirstBashCommandAfter("#### Recover an Unrecorded Drop-In Directory");
}

function extractApplyCommand(): string {
  return extractFirstBashCommandAfter("Run the stop, reload, and start sequence:");
}

function extractFinalControllerVerificationCommand(): string {
  return extractFirstBashCommandAfter(
    "Verify the root hierarchy, current user manager, and `app.slice`:",
  );
}

function extractDropInRollbackCommand(): string {
  const markdown = fs.readFileSync(troubleshootingPath, "utf8");
  const sectionStart = markdown.indexOf("#### Remove the CPU Controller Drop-Ins");
  expect(sectionStart).toBeGreaterThanOrEqual(0);

  const section = markdown.slice(sectionStart);
  const sectionEnd = section.indexOf("\n### Portable Podman Readiness Fails");
  expect(sectionEnd).toBeGreaterThanOrEqual(0);
  const blocks = [...section.slice(0, sectionEnd).matchAll(/```bash\n([\s\S]*?)\n```/gu)];
  expect(blocks).toHaveLength(3);
  return blocks[1]?.[1] ?? "";
}

function makeTemporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cpu-delegation-docs-"));
  temporaryDirectories.push(directory);
  return directory;
}

function makeCommandFixture(): CommandFixture {
  const root = makeTemporaryDirectory();
  const delegationDropIn = path.join(root, "system", "90-nemoclaw-cpu-delegation.conf");
  const appSliceDropIn = path.join(root, "user", "90-nemoclaw-cpu-controller.conf");
  const userSliceDropIn = path.join(root, "user-slice", "90-nemoclaw-cpu-controller.conf");
  const fakeBin = path.join(root, "bin");
  const mkdirCallMarker = path.join(root, "mkdir-call");
  const linkCallMarker = path.join(root, "link-call");
  const sudo = path.join(fakeBin, "sudo");
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(
    sudo,
    `#!/bin/sh
set -eu
if [ -n "\${FAIL_PREDICATE_PATH:-}" ] && [ "\${1-}" = sh ] && [ "\${5-}" = "$FAIL_PREDICATE_PATH" ]; then printf '%s\\n' 'simulated predicate inspection failure' >&2; exit 77; fi
if [ "\${1-}" = mkdir ]; then
  mkdir_call=1
  if [ -e "$MKDIR_CALL_MARKER" ]; then
    mkdir_call=$(( $(cat "$MKDIR_CALL_MARKER") + 1 ))
  fi
  printf '%s\\n' "$mkdir_call" > "$MKDIR_CALL_MARKER"
  if [ "$mkdir_call" -eq "\${FAIL_MKDIR_CALL:-0}" ]; then
    printf '%s\\n' 'simulated directory creation failure' >&2
    exit 73
  fi
  exec mkdir -m "$3" "$5"
fi
if [ "\${1-}" = stat ]; then
  if [ "\${3-}" = "%d:%i" ]; then
    case "\${5##*/}" in
      .nemoclaw-cpu-controller.*) is_staging_dir=1 ;;
      *) is_staging_dir=0 ;;
    esac
    if [ "\${FAIL_STAGING_STAT:-0}" = 1 ] && [ "$is_staging_dir" = 1 ]; then
      printf '%s\\n' 'simulated staging identity recording failure' >&2
      exit 76
    elif [ "\${FAIL_STAT_ID_PATH:-}" = "\${5-}" ]; then
      printf '%s\\n' 'simulated identity recording failure' >&2
      exit 76
    elif [ "\${STAT_ID_OVERRIDE_PATH:-}" = "\${5-}" ]; then
      printf '%s\\n' "\${STAT_ID_OVERRIDE:-0:0}"
    else
      printf '%s\\n' '1:1'
    fi
  elif [ "\${SUDO_SCENARIO:-}" = existing-directory-metadata ]; then
    printf '%s\\n' 'root:root 750'
  else
    case "\${5##*/}" in
      .nemoclaw-cpu-controller.*) printf '%s\\n' 'root:root 700' ;;
      *) printf '%s\\n' 'root:root 755' ;;
    esac
  fi
  exit 0
fi
if [ "\${1-}" = chown ]; then
  exit 0
fi
if [ "\${1-}" = chmod ]; then
  exec chmod "$2" "$4"
fi
if [ "\${1-}" = sh ] && [ "\${SUDO_SCENARIO:-}" = write-failure ]; then
  case "\${3-}" in
    *'cat >'*)
    printf '%s\\n' 'partial content' > "$5"
    printf '%s\\n' 'simulated temporary file write failure' >&2
    exit 74
    ;;
  esac
fi
if [ "\${1-}" = ln ]; then
  link_call=1
  if [ -e "$LINK_CALL_MARKER" ]; then
    link_call=$(( $(cat "$LINK_CALL_MARKER") + 1 ))
  fi
  printf '%s\\n' "$link_call" > "$LINK_CALL_MARKER"
  if [ "$link_call" -eq "\${FAIL_LINK_CALL:-0}" ]; then
    printf '%s\\n' 'simulated publish link failure' >&2
    exit 75
  fi
  if [ "\${SUDO_SCENARIO:-}" = concurrent ]; then
    printf '%s\\n' 'concurrent content' > "$FAILURE_TARGET"
  fi
  ln "$4" "$5"
  if [ "$link_call" -eq "\${FAIL_AFTER_LINK_CALL:-0}" ]; then
    printf '%s\\n' 'simulated interruption after publish link' >&2
    exit 78
  fi
  exit 0
fi
exec "$@"
`,
    { mode: 0o755 },
  );

  const command = extractDropInCreationCommand()
    .replace('uid="$(id -u)"', 'uid="1000"')
    .replace(
      'delegation_drop_in="/etc/systemd/system/user@.service.d/90-nemoclaw-cpu-delegation.conf"',
      `delegation_drop_in=${JSON.stringify(delegationDropIn)}`,
    )
    .replace(
      'app_slice_drop_in="/etc/systemd/user/app.slice.d/90-nemoclaw-cpu-controller.conf"',
      `app_slice_drop_in=${JSON.stringify(appSliceDropIn)}`,
    )
    .replace(
      'user_slice_drop_in="/etc/systemd/system/user-${uid}.slice.d/90-nemoclaw-cpu-controller.conf"',
      `user_slice_drop_in=${JSON.stringify(userSliceDropIn)}`,
    );

  return {
    appSliceDropIn,
    command,
    delegationDropIn,
    environment: {
      ...process.env,
      FAILURE_TARGET: delegationDropIn,
      LINK_CALL_MARKER: linkCallMarker,
      LC_ALL: "C",
      MKDIR_CALL_MARKER: mkdirCallMarker,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    },
    mkdirCallMarker,
    userSliceDropIn,
  };
}

function fileIdentity(filePath: string): string {
  const metadata = fs.statSync(filePath);
  return `${metadata.dev}:${metadata.ino}`;
}

function makeRollbackFixture(options: RollbackFixtureOptions = {}): RollbackFixture {
  const root = makeTemporaryDirectory();
  const delegationDropInDirectory = path.join(root, "system");
  const appSliceDropInDirectory = path.join(root, "user");
  const userSliceDropInDirectory = path.join(root, "user-slice");
  const delegationDropIn = path.join(delegationDropInDirectory, "90-nemoclaw-cpu-delegation.conf");
  const appSliceDropIn = path.join(appSliceDropInDirectory, "90-nemoclaw-cpu-controller.conf");
  const userSliceDropIn = path.join(userSliceDropInDirectory, "90-nemoclaw-cpu-controller.conf");
  const fakeBin = path.join(root, "bin");
  const systemctlCallMarker = path.join(root, "systemctl-calls");
  const sudo = path.join(fakeBin, "sudo");
  const delegationDropInCreated = options.delegationDropInCreated ?? true;
  const appSliceDropInCreated = options.appSliceDropInCreated ?? true;
  const userSliceDropInCreated = options.userSliceDropInCreated ?? true;
  fs.mkdirSync(delegationDropInDirectory);
  fs.mkdirSync(appSliceDropInDirectory);
  fs.mkdirSync(userSliceDropInDirectory);
  fs.mkdirSync(fakeBin);
  [
    {
      content: "[Service]\nDelegate=cpu memory pids\n",
      created: delegationDropInCreated,
      file: delegationDropIn,
    },
    {
      content: "[Slice]\nCPUWeight=100\n",
      created: appSliceDropInCreated,
      file: appSliceDropIn,
    },
    {
      content: "[Slice]\nCPUWeight=100\n",
      created: userSliceDropInCreated,
      file: userSliceDropIn,
    },
  ]
    .filter(({ created }) => created)
    .forEach(({ content, file }) => fs.writeFileSync(file, content));
  fs.writeFileSync(
    sudo,
    `#!/bin/sh
set -eu
if [ -n "\${FAIL_PREDICATE_PATH:-}" ] && [ "\${1-}" = sh ] && [ "\${5-}" = "$FAIL_PREDICATE_PATH" ]; then printf '%s\\n' 'simulated predicate inspection failure' >&2; exit 77; fi
if [ "\${1-}" = systemctl ]; then
  printf '%s\n' "$*" >> "$SYSTEMCTL_CALL_MARKER"
  if [ "\${2-}" = start ] && [ "\${START_FAILURE_219:-0}" = 1 ]; then
    printf '%s\n' 'Job failed with result cgroup' >&2
    exit 1
  fi
  if [ "\${2-}" = status ] && [ "\${START_FAILURE_219:-0}" = 1 ]; then
    printf '%s\n' 'Process: 100 ExecStart=/bin/false (code=exited, status=219/CGROUP)'
    exit 3
  fi
  exit 0
fi
if [ "\${1-}" = stat ]; then
  if [ "\${2-}" != -Lc ] || [ "\${4-}" != -- ] || [ "$#" -ne 5 ]; then
    printf 'unexpected stat invocation: %s\n' "$*" >&2
    exit 1
  fi
  exec node -e '
    const fs = require("node:fs");
    const metadata = fs.statSync(process.argv[2]);
    process.stdout.write(
      process.argv[1]
        .replace("%d", String(metadata.dev))
        .replace("%i", String(metadata.ino)),
    );
  ' "$3" "$5"
fi
if [ "\${1-}" = rm ] || [ "\${1-}" = rmdir ]; then
  command="$1"
  shift
  if [ "\${1-}" = -- ]; then
    shift
  fi
  exec "$command" "$@"
fi
exec "$@"
`,
    { mode: 0o755 },
  );

  const command = extractDropInRollbackCommand()
    .replace('uid="<affected-user-id>"', 'uid="1000"')
    .replace(
      'delegation_drop_in="/etc/systemd/system/user@.service.d/90-nemoclaw-cpu-delegation.conf"',
      `delegation_drop_in=${JSON.stringify(delegationDropIn)}`,
    )
    .replace(
      'app_slice_drop_in="/etc/systemd/user/app.slice.d/90-nemoclaw-cpu-controller.conf"',
      `app_slice_drop_in=${JSON.stringify(appSliceDropIn)}`,
    )
    .replace(
      'user_slice_drop_in="/etc/systemd/system/user-${uid}.slice.d/90-nemoclaw-cpu-controller.conf"',
      `user_slice_drop_in=${JSON.stringify(userSliceDropIn)}`,
    )
    .replace(
      'delegation_drop_in_created="<recorded-final-0-or-1>"',
      `delegation_drop_in_created=${JSON.stringify(delegationDropInCreated ? "1" : "0")}`,
    )
    .replace(
      'expected_delegation_drop_in_id="<recorded-device:inode-if-created>"',
      `expected_delegation_drop_in_id=${JSON.stringify(
        delegationDropInCreated
          ? (options.expectedDelegationDropInId ?? fileIdentity(delegationDropIn))
          : "",
      )}`,
    )
    .replace(
      'app_slice_drop_in_created="<recorded-final-0-or-1>"',
      `app_slice_drop_in_created=${JSON.stringify(appSliceDropInCreated ? "1" : "0")}`,
    )
    .replace(
      'expected_app_slice_drop_in_id="<recorded-device:inode-if-created>"',
      `expected_app_slice_drop_in_id=${JSON.stringify(
        appSliceDropInCreated ? fileIdentity(appSliceDropIn) : "",
      )}`,
    )
    .replace(
      'user_slice_drop_in_created="<recorded-final-0-or-1>"',
      `user_slice_drop_in_created=${JSON.stringify(userSliceDropInCreated ? "1" : "0")}`,
    )
    .replace(
      'expected_user_slice_drop_in_id="<recorded-device:inode-if-created>"',
      `expected_user_slice_drop_in_id=${JSON.stringify(
        userSliceDropInCreated ? fileIdentity(userSliceDropIn) : "",
      )}`,
    )
    .replace(
      'delegation_drop_in_dir_created="<recorded-0-or-1>"',
      'delegation_drop_in_dir_created="1"',
    )
    .replace(
      'delegation_drop_in_dir_id="<recorded-device:inode-if-created>"',
      `delegation_drop_in_dir_id=${JSON.stringify(fileIdentity(delegationDropInDirectory))}`,
    )
    .replace(
      'app_slice_drop_in_dir_created="<recorded-0-or-1>"',
      'app_slice_drop_in_dir_created="1"',
    )
    .replace(
      'app_slice_drop_in_dir_id="<recorded-device:inode-if-created>"',
      `app_slice_drop_in_dir_id=${JSON.stringify(fileIdentity(appSliceDropInDirectory))}`,
    )
    .replace(
      'user_slice_drop_in_dir_created="<recorded-0-or-1>"',
      'user_slice_drop_in_dir_created="1"',
    )
    .replace(
      'user_slice_drop_in_dir_id="<recorded-device:inode-if-created>"',
      `user_slice_drop_in_dir_id=${JSON.stringify(fileIdentity(userSliceDropInDirectory))}`,
    );

  return {
    appSliceDropIn,
    appSliceDropInDirectory,
    command,
    delegationDropIn,
    delegationDropInDirectory,
    environment: {
      ...process.env,
      LC_ALL: "C",
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      SYSTEMCTL_CALL_MARKER: systemctlCallMarker,
    },
    systemctlCallMarker,
    userSliceDropIn,
    userSliceDropInDirectory,
  };
}

function runDocumentedCommand(fixture: CommandFixture, environment: NodeJS.ProcessEnv = {}) {
  return spawnSync("bash", ["-c", fixture.command], {
    encoding: "utf8",
    env: { ...fixture.environment, ...environment },
  });
}

function runDocumentedRollback(fixture: RollbackFixture, environment: NodeJS.ProcessEnv = {}) {
  return spawnSync("bash", ["-c", fixture.command], {
    encoding: "utf8",
    env: { ...fixture.environment, ...environment },
  });
}

function finalRecord(output: string, name: string): string | undefined {
  const matches = [...output.matchAll(new RegExp(`Record for rollback: ${name}=([^\\n]*)`, "gu"))];
  return matches.at(-1)?.[1];
}

function partialCreationRollbackCommand(fixture: CommandFixture, creationOutput: string): string {
  const values = new Map<string, string>();
  for (const prefix of ["delegation", "app_slice", "user_slice"]) {
    for (const suffix of [
      "drop_in_created",
      "drop_in_id",
      "drop_in_dir_created",
      "drop_in_dir_id",
      "staging_dir_path",
      "staging_dir_created",
      "staging_dir_id",
    ]) {
      const name = `${prefix}_${suffix}`;
      values.set(name, finalRecord(creationOutput, name) ?? "");
    }
  }

  let command = extractPartialCreationRollbackCommand()
    .replace(
      'delegation_drop_in="/etc/systemd/system/user@.service.d/90-nemoclaw-cpu-delegation.conf"',
      `delegation_drop_in=${JSON.stringify(fixture.delegationDropIn)}`,
    )
    .replace(
      'app_slice_drop_in="/etc/systemd/user/app.slice.d/90-nemoclaw-cpu-controller.conf"',
      `app_slice_drop_in=${JSON.stringify(fixture.appSliceDropIn)}`,
    )
    .replace(
      'user_slice_drop_in="/etc/systemd/system/user-<affected-user-id>.slice.d/90-nemoclaw-cpu-controller.conf"',
      `user_slice_drop_in=${JSON.stringify(fixture.userSliceDropIn)}`,
    );

  for (const [name, value] of values) {
    command = command.replace(
      new RegExp(`${name}="<[^"]+>"`, "u"),
      `${name}=${JSON.stringify(value)}`,
    );
  }
  return command;
}

function runPartialCreationRollback(
  fixture: CommandFixture,
  creationOutput: string,
  environment: NodeJS.ProcessEnv = {},
) {
  return spawnSync("bash", ["-c", partialCreationRollbackCommand(fixture, creationOutput)], {
    encoding: "utf8",
    env: { ...fixture.environment, ...environment },
  });
}

function runUnrecordedDirectoryRecovery(
  fixture: CommandFixture,
  directory: string,
  environment: NodeJS.ProcessEnv = {},
  creationOutput = "",
) {
  const command = extractUnrecordedDirectoryRecoveryCommand()
    .replace(
      'unrecorded_directory="<exact-directory-from-identity-recording-error>"',
      `unrecorded_directory=${JSON.stringify(directory)}`,
    )
    .replace(
      'delegation_drop_in_dir="/etc/systemd/system/user@.service.d"',
      `delegation_drop_in_dir=${JSON.stringify(path.dirname(fixture.delegationDropIn))}`,
    )
    .replace(
      'app_slice_drop_in_dir="/etc/systemd/user/app.slice.d"',
      `app_slice_drop_in_dir=${JSON.stringify(path.dirname(fixture.appSliceDropIn))}`,
    )
    .replace(
      'user_slice_drop_in_dir="/etc/systemd/system/user-<affected-user-id>.slice.d"',
      `user_slice_drop_in_dir=${JSON.stringify(path.dirname(fixture.userSliceDropIn))}`,
    )
    .replace(
      'delegation_staging_dir_path="<recorded-delegation-staging-dir-path-or-empty>"',
      `delegation_staging_dir_path=${JSON.stringify(finalRecord(creationOutput, "delegation_staging_dir_path") ?? "")}`,
    )
    .replace(
      'app_slice_staging_dir_path="<recorded-app-slice-staging-dir-path-or-empty>"',
      `app_slice_staging_dir_path=${JSON.stringify(finalRecord(creationOutput, "app_slice_staging_dir_path") ?? "")}`,
    )
    .replace(
      'user_slice_staging_dir_path="<recorded-user-slice-staging-dir-path-or-empty>"',
      `user_slice_staging_dir_path=${JSON.stringify(finalRecord(creationOutput, "user_slice_staging_dir_path") ?? "")}`,
    );

  return spawnSync("bash", ["-c", command], {
    encoding: "utf8",
    env: { ...fixture.environment, ...environment },
  });
}

function runDocumentedApply(fixture: RollbackFixture) {
  const command = extractApplyCommand().replace('uid="<affected-user-id>"', 'uid="1000"');
  return spawnSync("bash", ["-c", command], {
    encoding: "utf8",
    env: { ...fixture.environment, START_FAILURE_219: "1" },
  });
}

function runClassificationWithUserManagerEvidence(evidence: Buffer | string) {
  const root = makeTemporaryDirectory();
  const rootControllers = path.join(root, "root.controllers");
  const userSlice = path.join(root, "user-slice");
  const userSliceControllers = path.join(userSlice, "cgroup.controllers");
  const userManager = path.join(root, "user-manager");
  const userManagerControllers = path.join(userManager, "cgroup.controllers");
  const appSliceControllers = path.join(userManager, "app.slice", "cgroup.controllers");
  fs.mkdirSync(path.dirname(appSliceControllers), { recursive: true });
  fs.mkdirSync(userSlice);
  fs.writeFileSync(rootControllers, "cpuset cpu memory pids\n");
  fs.writeFileSync(userSliceControllers, "cpu memory pids\n");
  fs.writeFileSync(userManagerControllers, evidence);
  fs.writeFileSync(appSliceControllers, "cpu memory pids\n");
  const command = extractControllerClassificationCommand()
    .replace('uid="$(id -u)"', 'uid="1000"')
    .replace(
      'user_slice="/sys/fs/cgroup/user.slice/user-${uid}.slice"',
      `user_slice=${JSON.stringify(userSlice)}`,
    )
    .replace(
      'user_manager="/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service"',
      `user_manager=${JSON.stringify(userManager)}`,
    )
    .replace("/sys/fs/cgroup/cgroup.controllers", JSON.stringify(rootControllers));
  const verificationCommand = extractFinalControllerVerificationCommand()
    .replace('uid="$(id -u)"', 'uid="1000"')
    .replace(
      'user_slice="/sys/fs/cgroup/user.slice/user-${uid}.slice"',
      `user_slice=${JSON.stringify(userSlice)}`,
    )
    .replace(
      'user_manager="/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service"',
      `user_manager=${JSON.stringify(userManager)}`,
    )
    .replace("/sys/fs/cgroup/cgroup.controllers", JSON.stringify(rootControllers));

  return {
    appSliceControllers,
    command,
    result: spawnSync("bash", ["-c", command], { encoding: "utf8" }),
    rootControllers,
    userManagerControllers,
    userSliceControllers,
    verificationCommand,
    verificationResult: spawnSync("bash", ["-c", verificationCommand], { encoding: "utf8" }),
  };
}

function listTemporaryDropIns(fixture: CommandFixture): string[] {
  const directories = new Set([
    path.dirname(fixture.delegationDropIn),
    path.dirname(fixture.appSliceDropIn),
    path.dirname(fixture.userSliceDropIn),
  ]);

  return [...directories]
    .filter((directory) => fs.existsSync(directory))
    .flatMap((directory) =>
      fs
        .readdirSync(directory)
        .filter((entry) => entry.startsWith(".nemoclaw-cpu-controller."))
        .map((entry) => path.join(directory, entry)),
    );
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("portable CPU delegation documentation (#9188)", () => {
  it("classifies malformed controller evidence without printing its content (#9188)", () => {
    const {
      appSliceControllers,
      command,
      result,
      rootControllers,
      userManagerControllers,
      userSliceControllers,
      verificationResult,
    } = runClassificationWithUserManagerEvidence("cpu memory\nDelegate=cpu\n");

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`${rootControllers}: readable (cpuset cpu memory pids)`);
    expect(result.stdout).toContain(`${userSliceControllers}: readable (cpu memory pids)`);
    expect(result.stdout).toContain(`${userManagerControllers}: malformed`);
    expect(result.stdout).toContain(`${appSliceControllers}: readable (cpu memory pids)`);
    expect(result.stdout).not.toContain("Delegate=cpu");
    expect(command).toContain("Buffer.alloc(4097)");
    expect(command).toContain("content.length > 4096");
    expect(command).not.toContain('cat -- "$controllers"');
    expect(verificationResult.status).not.toBe(0);
    expect(verificationResult.stdout).toContain(`${userManagerControllers}: malformed`);
    expect(verificationResult.stdout).not.toContain("Delegate=cpu");
  });

  it.each([
    { caseName: "NUL-containing", evidence: Buffer.from("cpu\0memory\n"), leaked: "cpu\0memory" },
    { caseName: "invalid UTF-8", evidence: Buffer.from([0x63, 0x70, 0x75, 0xff]), leaked: "�" },
    { caseName: "oversized", evidence: Buffer.alloc(1024 * 1024, 0x61), leaked: "a".repeat(256) },
    { caseName: "duplicate", evidence: "cpu memory cpu\n", leaked: "cpu memory cpu" },
  ])("classifies $caseName evidence as malformed (#9188)", ({ evidence, leaked }) => {
    const { result, userManagerControllers, verificationResult } =
      runClassificationWithUserManagerEvidence(evidence);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`${userManagerControllers}: malformed`);
    expect(result.stdout).not.toContain(leaked);
    expect(result.stdout.length).toBeLessThan(1024);
    expect(verificationResult.status).not.toBe(0);
    expect(verificationResult.stdout).toContain(`${userManagerControllers}: malformed`);
    expect(verificationResult.stdout).not.toContain(leaked);
  });

  it("refuses to inspect malformed evidence outside the exact controller paths (#9188)", () => {
    const root = makeTemporaryDirectory();
    const rootControllers = path.join(root, "root.controllers");
    const userManager = path.join(root, "user-manager");
    const unexpectedPath = path.join(root, "unexpected.controllers");
    const command = extractMalformedEvidenceInspectionCommand()
      .replace(
        'reported_path="<reported-cgroup.controllers-path>"',
        `reported_path=${JSON.stringify(unexpectedPath)}`,
      )
      .replace('uid="$(id -u)"', 'uid="1000"')
      .replace(
        'user_manager="/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service"',
        `user_manager=${JSON.stringify(userManager)}`,
      )
      .replace("/sys/fs/cgroup/cgroup.controllers", rootControllers);

    const result = spawnSync("bash", ["-c", command], { encoding: "utf8" });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`Refusing unexpected cgroup evidence path: ${unexpectedPath}`);
    expect(command).toContain('"${user_manager}/cgroup.controllers"');
    expect(command).toContain('"${user_manager}/app.slice/cgroup.controllers"');
    expect(command).toContain('"${user_slice}/cgroup.controllers"');
  });

  it("bounds hexadecimal inspection for an exact controller evidence path (#9188)", () => {
    const root = makeTemporaryDirectory();
    const rootControllers = path.join(root, "root.controllers");
    const userManager = path.join(root, "user-manager");
    const fakeBin = path.join(root, "bin");
    const sudo = path.join(fakeBin, "sudo");
    const findmnt = path.join(fakeBin, "findmnt");
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(
      rootControllers,
      Buffer.concat([Buffer.alloc(256, 0x41), Buffer.from("SECRET_AFTER_LIMIT", "utf8")]),
    );
    fs.writeFileSync(sudo, '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
    fs.writeFileSync(findmnt, "#!/bin/sh\nprintf '%s\\n' 'bounded mount inspection'\n", {
      mode: 0o755,
    });
    const command = extractMalformedEvidenceInspectionCommand()
      .replace(
        'reported_path="<reported-cgroup.controllers-path>"',
        `reported_path=${JSON.stringify(rootControllers)}`,
      )
      .replace('uid="$(id -u)"', 'uid="1000"')
      .replace(
        'user_manager="/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service"',
        `user_manager=${JSON.stringify(userManager)}`,
      )
      .replace("/sys/fs/cgroup/cgroup.controllers", JSON.stringify(rootControllers));

    const result = spawnSync("bash", ["-c", command], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(/41\s+41\s+41\s+41/u);
    expect(result.stdout).toContain("bounded mount inspection");
    expect(result.stdout).not.toContain("53 45 43 52 45 54");
    expect(command).toContain('od -An -tx1 -N 256 -v -- "$reported_path"');
  });

  it("keeps the three-setting repair and warns before each host interruption (#9188)", () => {
    const markdown = fs.readFileSync(troubleshootingPath, "utf8");
    const sectionStart = markdown.indexOf("### Portable CPU Delegation Preflight Fails");
    const sectionEnd = markdown.indexOf("### Portable Podman Readiness Fails", sectionStart);
    const section = markdown.slice(sectionStart, sectionEnd);
    const rollbackStart = section.indexOf("#### Remove the CPU Controller Drop-Ins");
    const applySection = section.slice(0, rollbackStart);
    const rollbackSection = section.slice(rollbackStart);
    const applyWarning = applySection.indexOf("Save the affected user's work");
    const applyStop = applySection.indexOf('sudo systemctl stop "user@${uid}.service"');
    const rebootWarning = applySection.indexOf("Save work for every host user");
    const reboot = applySection.indexOf("sudo systemctl reboot");
    const rollbackWarning = rollbackSection.indexOf("Save the affected user's work");
    const rollbackStop = rollbackSection.indexOf('sudo systemctl stop "user@${uid}.service"');
    const cleanupRouting = applySection.indexOf(
      "Choose the cleanup route that matches the final records:",
    );
    const incompleteReceiptRoute = applySection.indexOf(
      "If any final `*_created` value is `0` but the same command printed its matching `*_id`",
    );
    const unrecordedCleanupRoute = applySection.indexOf(
      "If any final `*_drop_in_dir_created` or `*_staging_dir_created` value is `unrecorded`",
    );
    const recordedCleanupRoute = applySection.indexOf(
      "Otherwise, when every final `*_created` value is `0` or `1`",
    );
    const unrecordedCleanupHeading = applySection.indexOf(
      "#### Recover an Unrecorded Drop-In Directory",
    );
    const generalCleanupHeading = applySection.indexOf("#### Clean Up a Partial Drop-In Creation");

    const creationCommand = extractDropInCreationCommand();

    expect(creationCommand).toContain(
      `delegation_drop_in=${JSON.stringify(PORTABLE_CPU_DELEGATION_PROOF_CONTRACT.delegationDropIn)}`,
    );
    expect(creationCommand).toContain(
      `app_slice_drop_in=${JSON.stringify(PORTABLE_CPU_DELEGATION_PROOF_CONTRACT.appSliceDropIn)}`,
    );
    expect(creationCommand).toContain(
      'user_slice_drop_in="/etc/systemd/system/user-${uid}.slice.d/90-nemoclaw-cpu-controller.conf"',
    );
    expect(creationCommand).toContain(
      "delegation \"$delegation_drop_in\" '[Service]' 'Delegate=cpu memory pids'",
    );
    expect(creationCommand).toContain(
      "create_drop_in app_slice \"$app_slice_drop_in\" '[Slice]' 'CPUWeight=100'",
    );
    expect(creationCommand).toContain(
      "create_drop_in user_slice \"$user_slice_drop_in\" '[Slice]' 'CPUWeight=100'",
    );
    expect(PORTABLE_CPU_DELEGATION_PROOF_CONTRACT.controllerEvidenceReadBytes).toBe(4097);
    expect(PORTABLE_CPU_DELEGATION_PROOF_CONTRACT.immediateStartFailure).toBe("219/CGROUP");
    expect(creationCommand).toContain("randomBytes(16)");
    expect(creationCommand).not.toContain("mktemp");
    expect(creationCommand.indexOf("drop_in_dir_created=unrecorded")).toBeLessThan(
      creationCommand.indexOf("sudo mkdir -m 0755"),
    );
    expect(creationCommand.indexOf("staging_dir_created=unrecorded")).toBeLessThan(
      creationCommand.indexOf("sudo mkdir -m 0700"),
    );
    expect(creationCommand).not.toContain("CPUAccounting");
    expect(applySection).toContain('"${user_slice}/cgroup.controllers"');
    expect(applySection).toContain("printf '%s: malformed\\n' \"$controllers\"");
    expect(applySection).toContain(
      "Do not use a boot, delegation, or service lifecycle action to correct an unreadable or malformed file.",
    );
    expect(applySection).toContain(
      'start_output="$(sudo systemctl start "user@${uid}.service" 2>&1)"',
    );
    expect(applySection).toContain(
      "Immediate user-manager start failed with 219/CGROUP; use later-login recovery.",
    );
    expect(applyWarning).toBeGreaterThanOrEqual(0);
    expect(applyStop).toBeGreaterThan(applyWarning);
    expect(rebootWarning).toBeGreaterThanOrEqual(0);
    expect(reboot).toBeGreaterThan(rebootWarning);
    expect(rollbackWarning).toBeGreaterThanOrEqual(0);
    expect(rollbackStop).toBeGreaterThan(rollbackWarning);
    expect(cleanupRouting).toBeGreaterThanOrEqual(0);
    expect(incompleteReceiptRoute).toBeGreaterThan(cleanupRouting);
    expect(unrecordedCleanupRoute).toBeGreaterThan(incompleteReceiptRoute);
    expect(recordedCleanupRoute).toBeGreaterThan(unrecordedCleanupRoute);
    expect(unrecordedCleanupHeading).toBeGreaterThan(recordedCleanupRoute);
    expect(generalCleanupHeading).toBeGreaterThan(unrecordedCleanupHeading);
    expect(applySection).not.toContain(
      "The initial `0` records make cleanup executable even when only the first file or directory was created.",
    );
    expect(applySection.slice(generalCleanupHeading)).toContain(
      "Enter this procedure only when every final `*_created` value is `0` or `1`.",
    );
    expect(applySection).toContain(
      "a later login can create it under the corrected cgroup hierarchy",
    );
    expect(rollbackSection).toContain(
      "sign in again so systemd creates the user manager under the restored hierarchy",
    );
  });

  it("executes apply-side 219/CGROUP diagnosis after the inactive reload (#9188)", () => {
    const fixture = makeRollbackFixture();
    const result = runDocumentedApply(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("status=219/CGROUP");
    expect(result.stderr).toContain("use later-login recovery");
    expect(fs.readFileSync(fixture.systemctlCallMarker, "utf8")).toBe(
      "systemctl stop user@1000.service\n" +
        "systemctl daemon-reload\n" +
        "systemctl start user@1000.service\n" +
        "systemctl status user@1000.service --no-pager\n",
    );
  });

  it("fails closed on rollback inspection before removing recorded objects (#9188)", () => {
    const fixture = makeRollbackFixture();
    const inspectionFailure = runDocumentedRollback(fixture, {
      FAIL_PREDICATE_PATH: fixture.delegationDropIn,
    });
    expect(inspectionFailure.status).not.toBe(0);
    expect(inspectionFailure.stderr).toContain("simulated predicate inspection failure");
    expect(fs.existsSync(fixture.delegationDropIn)).toBe(true);
    expect(fs.existsSync(fixture.appSliceDropIn)).toBe(true);
    expect(fs.existsSync(fixture.userSliceDropIn)).toBe(true);
    expect(fs.existsSync(fixture.delegationDropInDirectory)).toBe(true);
    expect(fs.existsSync(fixture.appSliceDropInDirectory)).toBe(true);
    expect(fs.existsSync(fixture.systemctlCallMarker)).toBe(false);
    const result = runDocumentedRollback(fixture);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(fs.existsSync(fixture.delegationDropIn)).toBe(false);
    expect(fs.existsSync(fixture.appSliceDropIn)).toBe(false);
    expect(fs.existsSync(fixture.userSliceDropIn)).toBe(false);
    expect(fs.existsSync(fixture.delegationDropInDirectory)).toBe(false);
    expect(fs.existsSync(fixture.appSliceDropInDirectory)).toBe(false);
    expect(fs.existsSync(fixture.userSliceDropInDirectory)).toBe(false);
    expect(fs.readFileSync(fixture.systemctlCallMarker, "utf8")).toBe(
      "systemctl stop user@1000.service\n" +
        "systemctl daemon-reload\n" +
        "systemctl start user@1000.service\n",
    );
  });

  it("accepts recorded rollback resources that are already absent (#9188)", () => {
    const fixture = makeRollbackFixture();
    fs.rmSync(fixture.delegationDropInDirectory, { recursive: true });
    fs.rmSync(fixture.appSliceDropInDirectory, { recursive: true });
    fs.rmSync(fixture.userSliceDropInDirectory, { recursive: true });
    const result = runDocumentedRollback(fixture);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(fs.readFileSync(fixture.systemctlCallMarker, "utf8")).toContain(
      "systemctl start user@1000.service\n",
    );
  });

  it("removes a partial publication and accepts the same record on retry (#9188)", () => {
    const fixture = makeRollbackFixture({ appSliceDropInCreated: false });
    const firstResult = runDocumentedRollback(fixture);
    const retryResult = runDocumentedRollback(fixture);
    expect(firstResult.status).toBe(0);
    expect(firstResult.stderr).toBe("");
    expect(retryResult.status).toBe(0);
    expect(retryResult.stderr).toBe("");
    expect(fs.existsSync(fixture.delegationDropIn)).toBe(false);
    expect(fs.existsSync(fixture.appSliceDropIn)).toBe(false);
    expect(fs.existsSync(fixture.userSliceDropIn)).toBe(false);
    expect(fs.existsSync(fixture.delegationDropInDirectory)).toBe(false);
    expect(fs.existsSync(fixture.appSliceDropInDirectory)).toBe(false);
    expect(fs.existsSync(fixture.userSliceDropInDirectory)).toBe(false);
    expect(fs.readFileSync(fixture.systemctlCallMarker, "utf8")).toBe(
      (
        "systemctl stop user@1000.service\n" +
        "systemctl daemon-reload\n" +
        "systemctl start user@1000.service\n"
      ).repeat(2),
    );
  });

  it("preserves a drop-in whose identity changed after creation (#9188)", () => {
    const fixture = makeRollbackFixture({ expectedDelegationDropInId: "0:0" });
    const result = runDocumentedRollback(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Refusing CPU controller drop-in whose identity changed");
    expect(fs.readFileSync(fixture.delegationDropIn, "utf8")).toBe(
      "[Service]\nDelegate=cpu memory pids\n",
    );
    expect(fs.existsSync(fixture.delegationDropInDirectory)).toBe(true);
    expect(fs.readFileSync(fixture.appSliceDropIn, "utf8")).toBe("[Slice]\nCPUWeight=100\n");
    expect(fs.existsSync(fixture.appSliceDropInDirectory)).toBe(true);
    expect(fs.existsSync(fixture.systemctlCallMarker)).toBe(false);
  });

  it("reports immediate 219/CGROUP and accepts rollback after later-login recovery (#9188)", () => {
    const fixture = makeRollbackFixture();
    const failedStart = runDocumentedRollback(fixture, { START_FAILURE_219: "1" });
    const recoveredRetry = runDocumentedRollback(fixture);
    expect(failedStart.status).not.toBe(0);
    expect(failedStart.stderr).toContain("status=219/CGROUP");
    expect(failedStart.stderr).toContain("use later-login recovery");
    expect(fs.existsSync(fixture.delegationDropIn)).toBe(false);
    expect(fs.existsSync(fixture.appSliceDropIn)).toBe(false);
    expect(recoveredRetry.status).toBe(0);
    expect(recoveredRetry.stderr).toBe("");
    expect(fs.readFileSync(fixture.systemctlCallMarker, "utf8")).toBe(
      "systemctl stop user@1000.service\n" +
        "systemctl daemon-reload\n" +
        "systemctl start user@1000.service\n" +
        "systemctl status user@1000.service --no-pager\n" +
        "systemctl stop user@1000.service\n" +
        "systemctl daemon-reload\n" +
        "systemctl start user@1000.service\n",
    );
  });

  it("creates all three drop-ins with their required content and mode (#9188)", () => {
    const fixture = makeCommandFixture();
    const result = runDocumentedCommand(fixture);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(fs.readFileSync(fixture.delegationDropIn, "utf8")).toBe(
      "[Service]\nDelegate=cpu memory pids\n",
    );
    expect(fs.readFileSync(fixture.appSliceDropIn, "utf8")).toBe("[Slice]\nCPUWeight=100\n");
    expect(fs.readFileSync(fixture.userSliceDropIn, "utf8")).toBe("[Slice]\nCPUWeight=100\n");
    expect(fs.statSync(fixture.delegationDropIn).mode & 0o777).toBe(0o644);
    expect(fs.statSync(fixture.appSliceDropIn).mode & 0o777).toBe(0o644);
    expect(fs.statSync(fixture.userSliceDropIn).mode & 0o777).toBe(0o644);
    expect(listTemporaryDropIns(fixture)).toEqual([]);
  });

  it("does not replace a drop-in created before the publish link (#9188)", () => {
    const fixture = makeCommandFixture();
    const result = runDocumentedCommand(fixture, { SUDO_SCENARIO: "concurrent" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("File exists");
    expect(result.stderr).toContain(
      `CPU controller drop-in creation failed: ${fixture.delegationDropIn}`,
    );
    expect(result.stderr).not.toContain("Refusing to replace existing file");
    expect(fs.readFileSync(fixture.delegationDropIn, "utf8")).toBe("concurrent content\n");
    expect(fs.existsSync(fixture.appSliceDropIn)).toBe(false);
    expect(listTemporaryDropIns(fixture)).toEqual([]);
  });

  it.each([
    { failedMkdirCall: 1, recordsFirstDirectory: false },
    { failedMkdirCall: 2, recordsFirstDirectory: true },
  ])(
    "does not create a drop-in when mkdir call $failedMkdirCall fails (#9188)",
    ({ failedMkdirCall, recordsFirstDirectory }) => {
      const fixture = makeCommandFixture();
      const result = runDocumentedCommand(fixture, {
        FAIL_MKDIR_CALL: String(failedMkdirCall),
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("simulated directory creation failure");
      expect(fs.readFileSync(fixture.mkdirCallMarker, "utf8")).toBe(`${failedMkdirCall}\n`);
      expect(fs.existsSync(fixture.delegationDropIn)).toBe(false);
      expect(fs.existsSync(fixture.appSliceDropIn)).toBe(false);
      expect(listTemporaryDropIns(fixture)).toEqual([]);
      expect(result.stdout.includes("delegation_drop_in_dir_created=1")).toBe(
        recordsFirstDirectory,
      );
      expect(result.stdout.includes("delegation_drop_in_dir_id=1:1")).toBe(recordsFirstDirectory);
      expect(result.stdout).toContain("delegation_drop_in_created=0");
      expect(result.stdout).toContain("app_slice_drop_in_created=0");
    },
  );

  it("recovers an exact empty directory when identity recording fails after mkdir (#9188)", () => {
    const fixture = makeCommandFixture();
    const delegationDirectory = path.dirname(fixture.delegationDropIn);
    const creation = runDocumentedCommand(fixture, {
      FAIL_STAT_ID_PATH: delegationDirectory,
    });
    expect(creation.stderr).toContain("simulated identity recording failure");
    expect(creation.stderr).toContain(
      `CPU controller drop-in directory identity recording failed: ${delegationDirectory}`,
    );
    expect(finalRecord(creation.stdout, "delegation_drop_in_dir_created")).toBe("unrecorded");
    expect(fs.existsSync(fixture.delegationDropIn)).toBe(false);
    const rejectedGeneralCleanup = runPartialCreationRollback(fixture, creation.stdout);
    expect(rejectedGeneralCleanup.status).not.toBe(0);
    expect(fs.existsSync(delegationDirectory)).toBe(true);
    const inspectionFailure = runUnrecordedDirectoryRecovery(fixture, delegationDirectory, {
      FAIL_PREDICATE_PATH: delegationDirectory,
    });
    expect(inspectionFailure.status).not.toBe(0);
    expect(inspectionFailure.stderr).toContain("simulated predicate inspection failure");
    expect(fs.existsSync(delegationDirectory)).toBe(true);
    const concurrentFile = path.join(delegationDirectory, "concurrent.conf");
    fs.writeFileSync(concurrentFile, "preserve\n");
    const refusedRecovery = runUnrecordedDirectoryRecovery(fixture, delegationDirectory);
    expect(refusedRecovery.status).not.toBe(0);
    expect(refusedRecovery.stderr).toContain("Refusing nonempty unrecorded drop-in directory");
    expect(fs.readFileSync(concurrentFile, "utf8")).toBe("preserve\n");
    fs.rmSync(concurrentFile);
    const recovery = runUnrecordedDirectoryRecovery(fixture, delegationDirectory);
    expect(recovery.status).toBe(0);
    expect(fs.existsSync(delegationDirectory)).toBe(false);
    const stagingFixture = makeCommandFixture();
    const stagingCreation = runDocumentedCommand(stagingFixture, { FAIL_STAGING_STAT: "1" });
    const stagingDirectory =
      finalRecord(stagingCreation.stdout, "delegation_staging_dir_path") ?? "";
    expect(finalRecord(stagingCreation.stdout, "delegation_staging_dir_created")).toBe(
      "unrecorded",
    );
    const rejectedStagingCleanup = runPartialCreationRollback(
      stagingFixture,
      stagingCreation.stdout,
    );
    expect(rejectedStagingCleanup.status).not.toBe(0);
    expect(fs.existsSync(stagingDirectory)).toBe(true);
    const stagingRecovery = runUnrecordedDirectoryRecovery(
      stagingFixture,
      stagingDirectory,
      {},
      stagingCreation.stdout,
    );
    expect(stagingRecovery.status).toBe(0);
    expect(fs.existsSync(stagingDirectory)).toBe(false);
  });

  it("prints each creation identity before a later drop-in publish fails (#9188)", () => {
    const fixture = makeCommandFixture();
    const result = runDocumentedCommand(fixture, { FAIL_LINK_CALL: "2" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("simulated publish link failure");
    expect(result.stdout).toMatch(
      /delegation_drop_in_dir_id=1:1\nRecord for rollback: delegation_drop_in_dir_created=1/u,
    );
    expect(result.stdout).toMatch(
      /app_slice_drop_in_dir_id=1:1\nRecord for rollback: app_slice_drop_in_dir_created=1/u,
    );
    expect(result.stdout).toMatch(
      /delegation_drop_in_id=1:1\nRecord for rollback: delegation_drop_in_created=1/u,
    );
    expect(finalRecord(result.stdout, "app_slice_drop_in_created")).toBe("0");
    expect(finalRecord(result.stdout, "app_slice_drop_in_id")).toBe("1:1");
    expect(fs.existsSync(fixture.delegationDropIn)).toBe(true);
    expect(fs.existsSync(fixture.appSliceDropIn)).toBe(false);
    expect(listTemporaryDropIns(fixture)).toEqual([]);
  });

  it("repairs an incomplete receipt and fails closed on partial-cleanup inspection (#9188)", () => {
    const fixture = makeCommandFixture();
    const creation = runDocumentedCommand(fixture, { FAIL_AFTER_LINK_CALL: "1" });
    const interruptedReceipt = creation.stdout;
    const incompleteCleanup = runPartialCreationRollback(fixture, interruptedReceipt);
    const completedReceipt = `${interruptedReceipt}Record for rollback: delegation_drop_in_created=1\n`;
    const inspectionFailure = runPartialCreationRollback(fixture, completedReceipt, {
      FAIL_PREDICATE_PATH: fixture.delegationDropIn,
    });

    expect(creation.stderr).toContain("simulated interruption after publish link");
    expect(finalRecord(interruptedReceipt, "delegation_drop_in_id")).toBe("1:1");
    expect(finalRecord(interruptedReceipt, "delegation_drop_in_created")).toBe("0");
    expect(incompleteCleanup.status).not.toBe(0);
    expect(incompleteCleanup.stderr).toContain("Unexpected identity for unrecorded");
    expect(inspectionFailure.status).not.toBe(0);
    expect(inspectionFailure.stderr).toContain("simulated predicate inspection failure");
    expect(fs.existsSync(fixture.delegationDropIn)).toBe(true);
    expect(fs.existsSync(path.dirname(fixture.delegationDropIn))).toBe(true);
    expect(fs.existsSync(path.dirname(fixture.appSliceDropIn))).toBe(true);
    const firstCleanup = runPartialCreationRollback(fixture, completedReceipt);
    const retry = runPartialCreationRollback(fixture, completedReceipt);
    expect(firstCleanup.stderr).toBe("");
    expect(firstCleanup.status).toBe(0);
    expect(retry.status).toBe(0);
    expect(retry.stderr).toBe("");
    expect(fs.existsSync(fixture.delegationDropIn)).toBe(false);
    expect(fs.existsSync(fixture.appSliceDropIn)).toBe(false);
    expect(fs.existsSync(path.dirname(fixture.delegationDropIn))).toBe(false);
    expect(fs.existsSync(path.dirname(fixture.appSliceDropIn))).toBe(false);
  });

  it("partial cleanup preserves a published file whose identity changed (#9188)", () => {
    const fixture = makeCommandFixture();
    const creation = runDocumentedCommand(fixture, { FAIL_LINK_CALL: "2" });
    const retainedOriginal = path.join(
      path.dirname(path.dirname(fixture.delegationDropIn)),
      "delegation-drop-in.original",
    );
    fs.renameSync(fixture.delegationDropIn, retainedOriginal);
    fs.writeFileSync(fixture.delegationDropIn, "replacement\n");

    const cleanup = runPartialCreationRollback(fixture, creation.stdout, {
      STAT_ID_OVERRIDE: "0:0",
      STAT_ID_OVERRIDE_PATH: fixture.delegationDropIn,
    });

    expect(creation.status).not.toBe(0);
    expect(cleanup.status).not.toBe(0);
    expect(cleanup.stderr).toContain("Refusing CPU controller drop-in whose identity changed");
    expect(fs.existsSync(retainedOriginal)).toBe(true);
    expect(fs.readFileSync(fixture.delegationDropIn, "utf8")).toBe("replacement\n");
    expect(fs.existsSync(path.dirname(fixture.delegationDropIn))).toBe(true);
    expect(fs.existsSync(path.dirname(fixture.appSliceDropIn))).toBe(true);
  });

  it("partial cleanup preserves valid pre-existing drop-in directories (#9188)", () => {
    const fixture = makeCommandFixture();
    const delegationDirectory = path.dirname(fixture.delegationDropIn);
    const appSliceDirectory = path.dirname(fixture.appSliceDropIn);
    fs.mkdirSync(delegationDirectory, { mode: 0o755 });
    fs.mkdirSync(appSliceDirectory, { mode: 0o755 });
    const creation = runDocumentedCommand(fixture, { FAIL_LINK_CALL: "2" });
    const completedReceipt = `${creation.stdout}Record for rollback: app_slice_drop_in_created=1\n`;

    const cleanup = runPartialCreationRollback(fixture, completedReceipt);

    expect(creation.status).not.toBe(0);
    expect(cleanup.status).toBe(0);
    expect(cleanup.stderr).toBe("");
    expect(fs.existsSync(fixture.delegationDropIn)).toBe(false);
    expect(fs.existsSync(delegationDirectory)).toBe(true);
    expect(fs.existsSync(appSliceDirectory)).toBe(true);
  });

  it("refuses and preserves pre-existing directory metadata (#9188)", () => {
    const fixture = makeCommandFixture();
    const delegationDirectory = path.dirname(fixture.delegationDropIn);
    const appSliceDirectory = path.dirname(fixture.appSliceDropIn);
    fs.mkdirSync(delegationDirectory, { mode: 0o750 });
    fs.mkdirSync(appSliceDirectory, { mode: 0o750 });

    const result = runDocumentedCommand(fixture, {
      SUDO_SCENARIO: "existing-directory-metadata",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Refusing to change existing drop-in directory owner or mode");
    expect(fs.statSync(delegationDirectory).mode & 0o777).toBe(0o750);
    expect(fs.statSync(appSliceDirectory).mode & 0o777).toBe(0o750);
    expect(fs.existsSync(fixture.delegationDropIn)).toBe(false);
    expect(fs.existsSync(fixture.appSliceDropIn)).toBe(false);
  });

  it("records valid pre-existing directories as preserved (#9188)", () => {
    const fixture = makeCommandFixture();
    const delegationDirectory = path.dirname(fixture.delegationDropIn);
    const appSliceDirectory = path.dirname(fixture.appSliceDropIn);
    fs.mkdirSync(delegationDirectory, { mode: 0o755 });
    fs.mkdirSync(appSliceDirectory, { mode: 0o755 });

    const result = runDocumentedCommand(fixture);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("delegation_drop_in_dir_created=0");
    expect(result.stdout).toContain("app_slice_drop_in_dir_created=0");
    expect(result.stdout).not.toContain("delegation_drop_in_dir_id=");
    expect(result.stdout).not.toContain("app_slice_drop_in_dir_id=");
    expect(fs.statSync(delegationDirectory).mode & 0o777).toBe(0o755);
    expect(fs.statSync(appSliceDirectory).mode & 0o777).toBe(0o755);
  });

  it("removes the temporary file after its write fails (#9188)", () => {
    const fixture = makeCommandFixture();
    const result = runDocumentedCommand(fixture, { SUDO_SCENARIO: "write-failure" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("simulated temporary file write failure");
    expect(result.stderr).toContain(
      `CPU controller drop-in creation failed: ${fixture.delegationDropIn}`,
    );
    expect(result.stderr).not.toContain("Refusing to replace existing file");
    expect(fs.existsSync(fixture.delegationDropIn)).toBe(false);
    expect(fs.existsSync(fixture.appSliceDropIn)).toBe(false);
    expect(listTemporaryDropIns(fixture)).toEqual([]);
  });
});
