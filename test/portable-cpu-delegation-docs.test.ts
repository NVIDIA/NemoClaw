// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.join(import.meta.dirname, "..");
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

function extractDropInCreationCommand(): string {
  const markdown = fs.readFileSync(troubleshootingPath, "utf8");
  const sectionStart = markdown.indexOf("Use the three dedicated NemoClaw drop-in paths below.");
  expect(sectionStart).toBeGreaterThanOrEqual(0);

  const section = markdown.slice(sectionStart);
  const block = section.match(/```bash\n([\s\S]*?)\n```/u);
  expect(block).not.toBeNull();
  return block?.[1] ?? "";
}

function extractPartialCreationRollbackCommand(): string {
  const markdown = fs.readFileSync(troubleshootingPath, "utf8");
  const sectionStart = markdown.indexOf("#### Clean Up a Partial Drop-In Creation");
  expect(sectionStart).toBeGreaterThanOrEqual(0);

  const section = markdown.slice(sectionStart);
  const block = section.match(/```bash\n([\s\S]*?)\n```/u);
  expect(block).not.toBeNull();
  return block?.[1] ?? "";
}

function extractApplyCommand(): string {
  const markdown = fs.readFileSync(troubleshootingPath, "utf8");
  const sectionStart = markdown.indexOf("The administrator's `sudo` policy can request");
  expect(sectionStart).toBeGreaterThanOrEqual(0);

  const section = markdown.slice(sectionStart);
  const block = section.match(/```bash\n([\s\S]*?)\n```/u);
  expect(block).not.toBeNull();
  return block?.[1] ?? "";
}

