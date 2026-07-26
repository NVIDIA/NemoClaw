// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const SOURCE_PATH = path.join(import.meta.dirname, "index.ts");
const SCRIPT_MARKER = "const LEGACY_HERMES_CONFIG_TRANSITION_SCRIPT = String.raw`";
const fixtures: string[] = [];

function legacyTransitionScriptForCurrentUser(): string {
  const source = fs.readFileSync(SOURCE_PATH, "utf-8");
  const start = source.indexOf(SCRIPT_MARKER);
  expect(start, "legacy Hermes transition script marker is missing").toBeGreaterThanOrEqual(0);
  const bodyStart = start + SCRIPT_MARKER.length;
  const bodyEnd = source.indexOf("`;", bodyStart);
  expect(bodyEnd, "legacy Hermes transition script terminator is missing").toBeGreaterThanOrEqual(
    0,
  );

  // Production deliberately resolves the in-container sandbox identity and
  // root. The behavioral fixture runs unprivileged on the host, so substitute
  // only those identities while preserving the exact traversal, hash,
  // replacement, rollback, and mode logic under test.
  return source
    .slice(bodyStart, bodyEnd)
    .replace("or st.st_uid != 0", "or st.st_uid != os.geteuid()")
    .replace(
      'sandbox_uid = pwd.getpwnam("sandbox").pw_uid\nsandbox_gid = grp.getgrnam("sandbox").gr_gid',
      "sandbox_uid = os.geteuid()\nsandbox_gid = os.getegid()",
    )
    .replace('desired_uid = 0 if action == "lock" else sandbox_uid', "desired_uid = os.geteuid()")
    .replace('desired_gid = 0 if action == "lock" else sandbox_gid', "desired_gid = os.getegid()")
    .replaceAll("os.fchown(config_fd, 0, 0)", "os.fchown(config_fd, os.geteuid(), os.getegid())")
    .replaceAll("os.fchown(parent_fd, 0, 0)", "os.fchown(parent_fd, os.geteuid(), os.getegid())")
    .replace(
      "os.fchown(parent_fd, 0, sandbox_gid)",
      "os.fchown(parent_fd, os.geteuid(), os.getegid())",
    );
}

function digestEntry(filePath: string, bytes: Buffer): string {
  return `${createHash("sha256").update(bytes).digest("hex")}  ${filePath}\n`;
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-hermes-transition-"));
  fixtures.push(root);
  const parentDir = path.join(root, "sandbox");
  const configDir = path.join(parentDir, ".hermes");
  const configPath = path.join(configDir, "config.yaml");
  const envPath = path.join(configDir, ".env");
  const compatPath = path.join(configDir, ".config-hash");
  const strictPath = path.join(root, "hermes.config-hash");
  const configBytes = Buffer.from("default: trusted-model\n");
  const envBytes = Buffer.from("API_KEY=trusted-placeholder\n");

  fs.mkdirSync(configDir, { recursive: true, mode: 0o770 });
  fs.chmodSync(parentDir, 0o755);
  fs.chmodSync(configDir, 0o3770);
  fs.writeFileSync(configPath, configBytes, { mode: 0o640 });
  fs.writeFileSync(envPath, envBytes, { mode: 0o640 });
  const hashText = digestEntry(configPath, configBytes) + digestEntry(envPath, envBytes);
  fs.writeFileSync(compatPath, hashText, { mode: 0o640 });
  fs.writeFileSync(strictPath, hashText, { mode: 0o444 });
  fs.chmodSync(strictPath, 0o444);

  return {
    parentDir,
    configDir,
    configPath,
    envPath,
    compatPath,
    strictPath,
    configBytes,
  };
}

function runTransition(fixture: ReturnType<typeof createFixture>, action: "lock" | "unlock") {
  return spawnSync(
    "python3",
    [
      "-c",
      legacyTransitionScriptForCurrentUser(),
      action,
      fixture.configDir,
      fixture.strictPath,
      fixture.configPath,
      fixture.envPath,
      fixture.compatPath,
    ],
    { encoding: "utf-8" },
  );
}

function mode(filePath: string): number {
  return fs.statSync(filePath).mode & 0o7777;
}

function readRegularFileSnapshot(filePath: string) {
  const fd = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    expect(stat.isFile(), `expected a regular file at '${filePath}'`).toBe(true);
    return {
      bytes: fs.readFileSync(fd),
      inode: stat.ino,
      mode: Number(stat.mode & 0o7777n),
    };
  } finally {
    fs.closeSync(fd);
  }
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

describe("legacy Hermes config transition", () => {
  it("fresh-replaces locked files, revokes stale writable FDs, protects the parent, and rejects strict-anchor tamper", () => {
    const fixture = createFixture();
    const staleFd = fs.openSync(fixture.configPath, "r+");
    const staleInode = fs.fstatSync(staleFd, { bigint: true }).ino;

    const locked = runTransition(fixture, "lock");
    expect(locked.status, locked.stderr).toBe(0);
    const lockedSnapshot = readRegularFileSnapshot(fixture.configPath);
    expect(lockedSnapshot.inode).not.toBe(staleInode);
    fs.writeSync(staleFd, Buffer.from("EVIL"), 0, 4, 0);
    fs.fsyncSync(staleFd);
    fs.closeSync(staleFd);

    const afterStaleWrite = readRegularFileSnapshot(fixture.configPath);
    expect(afterStaleWrite.inode).toBe(lockedSnapshot.inode);
    expect(afterStaleWrite.bytes).toEqual(fixture.configBytes);
    expect(mode(fixture.parentDir)).toBe(0o1775);
    expect(mode(fixture.configDir)).toBe(0o755);
    expect(afterStaleWrite.mode).toBe(0o444);
    expect(mode(fixture.envPath)).toBe(0o444);
    expect(mode(fixture.compatPath)).toBe(0o444);

    fs.chmodSync(fixture.strictPath, 0o644);
    fs.writeFileSync(fixture.strictPath, "tampered\n");
    fs.chmodSync(fixture.strictPath, 0o444);
    const refused = runTransition(fixture, "unlock");
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("strict hash verification failed");
    expect(mode(fixture.parentDir)).toBe(0o1775);
    expect(mode(fixture.configDir)).toBe(0o755);
    const afterRefusedUnlock = readRegularFileSnapshot(fixture.configPath);
    expect(afterRefusedUnlock.inode).toBe(afterStaleWrite.inode);
    expect(afterRefusedUnlock.bytes).toEqual(fixture.configBytes);
    expect(afterRefusedUnlock.mode).toBe(0o444);
  });

  it("rejects oversized mutable inputs before staging replacements", () => {
    const fixture = createFixture();
    fs.truncateSync(fixture.configPath, 16 * 1024 * 1024 + 1);

    const result = runTransition(fixture, "lock");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("legacy Hermes file exceeds size limit");
    expect(mode(fixture.parentDir)).toBe(0o755);
    expect(mode(fixture.configDir)).toBe(0o3770);
  });
});
