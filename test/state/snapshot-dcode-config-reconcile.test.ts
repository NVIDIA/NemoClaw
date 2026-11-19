// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { writeSnapshotRegistry } from "../support/native-snapshot";
import { prepareDcodeConfigRestoreFixture } from "./snapshot-dcode-config-reconcile.fixture";

const ORIGINAL_HOME = process.env.HOME;
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-dcode-config-home-"));
process.env.HOME = TMP_HOME;
const sandboxState = await import(
  pathToFileURL(path.join(import.meta.dirname, "../..", "src", "lib", "state", "sandbox.ts")).href
);

const { createSandboxRecreateProtection } =
  await import("../../src/lib/onboard/sandbox-recreate-protection");

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
    { keep: true, layout: "directory", expected: "replacement selection" },
    { keep: false, layout: "directory", expected: "archived selection" },
    { keep: true, layout: "absent", expected: "replacement selection" },
    { keep: true, layout: "archive symlink", expected: "replacement selection" },
    { keep: false, layout: "archive symlink", expected: "external selection" },
    { keep: true, layout: "replacement symlink", expected: "replacement selection" },
  ])(
    "preserves Deep Agents config safely with keep=$keep and $layout state (#13897)",
    async ({ keep, layout, expected }) => {
      const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-dcode-config-"));
      const oldPath = process.env.PATH;
      const oldOpenshell = process.env.NEMOCLAW_OPENSHELL_BIN;
      const oldNativeRoot = process.env.NEMOCLAW_TEST_NATIVE_ROOT;
      const oldNativeHome = process.env.NEMOCLAW_TEST_NATIVE_HOME;
      const oldNativeWorkspace = process.env.NEMOCLAW_TEST_NATIVE_WORKSPACE;
      const oldExecuteRestore = process.env.NEMOCLAW_TEST_EXECUTE_RESTORE_SCRIPT;
      try {
        const state = prepareDcodeConfigRestoreFixture(fixture, layout);
        const { binDir, nativeRoot, config, memory, external } = state;
        process.env.NEMOCLAW_OPENSHELL_BIN = path.join(binDir, "openshell");
        process.env.NEMOCLAW_TEST_NATIVE_ROOT = nativeRoot;
        process.env.NEMOCLAW_TEST_NATIVE_HOME = nativeRoot;
        process.env.NEMOCLAW_TEST_NATIVE_WORKSPACE = nativeRoot;
        process.env.NEMOCLAW_TEST_EXECUTE_RESTORE_SCRIPT = "1";
        process.env.PATH = `${binDir}:${oldPath ?? ""}`;
        writeSnapshotRegistry(TMP_HOME, "alpha", "langchain-deepagents-code");
        const backup = sandboxState.backupSandboxState("alpha");
        expect(backup.success, backup.error).toBe(true);
        const beginDelete = vi.fn();
        const protection = createSandboxRecreateProtection({
          sandboxName: "alpha",
          sandboxEntry: null,
          getSandbox: () => null,
          note: () => {},
        });
        const preflight = (() => {
          try {
            protection.preflightDeepAgentsConfigPreservation(backup.manifest!.backupPath, {
              agentName: "langchain-deepagents-code",
              customImage: false,
              freshSelection: keep,
              selectionChanged: keep,
              recordedSelection: false,
            });
            beginDelete();
            return "allowed";
          } catch (error) {
            return (error as Error).message;
          }
        })();
        const blockedSource = keep && layout === "archive symlink";
        expect(preflight).toBe(
          blockedSource
            ? "Cannot preserve Deep Agents config through a symbolic link. Source sandbox was not deleted."
            : "allowed",
        );
        expect(beginDelete).toHaveBeenCalledTimes(blockedSource ? 0 : 1);
        state.createReplacement();

        const restore = await sandboxState.restoreRecreatedSandboxState(
          "alpha",
          backup.manifest!.backupPath,
          {
            targetAgentType: "langchain-deepagents-code",
            ...(keep ? { keepReplacementDeepAgentsConfig: true as const } : {}),
          },
        );

        const unsafeLayout = keep && layout.endsWith("symlink");
        expect(restore.success, restore.error).toBe(!unsafeLayout);
        expect(restore.error ?? "").toContain(
          unsafeLayout ? "cannot preserve Deep Agents config through a symbolic link" : "",
        );
        expect(fs.readFileSync(config, "utf8")).toBe(expected);
        expect(fs.readFileSync(path.join(external, "config.toml"), "utf8")).toBe(
          layout === "replacement symlink" ? "replacement selection" : "external selection",
        );
        expect(fs.existsSync(memory) ? fs.readFileSync(memory, "utf8") : null).toBe(
          layout === "directory" ? "archived memory" : null,
        );
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
