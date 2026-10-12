// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createDestroyHarness,
  resetDestroyModuleCache,
} from "../../../../test/helpers/destroy-flow-test-harness";

describe("native agent destroy state cleanup", { timeout: 15_000 }, () => {
  let testHome: string;

  beforeEach(() => {
    testHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-destroy-dcode-home-"));
    vi.stubEnv("HOME", testHome);
    vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetDestroyModuleCache();
    fs.rmSync(testHome, { force: true, recursive: true });
  });

  it("clears sandbox-owned native state before sandbox deletion", async () => {
    const harness = createDestroyHarness({
      agent: "langchain-deepagents-code",
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();

    const wipeCall = harness.runOpenshellSpy.mock.calls.findIndex(
      ([args]) =>
        Array.isArray(args) &&
        args[0] === "sandbox" &&
        args[1] === "exec" &&
        args[2] === "--name" &&
        args[3] === "alpha",
    );
    const deleteCall = harness.runOpenshellSpy.mock.calls.findIndex(
      ([args]) => Array.isArray(args) && args[0] === "sandbox" && args[1] === "delete",
    );
    expect(wipeCall).toBeGreaterThanOrEqual(0);
    expect(deleteCall).toBeGreaterThan(wipeCall);
    const wipeArgs = harness.runOpenshellSpy.mock.calls[wipeCall]![0] as string[];
    const wipeScript = wipeArgs[wipeArgs.indexOf("-c") + 1]!;
    expect(wipeScript).toContain("root='/sandbox'");
    expect(wipeScript).toContain('[ ! -d "$root" ] || [ -L "$root" ]');
    expect(wipeScript).toContain("is_exact_keep()");
    expect(wipeScript).toContain("is_keep_parent()");
    expect(wipeScript).toContain('rm -rf -- "$entry"');
    expect(wipeScript).toContain('clean_dir "$root" "$@"');
    expect(wipeScript).toContain('verify_dir "$root" "$@"');
    expect(wipeScript).toContain("agent native root retains sandbox-owned state");
    expect(wipeScript).toContain(
      'echo "agent native root retains sandbox-owned state" >&2\n  exit 22',
    );
    expect(wipeScript).not.toContain('find "$entry"');
    expect(wipeArgs.slice(wipeArgs.indexOf("-c") + 3)).toEqual([
      "/sandbox/.deepagents/.env",
      "/sandbox/.deepagents/.mcp.json",
    ]);
    expect(harness.removeSandboxSpy).toHaveBeenCalledWith("alpha");
  });

  it("preserves registered host-mount targets during native-root cleanup", async () => {
    const harness = createDestroyHarness({
      agent: "langchain-deepagents-code",
      registryEntryOverrides: {
        hostMounts: [
          {
            source: "/host/project",
            target: "/sandbox/project/source",
            readOnly: true,
            sourceIdentity: { device: "1", inode: "2" },
          },
        ],
      },
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();

    const wipeArgs = harness.runOpenshellSpy.mock.calls.find(
      ([args]) => Array.isArray(args) && args[0] === "sandbox" && args[1] === "exec",
    )![0] as string[];
    const commandIndex = wipeArgs.indexOf("-c");
    const wipeScript = wipeArgs[commandIndex + 1]!;
    expect(wipeArgs.slice(commandIndex + 3)).toEqual([
      "/sandbox/.deepagents/.env",
      "/sandbox/.deepagents/.mcp.json",
      "/sandbox/project/source",
    ]);
    expect(wipeScript).toContain('[ "$candidate" != "$keep" ] || return 0');
    expect(wipeScript).toContain('[ "${keep#"$candidate"/}" = "$keep" ] || return 0');
    expect(wipeScript).toContain('if [ ! -d "$entry" ] || [ -L "$entry" ]');
    expect(harness.removeSandboxSpy).toHaveBeenCalledWith("alpha");
  });

  it("clears OpenClaw's complete native home before deletion", async () => {
    const harness = createDestroyHarness({ agent: "openclaw" });

    await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();

    const wipeArgs = harness.runOpenshellSpy.mock.calls.find(
      ([args]) => Array.isArray(args) && args[0] === "sandbox" && args[1] === "exec",
    )![0] as string[];
    const commandIndex = wipeArgs.indexOf("-c");
    expect(wipeArgs[commandIndex + 1]).toContain("root='/sandbox/.openclaw'");
    expect(wipeArgs.slice(commandIndex + 3)).toEqual([]);
    expect(harness.removeSandboxSpy).toHaveBeenCalledWith("alpha");
  });

  it("treats a legacy registry row without an agent as OpenClaw", async () => {
    const harness = createDestroyHarness({ registryEntryOverrides: { agent: null } });

    await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();

    const wipeArgs = harness.runOpenshellSpy.mock.calls.find(
      ([args]) => Array.isArray(args) && args[0] === "sandbox" && args[1] === "exec",
    )![0] as string[];
    expect(wipeArgs[wipeArgs.indexOf("-c") + 1]).toContain("root='/sandbox/.openclaw'");
  });

  it("clears Hermes native state while preserving its user-managed environment", async () => {
    const harness = createDestroyHarness({ agent: "hermes" });

    await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();

    const wipeArgs = harness.runOpenshellSpy.mock.calls.find(
      ([args]) => Array.isArray(args) && args[0] === "sandbox" && args[1] === "exec",
    )![0] as string[];
    const commandIndex = wipeArgs.indexOf("-c");
    expect(wipeArgs[commandIndex + 1]).toContain("root='/sandbox/.hermes'");
    expect(wipeArgs.slice(commandIndex + 3)).toEqual(["/sandbox/.hermes/.env"]);
    expect(harness.removeSandboxSpy).toHaveBeenCalledWith("alpha");
  });

  it("preserves ownership when complete native-root cleanup fails", async () => {
    const harness = createDestroyHarness({
      agent: "langchain-deepagents-code",
    });
    const defaultRun = harness.runOpenshellSpy.getMockImplementation()!;
    harness.runOpenshellSpy.mockImplementation((args: string[], options?: object) =>
      args[0] === "sandbox" && args[1] === "exec"
        ? {
            status: 21,
            stdout: "",
            stderr: "agent native root retains sandbox-owned state",
          }
        : defaultRun(args, options),
    );

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow("process.exit(1)");

    expect(
      harness.runOpenshellSpy.mock.calls.some(
        ([args]) => Array.isArray(args) && args[0] === "sandbox" && args[1] === "delete",
      ),
    ).toBe(false);
    expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
    expect(harness.errorSpy.mock.calls.flat().join("\n")).toContain("registry entry was preserved");
  });
});
