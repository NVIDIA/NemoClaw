// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

const ORIGINAL_HOME = process.env.HOME;
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-churn-"));
process.env.HOME = TMP_HOME;

const sandboxState = await import(
  pathToFileURL(path.join(import.meta.dirname, "../..", "src", "lib", "state", "sandbox.ts")).href
);
const BACKUPS_ROOT = path.join(TMP_HOME, ".nemoclaw", "rebuild-backups");

function writeExecutable(target: string, body: string): void {
  fs.writeFileSync(target, body, { mode: 0o755 });
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
  // The native-capture SSH command quiesces the sandbox's same-UID process
  // set and aborts with exit 21 while a freshly started sandbox is still
  // booting. Surface that exact exit so the state layer classifies it.
  writeExecutable(
    path.join(binDir, "ssh"),
    `#!/usr/bin/env node
const command = process.argv.at(-1) || "";
const root = process.env.NEMOCLAW_TEST_NATIVE_ROOT;
if (!root) process.exit(90);
if (command.includes("printf '%s\\\\0%s\\\\0'")) {
  process.stdout.write(Buffer.from(root + "\\0" + root + "\\0"));
  process.exit(0);
}
if (command.includes("tar -C")) process.exit(21);
process.exit(0);
`,
  );
}

function restoreEnv(name: string, value: string | undefined): void {
  value === undefined
    ? Reflect.deleteProperty(process.env, name)
    : Reflect.set(process.env, name, value);
}

afterAll(() => {
  ORIGINAL_HOME === undefined
    ? Reflect.deleteProperty(process.env, "HOME")
    : Reflect.set(process.env, "HOME", ORIGINAL_HOME);
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(BACKUPS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.join(TMP_HOME, ".nemoclaw"), { recursive: true });
  fs.writeFileSync(
    path.join(TMP_HOME, ".nemoclaw", "sandboxes.json"),
    JSON.stringify({
      defaultSandbox: "alpha",
      sandboxes: {
        alpha: { name: "alpha", model: "m", provider: "p", gpuEnabled: false, agent: null },
      },
    }),
  );
});

describe("live SSH native-home capture process churn", () => {
  it("reports a churned capture as retryable native churn, not unreachable (#12867)", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-churn-run-"));
    const oldPath = process.env.PATH;
    const oldOpenshell = process.env.NEMOCLAW_OPENSHELL_BIN;
    const oldNativeRoot = process.env.NEMOCLAW_TEST_NATIVE_ROOT;
    try {
      const binDir = path.join(fixture, "bin");
      const nativeRoot = path.join(fixture, "native-home");
      fs.mkdirSync(binDir, { recursive: true });
      fs.mkdirSync(nativeRoot, { recursive: true });
      writeFakeOpenshell(binDir);
      writeFakeSsh(binDir);
      process.env.NEMOCLAW_OPENSHELL_BIN = path.join(binDir, "openshell");
      process.env.NEMOCLAW_TEST_NATIVE_ROOT = nativeRoot;
      process.env.PATH = `${binDir}:${oldPath ?? ""}`;

      const backup = sandboxState.backupSandboxState("alpha");

      expect(backup.success).toBe(false);
      expect(backup.error).toContain("Native home/workspace capture failed: exit 21");
      expect(backup.nativeChurn).toBe(true);
      expect(backup.unreachable).toBeUndefined();
      const sandboxBackups = path.join(BACKUPS_ROOT, "alpha");
      expect(fs.existsSync(sandboxBackups) ? fs.readdirSync(sandboxBackups) : []).toEqual([]);
    } finally {
      restoreEnv("NEMOCLAW_OPENSHELL_BIN", oldOpenshell);
      restoreEnv("NEMOCLAW_TEST_NATIVE_ROOT", oldNativeRoot);
      restoreEnv("PATH", oldPath);
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
});
