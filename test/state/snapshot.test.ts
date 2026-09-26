// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const ORIGINAL_HOME = process.env.HOME;
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-state-"));
process.env.HOME = TMP_HOME;

const sandboxState = await import(
  pathToFileURL(path.join(import.meta.dirname, "../..", "src", "lib", "state", "sandbox.ts")).href
);
const BACKUPS_ROOT = path.join(TMP_HOME, ".nemoclaw", "rebuild-backups");

afterAll(() => {
  restoreEnv("HOME", ORIGINAL_HOME);
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(BACKUPS_ROOT, { recursive: true, force: true });
});

function writeExecutable(filePath: string, source: string): void {
  fs.writeFileSync(filePath, source, { mode: 0o755 });
}

function restoreEnv(name: string, value: string | undefined): void {
  value === undefined
    ? Reflect.deleteProperty(process.env, name)
    : Reflect.set(process.env, name, value);
}

function writeOpenClawRegistry(sandboxName: string): void {
  fs.mkdirSync(path.join(TMP_HOME, ".nemoclaw"), { recursive: true });
  fs.writeFileSync(
    path.join(TMP_HOME, ".nemoclaw", "sandboxes.json"),
    JSON.stringify({
      defaultSandbox: sandboxName,
      sandboxes: {
        [sandboxName]: {
          name: sandboxName,
          model: "m",
          provider: "p",
          gpuEnabled: false,
          agent: null,
        },
      },
    }),
  );
}

function writeFakeOpenshell(binDir: string): void {
  writeExecutable(
    path.join(binDir, "openshell"),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "sandbox" && args[1] === "ssh-config") {
  process.stdout.write("Host openshell-alpha\\n  HostName 127.0.0.1\\n  User sandbox\\n");
  process.exit(0);
}
process.exit(0);
`,
  );
}

function writeFakeSsh(binDir: string): void {
  writeExecutable(
    path.join(binDir, "ssh"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const command = process.argv.at(-1) || "";
const root = process.env.NEMOCLAW_TEST_NATIVE_ROOT;
const remoteRoot = process.env.NEMOCLAW_TEST_NATIVE_HOME || "/sandbox";
const remoteWorkspace = process.env.NEMOCLAW_TEST_NATIVE_WORKSPACE || remoteRoot;
const commandLog = process.env.NEMOCLAW_TEST_SSH_COMMAND_LOG;
if (commandLog) fs.appendFileSync(commandLog, command + "\\n---\\n");
if (!root) process.exit(90);
if (command.includes("printf '%s\\\\0%s\\\\0'")) {
  process.stdout.write(Buffer.from(remoteRoot + "\\0" + remoteWorkspace + "\\0"));
  process.exit(0);
}
if (command.includes("exec tar -C")) {
  const captureBytes = process.env.NEMOCLAW_TEST_CAPTURE_BYTES;
  if (captureBytes) {
    process.stdout.write(Buffer.alloc(Number(captureBytes), 120));
    process.exit(0);
  }
  process.exit(spawnSync("tar", ["-C", root, "-cf", "-", "--", "."], { stdio: ["ignore", "inherit", "inherit"] }).status ?? 91);
}
if (command.includes("nemoclaw-native-restore")) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-restore-test-"));
  try {
    const extracted = spawnSync("tar", ["--no-same-owner", "-xf", "-", "-C", stage], { stdio: ["inherit", "inherit", "inherit"] });
    if (extracted.status !== 0) process.exit(extracted.status ?? 92);
    const walk = (current) => {
      for (const name of fs.readdirSync(current)) {
        const full = path.join(current, name);
        const stat = fs.lstatSync(full);
        if (stat.isSymbolicLink()) {
          const target = fs.readlinkSync(full);
          const resolved = path.isAbsolute(target)
            ? path.posix.normalize(target)
            : path.resolve(path.dirname(full), target);
          const safe = path.isAbsolute(target)
            ? resolved === remoteRoot || resolved.startsWith(remoteRoot + "/")
            : resolved === stage || resolved.startsWith(stage + path.sep);
          if (!safe) process.exit(22);
        } else if (stat.isDirectory()) {
          walk(full);
        } else if (stat.isFile() && stat.nlink > 1) {
          process.exit(21);
        }
      }
    };
    walk(stage);
    for (const entry of fs.readdirSync(root)) fs.rmSync(path.join(root, entry), { recursive: true, force: true });
    for (const entry of fs.readdirSync(stage)) {
      fs.cpSync(path.join(stage, entry), path.join(root, entry), { recursive: true, dereference: false, preserveTimestamps: true, verbatimSymlinks: true });
    }
    process.exit(0);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}
process.exit(93);
`,
  );
}

