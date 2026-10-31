// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import childProcess from "node:child_process";
import { vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

export function writeExecutable(filePath: string, source: string): void {
  fs.writeFileSync(filePath, source, { mode: 0o755 });
}

export function writeSnapshotRegistry(
  home: string,
  sandboxName: string,
  agent: "hermes" | null = null,
): void {
  fs.mkdirSync(path.join(home, ".nemoclaw"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".nemoclaw", "sandboxes.json"),
    JSON.stringify({
      defaultSandbox: sandboxName,
      sandboxes: {
        [sandboxName]: {
          name: sandboxName,
          model: "m",
          provider: "p",
          gpuEnabled: false,
          agent,
        },
      },
    }),
  );
}

export function writeFakeOpenshell(binDir: string): void {
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

export function writeFakeSsh(binDir: string): void {
  writeExecutable(
    path.join(binDir, "sftp"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "-h") process.exit(1);
const batch = fs.readFileSync(args[args.indexOf("-b") + 1], "utf8");
const match = /^put [/]dev[/]stdin "(.+)"\\n$/.exec(batch);
if (!match || args[args.indexOf("-R") + 1] !== "16" || args[args.indexOf("-B") + 1] !== "32768") process.exit(97);
const remote = match[1].replace(/\\\\([\\\\"])/g, "$1");
const root = process.env.NEMOCLAW_TEST_NATIVE_ROOT;
const remoteRoot = process.env.NEMOCLAW_TEST_NATIVE_HOME || "/sandbox";
const target = path.join(root, path.relative(remoteRoot, remote));
fs.writeFileSync(target, fs.readFileSync(0), { mode: 0o600, flag: "wx" });
`,
  );
  writeExecutable(
    path.join(binDir, "native-stat"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const target = args.at(-1);
const fd = /^[/](?:proc[/]self[/]fd|dev[/]fd)[/](\\d+)$/.exec(target);
const s = fd ? fs.fstatSync(Number(fd[1])) : fs.lstatSync(target);
process.stdout.write(args[1].replace(/%[udih]/g, (key) => String({ "%u": s.uid, "%d": s.dev, "%i": s.ino, "%h": s.nlink }[key])) + "\\n");
`,
  );
  writeExecutable(path.join(binDir, "stat"), '#!/bin/sh\nexec native-stat "$@"\n');
  writeExecutable(
    path.join(binDir, "sha256sum"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const crypto = require("node:crypto");
const fd = Number(process.argv.at(-1).split("/").at(-1));
const hash = crypto.createHash("sha256");
const block = Buffer.alloc(65536);
let offset = 0, size;
while ((size = fs.readSync(fd, block, 0, block.length, offset))) {
  hash.update(block.subarray(0, size)); offset += size;
}
process.stdout.write(hash.digest("hex") + "  " + process.argv.at(-1) + "\\n");
`,
  );
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
  const churnMarker = process.env.NEMOCLAW_TEST_NATIVE_CHURN_MARKER;
  if (churnMarker && !fs.existsSync(churnMarker)) {
    fs.writeFileSync(churnMarker, "churned");
    process.exit(21);
  }
  const procRoot = process.env.NEMOCLAW_TEST_NATIVE_PROC;
  if (procRoot) {
    if (process.env.NEMOCLAW_TEST_NATIVE_INIT_ANCESTOR === "1") {
      const parentRoot = path.join(procRoot, String(process.pid));
      const initRoot = path.join(procRoot, "1");
      fs.mkdirSync(parentRoot, { recursive: true });
      fs.mkdirSync(path.join(initRoot, "task", "1"), { recursive: true });
      fs.writeFileSync(path.join(parentRoot, "status"), "PPid:\\t1\\n");
      fs.writeFileSync(path.join(initRoot, "status"), "PPid:\\t0\\nUid:\\t" + process.getuid() + "\\n");
      fs.writeFileSync(path.join(initRoot, "task", "1", "status"), "State:\\tS\\n");
    }
    const prelude = 'kill() { printf "%s\\\\n" "$*" >> "$NEMOCLAW_TEST_SIGNAL_LOG"; }; sleep() { :; }; tar() { command tar -C "$NEMOCLAW_TEST_NATIVE_ROOT" -cf - .; }; ';
    const capture = spawnSync("sh", ["-c", prelude + command.replaceAll("/proc/", procRoot + "/")], {
      stdio: ["ignore", "inherit", "inherit"],
      timeout: 3000,
    });
    process.exit(capture.status ?? 95);
  }
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
    process.exit(spawnSync("tar", tarArgs, { env: { ...process.env, COPYFILE_DISABLE: "1" }, stdio: ["ignore", "inherit", "inherit"] }).status ?? 91);
  } finally {
    fs.rmSync(copyRoot, { recursive: true, force: true });
  }
}
if (command.includes("nemoclaw-native-restore")) {
  const restored = spawnSync("sh", ["-c", command.replaceAll(remoteRoot, root).replaceAll("/proc/self/fd/", "/dev/fd/")], {
    stdio: ["inherit", "inherit", "inherit"],
  });
  process.exit(restored.status ?? 94);
}
process.exit(93);
`,
  );
}

/** Block temporary SSH-state cleanup so capture failure remains non-retryable. */
export function blockNativeSshCleanup(): { restore: () => void; directories: string[] } {
  const originalRemove = fs.rmSync;
  const directories: string[] = [];
  const remove = vi.spyOn(fs, "rmSync").mockImplementation((target, options) => {
    if (typeof target === "string" && path.basename(target).startsWith("nemoclaw-native-state-")) {
      directories.push(target);
      throw new Error("cleanup blocked");
    }
    return originalRemove(target, options);
  });
  return { restore: () => remove.mockRestore(), directories };
}

export function writeNativeQuiescenceStates(
  procRoot: string,
  leader: string,
  first: string | null,
  second: string | null,
): void {
  const pidRoot = path.join(procRoot, "424242");
  fs.mkdirSync(path.join(pidRoot, "task"), { recursive: true });
  fs.writeFileSync(
    path.join(pidRoot, "status"),
    `Uid:\t${process.getuid?.() ?? 0}\nState:\t${leader}\n`,
  );
  writeTaskState(path.join(pidRoot, "task", "424242"), first);
  writeTaskState(path.join(pidRoot, "task", "424243"), second);
}

function writeTaskState(taskRoot: string, state: string | null): void {
  if (state === null) return;
  fs.mkdirSync(taskRoot);
  if (state) fs.writeFileSync(path.join(taskRoot, "status"), `State:\t${state}\n`);
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
