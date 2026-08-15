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
};

type RollbackFixture = {
  appSliceDropIn: string;
  appSliceDropInDirectory: string;
  command: string;
  delegationDropIn: string;
  delegationDropInDirectory: string;
  environment: NodeJS.ProcessEnv;
  systemctlCallMarker: string;
};

function extractDropInCreationCommand(): string {
  const markdown = fs.readFileSync(troubleshootingPath, "utf8");
  const sectionStart = markdown.indexOf("Use the two dedicated NemoClaw drop-in paths below.");
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
    printf '%s\\n' '1:1'
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
  };
}

function fileIdentity(filePath: string): string {
  const metadata = fs.statSync(filePath);
  return `${metadata.dev}:${metadata.ino}`;
}

function makeRollbackFixture(expectedDelegationDropInId?: string): RollbackFixture {
  const root = makeTemporaryDirectory();
  const delegationDropInDirectory = path.join(root, "system");
  const appSliceDropInDirectory = path.join(root, "user");
  const delegationDropIn = path.join(delegationDropInDirectory, "90-nemoclaw-cpu-delegation.conf");
  const appSliceDropIn = path.join(appSliceDropInDirectory, "90-nemoclaw-cpu-controller.conf");
  const fakeBin = path.join(root, "bin");
  const systemctlCallMarker = path.join(root, "systemctl-calls");
  const sudo = path.join(fakeBin, "sudo");
  fs.mkdirSync(delegationDropInDirectory);
  fs.mkdirSync(appSliceDropInDirectory);
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(delegationDropIn, "[Service]\nDelegate=cpu memory pids\n");
  fs.writeFileSync(appSliceDropIn, "[Slice]\nCPUWeight=100\n");
  fs.writeFileSync(
    sudo,
    `#!/bin/sh
set -eu
if [ "\${1-}" = systemctl ]; then
  printf '%s\n' "$*" >> "$SYSTEMCTL_CALL_MARKER"
  exit 0
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
  };
}

function runDocumentedCommand(fixture: CommandFixture, environment: NodeJS.ProcessEnv = {}) {
  return spawnSync("bash", ["-c", fixture.command], {
    encoding: "utf8",
    env: { ...fixture.environment, ...environment },
  });
}

function runDocumentedRollback(fixture: RollbackFixture) {
  return spawnSync("bash", ["-c", fixture.command], {
    encoding: "utf8",
    env: fixture.environment,
  });
}

function listTemporaryDropIns(fixture: CommandFixture): string[] {
  const directories = new Set([
    path.dirname(fixture.delegationDropIn),
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
    expect(fs.existsSync(fixture.appSliceDropIn)).toBe(false);
    expect(fs.existsSync(fixture.delegationDropInDirectory)).toBe(false);
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
    expect(fs.existsSync(fixture.appSliceDropIn)).toBe(false);
    expect(fs.existsSync(fixture.appSliceDropInDirectory)).toBe(false);
    expect(fs.readFileSync(fixture.systemctlCallMarker, "utf8")).toContain(
      "systemctl start user@1000.service\n",
    );
  });

  it("creates both drop-ins with their required content and mode (#9188)", () => {
    const fixture = makeCommandFixture();
    const result = runDocumentedCommand(fixture);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(fs.readFileSync(fixture.delegationDropIn, "utf8")).toBe(
      "[Service]\nDelegate=cpu memory pids\n",
    );
    expect(fs.readFileSync(fixture.appSliceDropIn, "utf8")).toBe("[Slice]\nCPUWeight=100\n");
    expect(fs.statSync(fixture.delegationDropIn).mode & 0o777).toBe(0o644);
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
    },
  );

  it("prints each creation identity before a later drop-in publish fails (#9188)", () => {
    const fixture = makeCommandFixture();
    const result = runDocumentedCommand(fixture, { FAIL_LINK_CALL: "2" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("simulated publish link failure");
    expect(result.stdout).toContain("delegation_drop_in_dir_created=1");
    expect(result.stdout).toContain("delegation_drop_in_dir_id=1:1");
    expect(result.stdout).toContain("app_slice_drop_in_dir_created=1");
    expect(result.stdout).toContain("app_slice_drop_in_dir_id=1:1");
    expect(result.stdout).toContain("delegation_drop_in_id=1:1");
    expect(result.stdout).not.toContain("app_slice_drop_in_id=");
    expect(fs.existsSync(fixture.delegationDropIn)).toBe(true);
    expect(fs.existsSync(fixture.appSliceDropIn)).toBe(false);
    expect(listTemporaryDropIns(fixture)).toEqual([]);
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