describe("complete native home persistence", () => {
  it("round-trips unknown home, workspace, package, plugin, hook, cron, and child-agent state", async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-home-"));
    const oldPath = process.env.PATH;
    const oldOpenshell = process.env.NEMOCLAW_OPENSHELL_BIN;
    const oldNativeRoot = process.env.NEMOCLAW_TEST_NATIVE_ROOT;
    try {
      const binDir = path.join(fixture, "bin");
      const nativeRoot = path.join(fixture, "native-home");
      const openshellPrivate = path.join(fixture, ".openshell");
      fs.mkdirSync(binDir, { recursive: true });
      fs.mkdirSync(nativeRoot, { recursive: true });
      fs.mkdirSync(openshellPrivate, { recursive: true });
      fs.writeFileSync(path.join(openshellPrivate, "credential"), "host-only-secret");
      writeFakeOpenshell(binDir);
      writeFakeSsh(binDir);
      process.env.NEMOCLAW_OPENSHELL_BIN = path.join(binDir, "openshell");
      process.env.NEMOCLAW_TEST_NATIVE_ROOT = nativeRoot;
      process.env.PATH = `${binDir}:${oldPath ?? ""}`;
      writeOpenClawRegistry("alpha");

      const expected = new Map([
        ["unknown.txt", "undeclared"],
        ["workspace/project.txt", "workspace"],
        [".openclaw/openclaw.json", '{"native":true}'],
        [".local/share/packages/tool.txt", "package"],
        [".openclaw/plugins/custom/index.js", "plugin"],
        [".openclaw/hooks/preflight.sh", "hook"],
        [".openclaw/cron/jobs.json", "cron"],
        [".openclaw/agents/child/history.jsonl", "child-agent"],
      ]);
      for (const [relativePath, contents] of expected) {
        const target = path.join(nativeRoot, relativePath);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, contents);
      }
      fs.symlinkSync("unknown.txt", path.join(nativeRoot, "unknown-link"));

      const backup = sandboxState.backupSandboxState("alpha");
      expect(backup.success).toBe(true);
      expect(backup.manifest?.stateDirs).toEqual([]);
      expect(backup.manifest?.stateFiles).toEqual([]);
      expect(backup.manifest?.nativeState).toMatchObject({
        root: "/sandbox",
        archive: "native-home.tar",
      });
      const archivedPaths = spawnSync("tar", [
        "-tf",
        path.join(backup.manifest!.backupPath, "native-home.tar"),
      ]);
      expect(archivedPaths.status).toBe(0);
      expect(archivedPaths.stdout.toString()).not.toContain(".openshell");
      expect(archivedPaths.stdout.toString()).not.toContain("credential");

      fs.writeFileSync(path.join(nativeRoot, "unknown.txt"), "changed");
      fs.rmSync(path.join(nativeRoot, ".openclaw"), { recursive: true, force: true });
      fs.writeFileSync(path.join(nativeRoot, "stale.txt"), "remove-me");

      let archiveMutatedAfterValidation = false;
      const restore = await sandboxState.restoreSandboxState("alpha", backup.manifest!.backupPath, {
        validateBeforeMutation: () => {
          fs.writeFileSync(
            path.join(backup.manifest!.backupPath, "native-home.tar"),
            "changed after validation",
          );
          archiveMutatedAfterValidation = true;
        },
      });
      expect(archiveMutatedAfterValidation).toBe(true);
      expect(restore).toEqual({
        success: true,
        restoredDirs: ["."],
        failedDirs: [],
        restoredFiles: [],
        failedFiles: [],
      });
      for (const [relativePath, contents] of expected) {
        expect(fs.readFileSync(path.join(nativeRoot, relativePath), "utf8")).toBe(contents);
      }
      expect(fs.readlinkSync(path.join(nativeRoot, "unknown-link"))).toBe("unknown.txt");
      expect(fs.existsSync(path.join(nativeRoot, "stale.txt"))).toBe(false);
      expect(fs.readFileSync(path.join(openshellPrivate, "credential"), "utf8")).toBe(
        "host-only-secret",
      );
    } finally {
      restoreEnv("NEMOCLAW_OPENSHELL_BIN", oldOpenshell);
      restoreEnv("NEMOCLAW_TEST_NATIVE_ROOT", oldNativeRoot);
      restoreEnv("PATH", oldPath);
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("rejects the OpenShell credential root before archive creation", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-credential-root-"));
    const oldPath = process.env.PATH;
    const oldOpenshell = process.env.NEMOCLAW_OPENSHELL_BIN;
    const oldNativeRoot = process.env.NEMOCLAW_TEST_NATIVE_ROOT;
    const oldNativeHome = process.env.NEMOCLAW_TEST_NATIVE_HOME;
    const oldNativeWorkspace = process.env.NEMOCLAW_TEST_NATIVE_WORKSPACE;
    try {
      const binDir = path.join(fixture, "bin");
      const credentialRoot = path.join(fixture, ".openshell");
      fs.mkdirSync(binDir, { recursive: true });
      fs.mkdirSync(credentialRoot, { recursive: true });
      fs.writeFileSync(path.join(credentialRoot, "credential"), "host-only-secret");
      writeFakeOpenshell(binDir);
      writeFakeSsh(binDir);
      process.env.NEMOCLAW_OPENSHELL_BIN = path.join(binDir, "openshell");
      process.env.NEMOCLAW_TEST_NATIVE_ROOT = credentialRoot;
      process.env.NEMOCLAW_TEST_NATIVE_HOME = "/.openshell";
      process.env.NEMOCLAW_TEST_NATIVE_WORKSPACE = "/.openshell/workspace";
      process.env.PATH = `${binDir}:${oldPath ?? ""}`;
      writeOpenClawRegistry("alpha");

      const backup = sandboxState.backupSandboxState("alpha");

      expect(backup.success).toBe(false);
      expect(backup.error).toContain("outside '/.openshell'");
      expect(fs.readFileSync(path.join(credentialRoot, "credential"), "utf8")).toBe(
        "host-only-secret",
      );
      const sandboxBackups = path.join(BACKUPS_ROOT, "alpha");
      expect(fs.existsSync(sandboxBackups) ? fs.readdirSync(sandboxBackups) : []).toEqual([]);
    } finally {
      restoreEnv("NEMOCLAW_OPENSHELL_BIN", oldOpenshell);
      restoreEnv("NEMOCLAW_TEST_NATIVE_ROOT", oldNativeRoot);
      restoreEnv("NEMOCLAW_TEST_NATIVE_HOME", oldNativeHome);
      restoreEnv("NEMOCLAW_TEST_NATIVE_WORKSPACE", oldNativeWorkspace);
      restoreEnv("PATH", oldPath);
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("removes an incomplete archive when capture exceeds available backup space", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-limit-"));
    const oldPath = process.env.PATH;
    const oldOpenshell = process.env.NEMOCLAW_OPENSHELL_BIN;
    const oldNativeRoot = process.env.NEMOCLAW_TEST_NATIVE_ROOT;
    const oldCaptureBytes = process.env.NEMOCLAW_TEST_CAPTURE_BYTES;
    try {
      const binDir = path.join(fixture, "bin");
      const nativeRoot = path.join(fixture, "native-home");
      fs.mkdirSync(binDir, { recursive: true });
      fs.mkdirSync(nativeRoot, { recursive: true });
      writeFakeOpenshell(binDir);
      writeFakeSsh(binDir);
      process.env.NEMOCLAW_OPENSHELL_BIN = path.join(binDir, "openshell");
      process.env.NEMOCLAW_TEST_NATIVE_ROOT = nativeRoot;
      process.env.NEMOCLAW_TEST_CAPTURE_BYTES = "4096";
      process.env.PATH = `${binDir}:${oldPath ?? ""}`;
      writeOpenClawRegistry("alpha");

      const backup = sandboxState.backupSandboxState("alpha", {
        nativeStateCaptureMaxBytes: 1024,
      });

      expect(backup.success).toBe(false);
      expect(backup.error).toContain("exceeded the 1024-byte backup-space limit");
      const sandboxBackups = path.join(BACKUPS_ROOT, "alpha");
      expect(fs.existsSync(sandboxBackups) ? fs.readdirSync(sandboxBackups) : []).toEqual([]);
    } finally {
      restoreEnv("NEMOCLAW_OPENSHELL_BIN", oldOpenshell);
      restoreEnv("NEMOCLAW_TEST_NATIVE_ROOT", oldNativeRoot);
      restoreEnv("NEMOCLAW_TEST_CAPTURE_BYTES", oldCaptureBytes);
      restoreEnv("PATH", oldPath);
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it.each(["escaping symlink", "hard link"] as const)(
    "rejects an %s from the staged archive before clearing the target root",
    async (kind) => {
      const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-link-"));
      const oldPath = process.env.PATH;
      const oldOpenshell = process.env.NEMOCLAW_OPENSHELL_BIN;
      const oldNativeRoot = process.env.NEMOCLAW_TEST_NATIVE_ROOT;
      const oldCommandLog = process.env.NEMOCLAW_TEST_SSH_COMMAND_LOG;
      try {
        const binDir = path.join(fixture, "bin");
        const nativeRoot = path.join(fixture, "native-home");
        const commandLog = path.join(fixture, "ssh-commands.log");
        fs.mkdirSync(binDir, { recursive: true });
        fs.mkdirSync(nativeRoot, { recursive: true });
        fs.writeFileSync(path.join(nativeRoot, "original.txt"), "payload");
        if (kind === "escaping symlink") {
          fs.symlinkSync("../../outside", path.join(nativeRoot, "unsafe-link"));
        } else {
          fs.linkSync(path.join(nativeRoot, "original.txt"), path.join(nativeRoot, "unsafe-link"));
        }
        writeFakeOpenshell(binDir);
        writeFakeSsh(binDir);
        process.env.NEMOCLAW_OPENSHELL_BIN = path.join(binDir, "openshell");
        process.env.NEMOCLAW_TEST_NATIVE_ROOT = nativeRoot;
        process.env.NEMOCLAW_TEST_SSH_COMMAND_LOG = commandLog;
        process.env.PATH = `${binDir}:${oldPath ?? ""}`;
        writeOpenClawRegistry("alpha");

        const backup = sandboxState.backupSandboxState("alpha");
        expect(backup.success).toBe(true);
        for (const entry of fs.readdirSync(nativeRoot)) {
          fs.rmSync(path.join(nativeRoot, entry), { recursive: true, force: true });
        }
        fs.writeFileSync(path.join(nativeRoot, "keep.txt"), "untouched");

        const restore = await sandboxState.restoreSandboxState(
          "alpha",
          backup.manifest!.backupPath,
        );

        expect(restore.success).toBe(false);
        expect(fs.readFileSync(path.join(nativeRoot, "keep.txt"), "utf8")).toBe("untouched");
        expect(fs.readdirSync(nativeRoot)).toEqual(["keep.txt"]);
        const commands = fs.readFileSync(commandLog, "utf8");
        expect(commands).toContain("-links +1");
        expect(commands).toContain("native restore symlink escapes root");
      } finally {
        restoreEnv("NEMOCLAW_OPENSHELL_BIN", oldOpenshell);
        restoreEnv("NEMOCLAW_TEST_NATIVE_ROOT", oldNativeRoot);
        restoreEnv("NEMOCLAW_TEST_SSH_COMMAND_LOG", oldCommandLog);
        restoreEnv("PATH", oldPath);
        fs.rmSync(fixture, { recursive: true, force: true });
      }
    },
  );
});
