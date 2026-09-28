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

describe("Deep Agents destroy state cleanup", () => {
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
    const harness = createDestroyHarness({ agent: "langchain-deepagents-code" });

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
    expect(wipeScript).toContain("root=/sandbox");
    expect(wipeScript).toContain('[ ! -d "$root" ] || [ -L "$root" ]');
    expect(wipeScript).toContain('for keep in "$@"');
    expect(wipeScript).toContain('find "$entry" -xdev -depth -user "$uid"');
    expect(wipeScript).toContain("! -type d -exec rm -f -- {}");
    expect(wipeScript).toContain("Deep Agents native root retains sandbox-owned state");
    expect(wipeScript).not.toContain('rm -rf -- "$entry"');
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
    expect(wipeArgs.slice(commandIndex + 3)).toEqual(["/sandbox/project"]);
    expect(wipeScript).toContain('if [ "$entry" = "$keep" ]; then protected=true');
    expect(wipeScript).not.toContain('find "$root" -mindepth 1 -maxdepth 1 -exec rm -rf');
    expect(harness.removeSandboxSpy).toHaveBeenCalledWith("alpha");
  });

  it("preserves ownership when complete native-root cleanup fails", async () => {
    const harness = createDestroyHarness({ agent: "langchain-deepagents-code" });
    const defaultRun = harness.runOpenshellSpy.getMockImplementation()!;
    harness.runOpenshellSpy.mockImplementation((args: string[], options?: object) =>
      args[0] === "sandbox" && args[1] === "exec"
        ? {
            status: 21,
            stdout: "",
            stderr: "Deep Agents native root retains sandbox-owned state",
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
