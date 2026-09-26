// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

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
const copyTree = (source, destination) => {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(source), destination);
    return;
  }
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const name of fs.readdirSync(source)) {
      copyTree(path.join(source, name), path.join(destination, name));
    }
    return;
  }
  fs.copyFileSync(source, destination);
};
if (commandLog) fs.appendFileSync(commandLog, command + "\\n---\\n");
if (!root) process.exit(90);
if (command.includes("printf '%s\\\\0%s\\\\0'")) {
  process.stdout.write(Buffer.from(remoteRoot + "\\0" + remoteWorkspace + "\\0"));
  process.exit(0);
}
if (command.includes("tar -C")) {
  const captureBytes = process.env.NEMOCLAW_TEST_CAPTURE_BYTES;
  if (captureBytes) {
    process.stdout.write(Buffer.alloc(Number(captureBytes), 120));
    process.exit(0);
  }
  const copyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-capture-test-"));
  try {
    for (const name of fs.readdirSync(root)) {
      copyTree(path.join(root, name), path.join(copyRoot, name));
    }
    process.exit(spawnSync("tar", ["-C", copyRoot, "-cf", "-", "--", "."], { stdio: ["ignore", "inherit", "inherit"] }).status ?? 91);
  } finally {
    fs.rmSync(copyRoot, { recursive: true, force: true });
  }
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
        if (stat.isDirectory()) {
          walk(full);
        } else if (stat.isFile() && stat.nlink > 1) {
          process.exit(21);
        }
      }
    };
    walk(stage);
    for (const entry of fs.readdirSync(root)) fs.rmSync(path.join(root, entry), { recursive: true, force: true });
    for (const entry of fs.readdirSync(stage)) {
      copyTree(path.join(stage, entry), path.join(root, entry));
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
  it("captures a prepared stopped tree without SSH and inspects only a requested subtree", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-stopped-native-state-"));
    try {
      const nativeRoot = path.join(fixture, "native-home");
      const inspectionMarker = "not-part-of-hermes-inspection";
      fs.mkdirSync(path.join(nativeRoot, ".hermes"), { recursive: true });
      fs.mkdirSync(path.join(nativeRoot, "node_modules", "example"), { recursive: true });
      fs.mkdirSync(path.join(nativeRoot, "schemas"), { recursive: true });
      fs.writeFileSync(path.join(nativeRoot, ".hermes", "config.yaml"), "model: local\n");
      fs.writeFileSync(path.join(nativeRoot, "payload.txt"), "payload");
      fs.linkSync(path.join(nativeRoot, "payload.txt"), path.join(nativeRoot, "payload-copy.txt"));
      fs.writeFileSync(
        path.join(nativeRoot, "node_modules", "example", "package.json"),
        JSON.stringify({ apiKey: "dependency-metadata-is-not-runtime-config" }),
      );
      fs.writeFileSync(
        path.join(nativeRoot, "schemas", "config.schema.json"),
        JSON.stringify({ apiKey: { type: "string" } }),
      );
      fs.writeFileSync(path.join(nativeRoot, inspectionMarker), "unrelated");
      const assertCurrent = vi.fn();
      writeOpenClawRegistry("alpha");

      const backup = sandboxState.backupSandboxState("alpha", {
        nativeStateSource: {
          root: "/sandbox",
          directory: nativeRoot,
          assertCurrent,
        },
      });

      expect(backup.success, backup.error).toBe(true);
      expect(assertCurrent).toHaveBeenCalledTimes(2);
      expect(fs.statSync(path.join(nativeRoot, "payload.txt")).nlink).toBe(1);
      expect(fs.statSync(path.join(nativeRoot, "payload-copy.txt")).nlink).toBe(1);
      const inspected = sandboxState.inspectNativeSandboxState(
        backup.manifest!.backupPath,
        (root: string) => ({
          hermesPresent: fs.existsSync(path.join(root, ".hermes", "config.yaml")),
          unrelatedPresent: fs.existsSync(path.join(root, inspectionMarker)),
        }),
        ".hermes",
      );
      expect(inspected.hermesPresent).toBe(true);
      expect(inspected.unrelatedPresent).toBe(false);
      expect(
        fs
          .readdirSync(backup.manifest!.backupPath)
          .some((entry: string) => entry.startsWith(".native-inspect-")),
      ).toBe(false);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

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
        [".openclaw/cron/jobs.json", '{"jobs":[]}'],
        [".openclaw/agents/child/history.jsonl", "child-agent"],
      ]);
      for (const [relativePath, contents] of expected) {
        const target = path.join(nativeRoot, relativePath);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, contents);
      }
      fs.linkSync(
        path.join(nativeRoot, ".local/share/packages/tool.txt"),
        path.join(nativeRoot, ".local/share/packages/tool-copy.txt"),
      );
      expected.set(".local/share/packages/tool-copy.txt", "package");
      fs.symlinkSync("unknown.txt", path.join(nativeRoot, "unknown-link"));
      fs.symlinkSync("/usr/bin/python3", path.join(nativeRoot, "python-link"));

      const backup = sandboxState.backupSandboxState("alpha");
      expect(backup.success, backup.error).toBe(true);
      expect(backup.manifest).not.toHaveProperty("stateDirs");
      expect(backup.manifest).not.toHaveProperty("stateFiles");
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
      fs.rmSync(path.join(nativeRoot, ".openclaw"), {
        recursive: true,
        force: true,
      });
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
      expect(fs.readlinkSync(path.join(nativeRoot, "python-link"))).toBe("/usr/bin/python3");
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

  it("removes a credential-bearing native archive before publishing its manifest", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-credential-"));
    const oldPath = process.env.PATH;
    const oldOpenshell = process.env.NEMOCLAW_OPENSHELL_BIN;
    const oldNativeRoot = process.env.NEMOCLAW_TEST_NATIVE_ROOT;
    try {
      const binDir = path.join(fixture, "bin");
      const nativeRoot = path.join(fixture, "native-home");
      fs.mkdirSync(binDir, { recursive: true });
      fs.mkdirSync(nativeRoot, { recursive: true });
      fs.writeFileSync(
        path.join(nativeRoot, "config.json"),
        JSON.stringify({ apiKey: "placeholder" }),
      );
      writeFakeOpenshell(binDir);
      writeFakeSsh(binDir);
      process.env.NEMOCLAW_OPENSHELL_BIN = path.join(binDir, "openshell");
      process.env.NEMOCLAW_TEST_NATIVE_ROOT = nativeRoot;
      process.env.PATH = `${binDir}:${oldPath ?? ""}`;
      writeOpenClawRegistry("alpha");

      const backup = sandboxState.backupSandboxState("alpha");

      expect(backup.success).toBe(false);
      expect(backup.error).toContain("credential-bearing or uninspectable content");
      expect(backup.error).toContain("./config.json");
      const sandboxBackups = path.join(BACKUPS_ROOT, "alpha");
      expect(fs.existsSync(sandboxBackups) ? fs.readdirSync(sandboxBackups) : []).toEqual([]);
    } finally {
      restoreEnv("NEMOCLAW_OPENSHELL_BIN", oldOpenshell);
      restoreEnv("NEMOCLAW_TEST_NATIVE_ROOT", oldNativeRoot);
      restoreEnv("PATH", oldPath);
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("restores an escaping symlink without following it outside the target root", async () => {
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
      fs.symlinkSync("../../outside", path.join(nativeRoot, "unsafe-link"));
      writeFakeOpenshell(binDir);
      writeFakeSsh(binDir);
      process.env.NEMOCLAW_OPENSHELL_BIN = path.join(binDir, "openshell");
      process.env.NEMOCLAW_TEST_NATIVE_ROOT = nativeRoot;
      process.env.NEMOCLAW_TEST_SSH_COMMAND_LOG = commandLog;
      process.env.PATH = `${binDir}:${oldPath ?? ""}`;
      writeOpenClawRegistry("alpha");

      const backup = sandboxState.backupSandboxState("alpha");
      expect(backup.success, backup.error).toBe(true);
      for (const entry of fs.readdirSync(nativeRoot)) {
        fs.rmSync(path.join(nativeRoot, entry), {
          recursive: true,
          force: true,
        });
      }
      const restore = await sandboxState.restoreSandboxState("alpha", backup.manifest!.backupPath);

      expect(restore.success, restore.error).toBe(true);
      expect(fs.readFileSync(path.join(nativeRoot, "original.txt"), "utf8")).toBe("payload");
      expect(fs.readlinkSync(path.join(nativeRoot, "unsafe-link"))).toBe("../../outside");
      const commands = fs.readFileSync(commandLog, "utf8");
      expect(commands).toContain('kill -STOP "$pid"');
      expect(commands).toContain("trap resume EXIT HUP INT TERM");
      expect(commands).toContain("-links +1");
      expect(commands).toContain('mktemp -d "$root/.nemoclaw-native-restore.XXXXXX"');
      expect(commands).toContain('! -path "$stage"');
      expect(commands).toContain('mv -- {} "$root"/');
      expect(commands).not.toContain("native restore symlink escapes root");
    } finally {
      restoreEnv("NEMOCLAW_OPENSHELL_BIN", oldOpenshell);
      restoreEnv("NEMOCLAW_TEST_NATIVE_ROOT", oldNativeRoot);
      restoreEnv("NEMOCLAW_TEST_SSH_COMMAND_LOG", oldCommandLog);
      restoreEnv("PATH", oldPath);
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
});
