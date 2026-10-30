// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  writeFakeOpenshell,
  writeFakeSsh,
  writeSnapshotRegistry,
} from "../support/native-snapshot.ts";

const ORIGINAL_HOME = process.env.HOME;
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-dcode-config-home-"));
process.env.HOME = TMP_HOME;
const sandboxState = await import(
  pathToFileURL(path.join(import.meta.dirname, "../..", "src", "lib", "state", "sandbox.ts")).href
);

function restoreEnv(name: string, value: string | undefined): void {
  value === undefined
    ? Reflect.deleteProperty(process.env, name)
    : Reflect.set(process.env, name, value);
}

afterAll(() => {
  restoreEnv("HOME", ORIGINAL_HOME);
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

describe("native Deep Agents config restore", () => {
  it.each([
    { keep: true, expected: "replacement selection" },
    { keep: false, expected: "archived selection" },
  ])(
    "keeps the replacement Deep Agents config only for a recorded selection change when keep=$keep (#13897)",
    async ({ keep, expected }) => {
      const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-dcode-config-"));
      const oldPath = process.env.PATH;
      const oldOpenshell = process.env.NEMOCLAW_OPENSHELL_BIN;
      const oldNativeRoot = process.env.NEMOCLAW_TEST_NATIVE_ROOT;
      const oldNativeHome = process.env.NEMOCLAW_TEST_NATIVE_HOME;
      const oldNativeWorkspace = process.env.NEMOCLAW_TEST_NATIVE_WORKSPACE;
      const oldExecuteRestore = process.env.NEMOCLAW_TEST_EXECUTE_RESTORE_SCRIPT;
      try {
        const binDir = path.join(fixture, "bin");
        const nativeRoot = path.join(fixture, "native-home");
        const config = path.join(nativeRoot, ".deepagents/config.toml");
        const memory = path.join(nativeRoot, ".deepagents/agent/AGENTS.md");
        fs.mkdirSync(binDir, { recursive: true });
        fs.mkdirSync(path.dirname(memory), { recursive: true });
        fs.writeFileSync(config, "archived selection");
        fs.writeFileSync(memory, "archived memory");
        writeFakeOpenshell(binDir);
        writeFakeSsh(binDir);
        process.env.NEMOCLAW_OPENSHELL_BIN = path.join(binDir, "openshell");
        process.env.NEMOCLAW_TEST_NATIVE_ROOT = nativeRoot;
        process.env.NEMOCLAW_TEST_NATIVE_HOME = nativeRoot;
        process.env.NEMOCLAW_TEST_NATIVE_WORKSPACE = nativeRoot;
        process.env.NEMOCLAW_TEST_EXECUTE_RESTORE_SCRIPT = "1";
        process.env.PATH = `${binDir}:${oldPath ?? ""}`;
        writeSnapshotRegistry(TMP_HOME, "alpha", "langchain-deepagents-code");
        const backup = sandboxState.backupSandboxState("alpha");
        expect(backup.success, backup.error).toBe(true);
        fs.rmSync(memory);
        fs.writeFileSync(config, "replacement selection");

        const restore = await sandboxState.restoreRecreatedSandboxState(
          "alpha",
          backup.manifest!.backupPath,
          {
            targetAgentType: "langchain-deepagents-code",
            ...(keep ? { keepReplacementDeepAgentsConfig: true as const } : {}),
          },
        );

        expect(restore.success, restore.error).toBe(true);
        expect(fs.readFileSync(config, "utf8")).toBe(expected);
        expect(fs.readFileSync(memory, "utf8")).toBe("archived memory");
      } finally {
        restoreEnv("NEMOCLAW_OPENSHELL_BIN", oldOpenshell);
        restoreEnv("NEMOCLAW_TEST_NATIVE_ROOT", oldNativeRoot);
        restoreEnv("NEMOCLAW_TEST_NATIVE_HOME", oldNativeHome);
        restoreEnv("NEMOCLAW_TEST_NATIVE_WORKSPACE", oldNativeWorkspace);
        restoreEnv("NEMOCLAW_TEST_EXECUTE_RESTORE_SCRIPT", oldExecuteRestore);
        restoreEnv("PATH", oldPath);
        fs.rmSync(fixture, { recursive: true, force: true });
      }
    },
  );
});
