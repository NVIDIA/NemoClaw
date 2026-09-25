// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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

describe("complete native home persistence", () => {
  it("round-trips unknown home, workspace, package, plugin, hook, cron, and child-agent state", async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-home-"));
    const oldPath = process.env.PATH;
    const oldOpenshell = process.env.NEMOCLAW_OPENSHELL_BIN;
    const oldNativeRoot = process.env.NEMOCLAW_TEST_NATIVE_ROOT;
    try {
      const binDir = path.join(fixture, "bin");
      const nativeRoot = path.join(fixture, "native-home");
      const openshellPrivate = path.join(fixture, "openshell-private");
      fs.mkdirSync(binDir, { recursive: true });
      fs.mkdirSync(nativeRoot, { recursive: true });
      fs.mkdirSync(openshellPrivate, { recursive: true });
      fs.writeFileSync(path.join(openshellPrivate, "credential"), "host-only-secret");
      writeFakeOpenshell(binDir);
      writeExecutable(
        path.join(binDir, "ssh"),
        `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const command = process.argv.at(-1) || "";
const root = process.env.NEMOCLAW_TEST_NATIVE_ROOT;
if (!root) process.exit(90);
if (command.includes("printf '%s\\\\0%s\\\\0'")) {
  process.stdout.write(Buffer.from("/sandbox\\0/sandbox\\0"));
  process.exit(0);
}
if (command.includes("exec tar -C")) {
  process.exit(spawnSync("tar", ["-C", root, "-cf", "-", "--", "."], { stdio: ["ignore", "inherit", "inherit"] }).status ?? 91);
}
if (command.includes('find "$root" -mindepth 1')) {
  for (const entry of fs.readdirSync(root)) fs.rmSync(path.join(root, entry), { recursive: true, force: true });
  process.exit(spawnSync("tar", ["--no-same-owner", "-xf", "-", "-C", root], { stdio: ["inherit", "inherit", "inherit"] }).status ?? 92);
}
process.exit(93);
`,
      );
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

      fs.writeFileSync(path.join(nativeRoot, "unknown.txt"), "changed");
      fs.rmSync(path.join(nativeRoot, ".openclaw"), { recursive: true, force: true });
      fs.writeFileSync(path.join(nativeRoot, "stale.txt"), "remove-me");

      const restore = await sandboxState.restoreSandboxState("alpha", backup.manifest!.backupPath);
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
});