function extractDropInRollbackCommand(): string {
  const markdown = fs.readFileSync(troubleshootingPath, "utf8");
  const sectionStart = markdown.indexOf("#### Remove the CPU Controller Drop-Ins");
  expect(sectionStart).toBeGreaterThanOrEqual(0);

  const section = markdown.slice(sectionStart);
  const sectionEnd = section.indexOf("\n### Portable Podman Readiness Fails");
  expect(sectionEnd).toBeGreaterThanOrEqual(0);
  const blocks = [...section.slice(0, sectionEnd).matchAll(/```bash\n([\s\S]*?)\n```/gu)];
  expect(blocks).toHaveLength(4);
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
  const userSliceDropIn = path.join(root, "user-slice", "90-nemoclaw-cpu-controller.conf");
  const appSliceDropIn = path.join(root, "user", "90-nemoclaw-cpu-controller.conf");
  const fakeBin = path.join(root, "bin");
  const mkdirCallMarker = path.join(root, "mkdir-call");
  const linkCallMarker = path.join(root, "link-call");
  const sudo = path.join(fakeBin, "sudo");
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(
    sudo,
    `#!/bin/sh
set -eu
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
  exec mkdir -m 0755 "$5"
fi
if [ "\${1-}" = stat ]; then
  if [ "\${3-}" = "%d:%i" ]; then
    exec node -e '
      const fs = require("node:fs");
      const metadata = fs.statSync(process.argv[1]);
      process.stdout.write(String(metadata.dev) + ":" + String(metadata.ino) + "\\n");
    ' "$5"
  elif [ "\${SUDO_SCENARIO:-}" = existing-directory-metadata ]; then
    printf '%s\\n' 'root:root 750'
  else
    printf '%s\\n' 'root:root 755'
  fi
  exit 0
fi
if [ "\${1-}" = chown ]; then
  exit 0
fi
if [ "\${1-}" = chmod ]; then
  exec chmod "$2" "$4"
fi
if [ "\${1-}" = dd ]; then
  if [ "\${SUDO_SCENARIO:-}" = write-failure ]; then
    for argument in "$@"; do
      case "$argument" in
        of=*) temporary_file="\${argument#of=}" ;;
      esac
    done
    printf '%s\\n' 'partial content' > "$temporary_file"
    printf '%s\\n' 'simulated temporary file write failure' >&2
    exit 74
  fi
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
  exec ln "$4" "$5"
fi
exec "$@"
`,
    { mode: 0o755 },
  );

  const command = extractDropInCreationCommand()
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

function makeRollbackFixture(expectedDelegationDropInId?: string): RollbackFixture {
  const root = makeTemporaryDirectory();
  const delegationDropInDirectory = path.join(root, "system");
  const userSliceDropInDirectory = path.join(root, "user-slice");
  const appSliceDropInDirectory = path.join(root, "user");
  const delegationDropIn = path.join(delegationDropInDirectory, "90-nemoclaw-cpu-delegation.conf");
  const userSliceDropIn = path.join(userSliceDropInDirectory, "90-nemoclaw-cpu-controller.conf");
  const appSliceDropIn = path.join(appSliceDropInDirectory, "90-nemoclaw-cpu-controller.conf");
  const fakeBin = path.join(root, "bin");
  const systemctlCallMarker = path.join(root, "systemctl-calls");
  const sudo = path.join(fakeBin, "sudo");
  fs.mkdirSync(delegationDropInDirectory);
  fs.mkdirSync(userSliceDropInDirectory);
  fs.mkdirSync(appSliceDropInDirectory);
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(delegationDropIn, "[Service]\nDelegate=cpu memory pids\n");
  fs.writeFileSync(userSliceDropIn, "[Slice]\nCPUWeight=100\n");
  fs.writeFileSync(appSliceDropIn, "[Slice]\nCPUWeight=100\n");
  fs.writeFileSync(
    sudo,
    `#!/bin/sh
set -eu
if [ "\${1-}" = systemctl ]; then
  printf '%s\n' "$*" >> "$SYSTEMCTL_CALL_MARKER"
  if [ "\${2-}" = start ] && [ "\${FAIL_SYSTEMCTL_START:-0}" = 1 ]; then
    printf '%s\n' 'simulated status=219/CGROUP' >&2
    exit 219
  fi
  exit 0
fi
if [ "\${1-}" = journalctl ]; then
  printf '%s\n' "$*" >> "$SYSTEMCTL_CALL_MARKER"
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
      'expected_delegation_drop_in_id="<recorded-delegation-device:inode>"',
      `expected_delegation_drop_in_id=${JSON.stringify(
        expectedDelegationDropInId ?? fileIdentity(delegationDropIn),
      )}`,
    )
    .replace(
      'expected_app_slice_drop_in_id="<recorded-app-slice-device:inode>"',
      `expected_app_slice_drop_in_id=${JSON.stringify(fileIdentity(appSliceDropIn))}`,
    )
    .replace(
      'expected_user_slice_drop_in_id="<recorded-user-slice-device:inode>"',
      `expected_user_slice_drop_in_id=${JSON.stringify(fileIdentity(userSliceDropIn))}`,
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
  const matches = [...output.matchAll(new RegExp(`Record for rollback: ${name}=([^\\n]+)`, "gu"))];
  return matches.at(-1)?.[1];
}

function partialCreationRollbackCommand(fixture: CommandFixture, creationOutput: string): string {
  const values = new Map<string, string>();
  for (const prefix of ["delegation", "user_slice", "app_slice"]) {
    for (const suffix of [
      "drop_in_created",
      "drop_in_id",
      "drop_in_dir_created",
      "drop_in_dir_id",
    ]) {
      const name = `${prefix}_${suffix}`;
      values.set(name, finalRecord(creationOutput, name) ?? "");
    }
  }

  let command = extractPartialCreationRollbackCommand()
    .replace('uid="<affected-user-id>"', 'uid="1000"')
    .replace(
      'delegation_drop_in="/etc/systemd/system/user@.service.d/90-nemoclaw-cpu-delegation.conf"',
      `delegation_drop_in=${JSON.stringify(fixture.delegationDropIn)}`,
    )
    .replace(
      'user_slice_drop_in="/etc/systemd/system/user-${uid}.slice.d/90-nemoclaw-cpu-controller.conf"',
      `user_slice_drop_in=${JSON.stringify(fixture.userSliceDropIn)}`,
    )
    .replace(
      'app_slice_drop_in="/etc/systemd/user/app.slice.d/90-nemoclaw-cpu-controller.conf"',
      `app_slice_drop_in=${JSON.stringify(fixture.appSliceDropIn)}`,
    );

  for (const [name, value] of values) {
    command = command.replace(
      new RegExp(`${name}="<[^"]+>"`, "u"),
      `${name}=${JSON.stringify(value)}`,
    );
  }
  return command;
}

