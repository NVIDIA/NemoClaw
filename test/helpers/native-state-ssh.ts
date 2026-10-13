// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { vi } from "vitest";

export function writeExecutable(filePath: string, source: string): void {
  fs.writeFileSync(filePath, source, { mode: 0o755 });
}

export function writeFakeSsh(binDir: string): void {
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
    fs.rmSync(path.join(copyRoot, ".nemoclaw", "config.json"), { force: true });
    fs.rmSync(path.join(copyRoot, ".nemoclaw", "blueprints"), { recursive: true, force: true });
    fs.rmSync(path.join(copyRoot, ".openclaw", ".nemoclaw-post-upgrade-doctor"), { force: true });
    const sessionDirectory = path.join(copyRoot, ".openclaw", "agents", "main", "sessions");
    if (fs.existsSync(sessionDirectory)) {
      for (const name of fs.readdirSync(sessionDirectory)) {
        if (name.startsWith("nemoclaw-onboard-warmup-")) {
          fs.rmSync(path.join(sessionDirectory, name), { recursive: true, force: true });
        }
      }
    }
    const hardDereferenceSupported = spawnSync("tar", ["--hard-dereference", "-cf", "-", "--files-from", "/dev/null"], { stdio: "ignore" }).status === 0;
    const tarArgs = hardDereferenceSupported
      ? ["-C", copyRoot, "--hard-dereference", "-cf", "-", "--", "."]
      : ["-C", copyRoot, "-cf", "-", "--", "."];
    process.exit(spawnSync("tar", tarArgs, { stdio: ["ignore", "inherit", "inherit"] }).status ?? 91);
  } finally {
    fs.rmSync(copyRoot, { recursive: true, force: true });
  }
}
if (command.includes("nemoclaw-native-restore")) {
  if (process.env.NEMOCLAW_TEST_EXECUTE_RESTORE_SCRIPT === "1") {
    const restored = spawnSync("sh", ["-c", command], {
      stdio: ["inherit", "inherit", "inherit"],
    });
    process.exit(restored.status ?? 94);
  }
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

/** Use real tar with explicit member order to exercise archive-tail movement deterministically. */
export function useOrderedNativeCapture(directory: string, entries: string[]): void {
  const originalSpawn = childProcess.spawnSync;
  vi.spyOn(childProcess, "spawnSync").mockImplementation((...args) => {
    if (Array.isArray(args[1]) && args[1].includes("nemoclaw-stopped-native-capture")) {
      return Reflect.apply(originalSpawn, childProcess, [
        "tar",
        ["-C", directory, "-cf", "-", "--", ...entries],
        args[2],
      ]);
    }
    return Reflect.apply(originalSpawn, childProcess, args);
  });
}