function runPartialCreationRollback(fixture: CommandFixture, creationOutput: string) {
  return spawnSync("bash", ["-c", partialCreationRollbackCommand(fixture, creationOutput)], {
    encoding: "utf8",
    env: fixture.environment,
  });
}

function runDocumentedApply(fixture: RollbackFixture) {
  const command = extractApplyCommand().replace('uid="<affected-user-id>"', 'uid="1000"');
  return spawnSync("bash", ["-c", command], {
    encoding: "utf8",
    env: { ...fixture.environment, FAIL_SYSTEMCTL_START: "1" },
  });
}

function listTemporaryDropIns(fixture: CommandFixture): string[] {
  const directories = new Set([
    path.dirname(fixture.delegationDropIn),
    path.dirname(fixture.userSliceDropIn),
    path.dirname(fixture.appSliceDropIn),
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

describe("portable CPU delegation documentation", () => {
  it("removes recorded drop-ins and procedure-created directories (#9188)", () => {
    const fixture = makeRollbackFixture();
    const result = runDocumentedRollback(fixture);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(fs.existsSync(fixture.delegationDropIn)).toBe(false);
    expect(fs.existsSync(fixture.userSliceDropIn)).toBe(false);
    expect(fs.existsSync(fixture.appSliceDropIn)).toBe(false);
    expect(fs.existsSync(fixture.delegationDropInDirectory)).toBe(false);
    expect(fs.existsSync(fixture.userSliceDropInDirectory)).toBe(false);
    expect(fs.existsSync(fixture.appSliceDropInDirectory)).toBe(false);
    expect(fs.readFileSync(fixture.systemctlCallMarker, "utf8")).toBe(
      "systemctl stop user@1000.service\n" +
        "systemctl daemon-reload\n" +
        "systemctl start user@1000.service\n",
    );
  });

  it("accepts recorded rollback resources that are already absent (#9188)", () => {
    const fixture = makeRollbackFixture();
    fs.rmSync(fixture.delegationDropInDirectory, { recursive: true });
    fs.rmSync(fixture.userSliceDropInDirectory, { recursive: true });
    fs.rmSync(fixture.appSliceDropInDirectory, { recursive: true });

    const result = runDocumentedRollback(fixture);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(fs.readFileSync(fixture.systemctlCallMarker, "utf8")).toContain(
      "systemctl start user@1000.service\n",
    );
  });

  it("preserves a drop-in whose identity changed after creation (#9188)", () => {
    const fixture = makeRollbackFixture("0:0");
    const result = runDocumentedRollback(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Refusing CPU controller drop-in whose identity changed");
    expect(fs.readFileSync(fixture.delegationDropIn, "utf8")).toBe(
      "[Service]\nDelegate=cpu memory pids\n",
    );
    expect(fs.existsSync(fixture.delegationDropInDirectory)).toBe(true);
    expect(fs.existsSync(fixture.userSliceDropIn)).toBe(false);
    expect(fs.existsSync(fixture.userSliceDropInDirectory)).toBe(false);
    expect(fs.existsSync(fixture.appSliceDropIn)).toBe(false);
    expect(fs.existsSync(fixture.appSliceDropInDirectory)).toBe(false);
    expect(fs.readFileSync(fixture.systemctlCallMarker, "utf8")).toContain(
      "systemctl start user@1000.service\n",
    );
  });

  it("captures an immediate apply start 219/CGROUP failure after inactive reload (#9188)", () => {
    const fixture = makeRollbackFixture();
    const result = runDocumentedApply(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("status=219/CGROUP");
    expect(fs.readFileSync(fixture.systemctlCallMarker, "utf8")).toBe(
      "systemctl stop user@1000.service\n" +
        "systemctl daemon-reload\n" +
        "systemctl start user@1000.service\n" +
        "systemctl --no-pager --full status user@1000.service\n" +
        "journalctl --no-pager --unit user@1000.service --lines 200\n",
    );
  });

  it("removes the drop-ins and diagnoses rollback start 219/CGROUP before a safe retry (#9188)", () => {
    const fixture = makeRollbackFixture();
    const failedStart = runDocumentedRollback(fixture, { FAIL_SYSTEMCTL_START: "1" });

    expect(failedStart.status).not.toBe(0);
    expect(failedStart.stderr).toContain("status=219/CGROUP");
    expect(fs.existsSync(fixture.delegationDropIn)).toBe(false);
    expect(fs.existsSync(fixture.userSliceDropIn)).toBe(false);
    expect(fs.existsSync(fixture.appSliceDropIn)).toBe(false);
    expect(fs.readFileSync(fixture.systemctlCallMarker, "utf8")).toContain(
      "journalctl --no-pager --unit user@1000.service --lines 200\n",
    );

    const retry = runDocumentedRollback(fixture);
    expect(retry.status).toBe(0);
  });

  it("places interruption warnings before lifecycle commands and documents later-login recovery (#9188)", () => {
    const markdown = fs.readFileSync(troubleshootingPath, "utf8");
    const applyCommand = markdown.indexOf('sudo systemctl stop "user@${uid}.service"');
    const rollbackHeading = markdown.indexOf("#### Remove the CPU Controller Drop-Ins");
    const rollbackCommand = markdown.indexOf(
      'sudo systemctl stop "user@${uid}.service"',
      rollbackHeading,
    );
    const applyWarning = markdown.lastIndexOf("Before the next command", applyCommand);
    const rollbackWarning = markdown.lastIndexOf("Before the next command", rollbackCommand);

    expect(applyWarning).toBeGreaterThanOrEqual(0);
    expect(applyWarning).toBeLessThan(applyCommand);
    expect(rollbackWarning).toBeGreaterThan(rollbackHeading);
    expect(rollbackWarning).toBeLessThan(rollbackCommand);
    expect(markdown.match(/status=219\/CGROUP/gu)).toHaveLength(2);
    expect(markdown.match(/create a fresh login session later/gu)).toHaveLength(2);
    expect(markdown.match(/Before rebooting, every host user must save their work/gu)).toHaveLength(
      2,
    );
    expect(markdown.match(/systemctl cat user@\.service/gu)).toHaveLength(2);
    expect(markdown.match(/sudo systemctl cat "user-\$\{uid\}\.slice"/gu)).toHaveLength(2);
    expect(markdown.match(/systemctl --user cat app\.slice/gu)).toHaveLength(2);
  });

  it("creates all three drop-ins with their required content and mode (#9188)", () => {
    const fixture = makeCommandFixture();
    const result = runDocumentedCommand(fixture);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(fs.readFileSync(fixture.delegationDropIn, "utf8")).toBe(
      "[Service]\nDelegate=cpu memory pids\n",
    );
    expect(fs.readFileSync(fixture.userSliceDropIn, "utf8")).toBe("[Slice]\nCPUWeight=100\n");
    expect(fs.readFileSync(fixture.appSliceDropIn, "utf8")).toBe("[Slice]\nCPUWeight=100\n");
    expect(fs.statSync(fixture.delegationDropIn).mode & 0o777).toBe(0o644);
    expect(fs.statSync(fixture.userSliceDropIn).mode & 0o777).toBe(0o644);
    expect(fs.statSync(fixture.appSliceDropIn).mode & 0o777).toBe(0o644);
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
    expect(fs.existsSync(fixture.userSliceDropIn)).toBe(false);
    expect(fs.existsSync(fixture.appSliceDropIn)).toBe(false);
    expect(listTemporaryDropIns(fixture)).toEqual([]);
  });

  it.each([
    { failedMkdirCall: 1, recordedCreatedDirectories: 0 },
    { failedMkdirCall: 2, recordedCreatedDirectories: 1 },
    { failedMkdirCall: 3, recordedCreatedDirectories: 2 },
  ])(
    "does not create a drop-in when mkdir call $failedMkdirCall fails (#9188)",
    ({ failedMkdirCall, recordedCreatedDirectories }) => {
      const fixture = makeCommandFixture();
      const result = runDocumentedCommand(fixture, {
        FAIL_MKDIR_CALL: String(failedMkdirCall),
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("simulated directory creation failure");
      expect(fs.readFileSync(fixture.mkdirCallMarker, "utf8")).toBe(`${failedMkdirCall}\n`);
      expect(fs.existsSync(fixture.delegationDropIn)).toBe(false);
      expect(fs.existsSync(fixture.userSliceDropIn)).toBe(false);
      expect(fs.existsSync(fixture.appSliceDropIn)).toBe(false);
      expect(listTemporaryDropIns(fixture)).toEqual([]);
      expect(result.stdout.match(/_drop_in_dir_created=1/gu) ?? []).toHaveLength(
        recordedCreatedDirectories,
      );
    },
  );

  it("prints each creation identity before a later drop-in publish fails (#9188)", () => {
    const fixture = makeCommandFixture();
    const result = runDocumentedCommand(fixture, { FAIL_LINK_CALL: "2" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("simulated publish link failure");
    expect(result.stdout).toContain("delegation_drop_in_dir_created=1");
    expect(finalRecord(result.stdout, "delegation_drop_in_dir_id")).toMatch(/^\d+:\d+$/u);
    expect(result.stdout).toContain("user_slice_drop_in_dir_created=1");
    expect(finalRecord(result.stdout, "user_slice_drop_in_dir_id")).toMatch(/^\d+:\d+$/u);
    expect(result.stdout).toContain("app_slice_drop_in_dir_created=1");
    expect(finalRecord(result.stdout, "app_slice_drop_in_dir_id")).toMatch(/^\d+:\d+$/u);
    expect(finalRecord(result.stdout, "delegation_drop_in_id")).toMatch(/^\d+:\d+$/u);
    expect(finalRecord(result.stdout, "delegation_drop_in_created")).toBe("1");
    expect(finalRecord(result.stdout, "user_slice_drop_in_created")).toBe("0");
    expect(finalRecord(result.stdout, "app_slice_drop_in_created")).toBe("0");
    expect(fs.existsSync(fixture.delegationDropIn)).toBe(true);
    expect(fs.existsSync(fixture.userSliceDropIn)).toBe(false);
    expect(fs.existsSync(fixture.appSliceDropIn)).toBe(false);
    expect(listTemporaryDropIns(fixture)).toEqual([]);
  });

  it.each([2, 3])(
    "executes retry-safe partial cleanup after publish call %s fails (#9188)",
    (failedLinkCall) => {
      const fixture = makeCommandFixture();
      const creation = runDocumentedCommand(fixture, {
        FAIL_LINK_CALL: String(failedLinkCall),
      });
      expect(creation.status).not.toBe(0);

      const firstCleanup = runPartialCreationRollback(fixture, creation.stdout);
      expect(firstCleanup.status).toBe(0);
      expect(firstCleanup.stderr).toBe("");
      expect(fs.existsSync(fixture.delegationDropIn)).toBe(false);
      expect(fs.existsSync(fixture.userSliceDropIn)).toBe(false);
      expect(fs.existsSync(fixture.appSliceDropIn)).toBe(false);
      expect(fs.existsSync(path.dirname(fixture.delegationDropIn))).toBe(false);
      expect(fs.existsSync(path.dirname(fixture.userSliceDropIn))).toBe(false);
      expect(fs.existsSync(path.dirname(fixture.appSliceDropIn))).toBe(false);

      const retry = runPartialCreationRollback(fixture, creation.stdout);
      expect(retry.status).toBe(0);
      expect(retry.stderr).toBe("");
    },
  );

  it("partial cleanup preserves pre-existing directories (#9188)", () => {
    const fixture = makeCommandFixture();
    const directories = [
      path.dirname(fixture.delegationDropIn),
      path.dirname(fixture.userSliceDropIn),
      path.dirname(fixture.appSliceDropIn),
    ];
    for (const directory of directories) {
      fs.mkdirSync(directory, { mode: 0o755 });
    }

    const creation = runDocumentedCommand(fixture, { FAIL_LINK_CALL: "2" });
    const cleanup = runPartialCreationRollback(fixture, creation.stdout);

    expect(cleanup.status).toBe(0);
    expect(fs.existsSync(fixture.delegationDropIn)).toBe(false);
    expect(directories.every((directory) => fs.existsSync(directory))).toBe(true);
  });

  it("partial cleanup refuses a published file whose identity changed (#9188)", () => {
    const fixture = makeCommandFixture();
    const creation = runDocumentedCommand(fixture, { FAIL_LINK_CALL: "2" });
    fs.renameSync(fixture.delegationDropIn, `${fixture.delegationDropIn}.original`);
    fs.writeFileSync(fixture.delegationDropIn, "replacement\n");

    const cleanup = runPartialCreationRollback(fixture, creation.stdout);

    expect(cleanup.status).not.toBe(0);
    expect(cleanup.stderr).toContain("whose identity changed");
    expect(fs.readFileSync(fixture.delegationDropIn, "utf8")).toBe("replacement\n");
  });

  it("refuses and preserves pre-existing directory metadata (#9188)", () => {
    const fixture = makeCommandFixture();
    const delegationDirectory = path.dirname(fixture.delegationDropIn);
    const userSliceDirectory = path.dirname(fixture.userSliceDropIn);
    const appSliceDirectory = path.dirname(fixture.appSliceDropIn);
    fs.mkdirSync(delegationDirectory, { mode: 0o750 });
    fs.mkdirSync(userSliceDirectory, { mode: 0o750 });
    fs.mkdirSync(appSliceDirectory, { mode: 0o750 });

    const result = runDocumentedCommand(fixture, {
      SUDO_SCENARIO: "existing-directory-metadata",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Refusing to change existing drop-in directory owner or mode");
    expect(fs.statSync(delegationDirectory).mode & 0o777).toBe(0o750);
    expect(fs.statSync(userSliceDirectory).mode & 0o777).toBe(0o750);
    expect(fs.statSync(appSliceDirectory).mode & 0o777).toBe(0o750);
    expect(fs.existsSync(fixture.delegationDropIn)).toBe(false);
    expect(fs.existsSync(fixture.userSliceDropIn)).toBe(false);
    expect(fs.existsSync(fixture.appSliceDropIn)).toBe(false);
  });

  it("records valid pre-existing directories as preserved (#9188)", () => {
    const fixture = makeCommandFixture();
    const delegationDirectory = path.dirname(fixture.delegationDropIn);
    const userSliceDirectory = path.dirname(fixture.userSliceDropIn);
    const appSliceDirectory = path.dirname(fixture.appSliceDropIn);
    fs.mkdirSync(delegationDirectory, { mode: 0o755 });
    fs.mkdirSync(userSliceDirectory, { mode: 0o755 });
    fs.mkdirSync(appSliceDirectory, { mode: 0o755 });

    const result = runDocumentedCommand(fixture);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("delegation_drop_in_dir_created=0");
    expect(result.stdout).toContain("user_slice_drop_in_dir_created=0");
    expect(result.stdout).toContain("app_slice_drop_in_dir_created=0");
    expect(result.stdout).not.toContain("delegation_drop_in_dir_id=");
    expect(result.stdout).not.toContain("user_slice_drop_in_dir_id=");
    expect(result.stdout).not.toContain("app_slice_drop_in_dir_id=");
    expect(fs.statSync(delegationDirectory).mode & 0o777).toBe(0o755);
    expect(fs.statSync(userSliceDirectory).mode & 0o777).toBe(0o755);
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
    expect(fs.existsSync(fixture.userSliceDropIn)).toBe(false);
    expect(fs.existsSync(fixture.appSliceDropIn)).toBe(false);
    expect(listTemporaryDropIns(fixture)).toEqual([]);
  });
});
