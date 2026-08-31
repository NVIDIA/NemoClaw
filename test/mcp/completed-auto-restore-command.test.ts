// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Args } from "@oclif/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NemoClawCommand } from "../../src/lib/cli/nemoclaw-oclif-command";
import * as lifecycleLock from "../../src/lib/state/mcp-lifecycle-lock";
import {
  createCompletedAutoRestoreFixture as reproduceCompletedAutoRestoreContainment,
  runCompletedAutoRestoreFixtureChild as runChild,
} from "../support/completed-auto-restore-fixture";

const SHIELDS_MODULE_PATH = path.resolve("src/lib/shields/index.ts");

async function loadCleanPublicShieldsStatusCommand() {
  vi.resetModules();
  const shields = await import("../../src/lib/shields/index");
  const realShieldsStatus = shields.shieldsStatus;
  vi.spyOn(shields, "shieldsStatus").mockImplementation((sandboxName, allowInlineRecovery, deps) =>
    realShieldsStatus(sandboxName, allowInlineRecovery, {
      ...deps,
      resolveConfig: () => ({
        agentName: "openclaw",
        configPath: "/sandbox/.openclaw/openclaw.json",
        configDir: "/sandbox/.openclaw",
        configFile: "openclaw.json",
        format: "json",
        stateLockPlanInImage: true,
      }),
      verifyLockState: () => ({ ok: true, issues: [] }),
      verifyStateLockPlan: () => [],
    }),
  );
  return (await import("../../src/commands/sandbox/shields/status")).default;
}

class StatusCommand extends NemoClawCommand {
  static id = "sandbox:status";
  static args = { sandboxName: Args.string({ required: true }) };
  static flags = {};
  static entered = false;

  public async run(): Promise<void> {
    const { args } = await this.parse(StatusCommand);
    StatusCommand.entered = lifecycleLock.isMcpLifecycleLockHeld(args.sandboxName!);
  }
}

class InteractiveConnectCommand extends NemoClawCommand {
  static id = "sandbox:connect";
  static args = { sandboxName: Args.string({ required: true }) };
  static flags = {};
  static recoveryPaths: string[] = [];
  static childStartedAfterRecovery = false;

  public async run(): Promise<void> {
    await this.parse(InteractiveConnectCommand);
    InteractiveConnectCommand.childStartedAfterRecovery = InteractiveConnectCommand.recoveryPaths
      .map((file) => fs.existsSync(file))
      .every((exists) => !exists);
  }
}

describe("completed auto-restore command admission", () => {
  let testHome: string;
  let stateDir: string;

  beforeEach(() => {
    testHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auto-restore-command-"));
    stateDir = path.join(testHome, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    vi.stubEnv("HOME", testHome);
    vi.stubEnv("NEMOCLAW_TEST_BASE_HOME", testHome);
    vi.stubEnv("NEMOCLAW_TEST_STATE_DIR", stateDir);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    StatusCommand.entered = false;
    InteractiveConnectCommand.recoveryPaths = [];
    InteractiveConnectCommand.childStartedAfterRecovery = false;
    fs.rmSync(testHome, { recursive: true, force: true });
  });

  it(
    "runs public Shields status after exact completed auto-restore recovery (#10094)",
    { timeout: 30_000 },
    async () => {
      const processToken = "c".repeat(32);
      const orphan = await reproduceCompletedAutoRestoreContainment(
        stateDir,
        "alpha",
        processToken,
      );
      const lockPath = lifecycleLock.getMcpLifecycleLockPath("alpha", stateDir);
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const ShieldsStatusCommand = await loadCleanPublicShieldsStatusCommand();

      await expect(ShieldsStatusCommand.run(["alpha"], process.cwd())).resolves.toBeUndefined();

      expect(log).toHaveBeenCalledWith("  Shields: UP (lockdown active)");
      expect(
        [orphan.markerPath, lockPath, `${lockPath}.deadline`, `${lockPath}.containment`].map(
          (file) => fs.existsSync(file),
        ),
      ).toEqual([false, false, false, false]);
    },
  );

  it(
    "starts ordinary sandbox connect after exact completed auto-restore recovery (#10094)",
    { timeout: 30_000 },
    async () => {
      const orphan = await reproduceCompletedAutoRestoreContainment(
        stateDir,
        "alpha",
        "6".repeat(32),
      );
      const recoveryPaths = [
        orphan.markerPath,
        orphan.lockPath,
        orphan.deadlinePath,
        orphan.containmentPath,
      ];
      InteractiveConnectCommand.recoveryPaths = recoveryPaths;

      await expect(
        InteractiveConnectCommand.run(["alpha"], process.cwd()),
      ).resolves.toBeUndefined();

      expect(InteractiveConnectCommand.childStartedAfterRecovery).toBe(true);
      expect(recoveryPaths.map((file) => fs.existsSync(file))).toEqual(
        recoveryPaths.map(() => false),
      );
    },
  );

  it.each([
    ["containment", "containmentPath", [true, true, true]],
    ["main", "lockPath", [true, true, false]],
    ["deadline", "deadlinePath", [false, true, false]],
  ] as const)(
    "recovers in the next process after %s gate cleanup fails (#10094)",
    async (_label, targetKey, retainedGates) => {
      const orphan = await reproduceCompletedAutoRestoreContainment(
        stateDir,
        "alpha",
        "b".repeat(32),
      );
      const cleanupScript = String.raw`
const fs = require("node:fs");
const shields = require(process.argv[1]);
const stateDir = process.argv[2];
const sandboxName = process.argv[3];
const targetPath = process.argv[4];
const realRename = fs.renameSync.bind(fs);
let injected = false;
fs.renameSync = (source, destination) => {
  if (!injected && String(source) === targetPath) {
    injected = true;
    const error = new Error("injected lifecycle gate cleanup failure");
    error.code = "EIO";
    throw error;
  }
  return realRename(source, destination);
};
try {
  shields.recoverCompletedAutoRestoreBeforeCommand(sandboxName, stateDir);
  process.exit(5);
} catch {
  if (!injected) process.exit(6);
  fs.writeSync(1, "INJECTED\n");
}
`;

      await runChild(
        cleanupScript,
        [SHIELDS_MODULE_PATH, stateDir, "alpha", orphan[targetKey]],
        "INJECTED",
        `${_label} cleanup`,
      );

      expect(
        [orphan.lockPath, orphan.deadlinePath, orphan.containmentPath].map((file) =>
          fs.existsSync(file),
        ),
      ).toEqual(retainedGates);

      await expect(StatusCommand.run(["alpha"], process.cwd())).resolves.toBeUndefined();

      expect(StatusCommand.entered).toBe(true);
      expect(
        [orphan.markerPath, orphan.lockPath, orphan.deadlinePath, orphan.containmentPath].map(
          (file) => fs.existsSync(file),
        ),
      ).toEqual([false, false, false, false]);
    },
    30_000,
  );

  it("recovers after lifecycle gate directory sync fails (#10094)", async () => {
    const orphan = await reproduceCompletedAutoRestoreContainment(
      stateDir,
      "alpha",
      "3".repeat(32),
    );
    const realFsync = fs.fsyncSync.bind(fs);
    vi.spyOn(fs, "fsyncSync")
      .mockImplementationOnce(() => {
        const error = new Error(
          "injected lifecycle gate directory sync failure",
        ) as NodeJS.ErrnoException;
        error.code = "EIO";
        throw error;
      })
      .mockImplementation(realFsync);

    await expect(StatusCommand.run(["alpha"], process.cwd())).rejects.toThrow(
      "lifecycle gate directory sync failure",
    );

    expect(StatusCommand.entered).toBe(false);
    expect(fs.existsSync(orphan.markerPath)).toBe(true);

    await expect(StatusCommand.run(["alpha"], process.cwd())).resolves.toBeUndefined();

    expect(StatusCommand.entered).toBe(true);
    expect(fs.existsSync(orphan.markerPath)).toBe(false);
  });

  it("denies public Shields status for an ambiguous live timer owner (#10094)", async () => {
    const processToken = "d".repeat(32);
    const orphan = await reproduceCompletedAutoRestoreContainment(stateDir, "alpha", processToken);
    const marker = JSON.parse(fs.readFileSync(orphan.markerPath, "utf8"));
    marker.pid = process.pid;
    fs.writeFileSync(orphan.markerPath, JSON.stringify(marker));
    const ShieldsStatusCommand = await loadCleanPublicShieldsStatusCommand();

    await expect(ShieldsStatusCommand.run(["alpha"], process.cwd())).rejects.toThrow(
      "containment is active",
    );
    expect(fs.existsSync(orphan.markerPath)).toBe(true);
    const lockPath = lifecycleLock.getMcpLifecycleLockPath("alpha", stateDir);
    expect(
      [lockPath, `${lockPath}.deadline`, `${lockPath}.containment`].map((file) =>
        fs.existsSync(file),
      ),
    ).toEqual([true, true, true]);
  });

  it(
    "retries an exact marker restored after cleanup failure (#10094)",
    {
      timeout: 30_000,
    },
    async () => {
      const processToken = "e".repeat(32);
      const orphan = await reproduceCompletedAutoRestoreContainment(
        stateDir,
        "alpha",
        processToken,
      );
      const realUnlink = fs.unlinkSync.bind(fs);
      let injected = false;
      const injectUnlinkFailure = (): never => {
        injected = true;
        const error = new Error("injected unlink failure") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      };
      vi.spyOn(fs, "unlinkSync").mockImplementation((target) => {
        return !injected && String(target).includes(".completed-")
          ? injectUnlinkFailure()
          : realUnlink(target);
      });

      await expect(StatusCommand.run(["alpha"], process.cwd())).rejects.toThrow("explicit retry");

      expect(injected).toBe(true);
      expect(StatusCommand.entered).toBe(false);
      expect(fs.existsSync(orphan.markerPath)).toBe(true);

      await expect(StatusCommand.run(["alpha"], process.cwd())).resolves.toBeUndefined();

      expect(StatusCommand.entered).toBe(true);
      expect(fs.existsSync(orphan.markerPath)).toBe(false);
      expect(fs.readdirSync(stateDir).filter((name) => name.includes(".completed-"))).toEqual([]);
    },
  );

  it(
    "denies entry until durable completed marker cleanup is retried (#10094)",
    { timeout: 30_000 },
    async () => {
      const processToken = "7".repeat(32);
      const orphan = await reproduceCompletedAutoRestoreContainment(
        stateDir,
        "alpha",
        processToken,
      );
      const realFsync = fs.fsyncSync.bind(fs);
      let injected = false;
      const injectFsyncFailure = (): never => {
        injected = true;
        const error = new Error("injected directory sync failure") as NodeJS.ErrnoException;
        error.code = "EIO";
        throw error;
      };
      const completedArtifacts = () =>
        fs.readdirSync(stateDir).filter((name) => name.includes(".completed-"));
      const shouldInject = () =>
        !injected && !fs.existsSync(orphan.markerPath) && completedArtifacts().length === 0;
      const fsyncSpy = vi
        .spyOn(fs, "fsyncSync")
        .mockImplementation((fd) => (shouldInject() ? injectFsyncFailure() : realFsync(fd)));

      await expect(StatusCommand.run(["alpha"], process.cwd())).rejects.toThrow("retained");

      expect(injected).toBe(true);
      expect(StatusCommand.entered).toBe(false);
      expect(fs.existsSync(orphan.markerPath)).toBe(true);
      fsyncSpy.mockRestore();

      await expect(StatusCommand.run(["alpha"], process.cwd())).resolves.toBeUndefined();

      expect(StatusCommand.entered).toBe(true);
      expect(fs.existsSync(orphan.markerPath)).toBe(false);
    },
  );

  it(
    "denies entry when timer authority changes during completed cleanup (#10094)",
    { timeout: 30_000 },
    async () => {
      const orphan = await reproduceCompletedAutoRestoreContainment(
        stateDir,
        "alpha",
        "9".repeat(32),
      );
      const replacement = {
        ...JSON.parse(fs.readFileSync(orphan.markerPath, "utf8")),
        pid: process.pid,
        processToken: "a".repeat(32),
      };
      const realRename = fs.renameSync.bind(fs);
      let replaced = false;
      const replacementHooks = new Map<string, () => void>([
        [
          orphan.markerPath,
          () => {
            replaced = true;
            fs.writeFileSync(orphan.markerPath, JSON.stringify(replacement));
          },
        ],
      ]);
      const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
        const replacementHook = replaced ? undefined : replacementHooks.get(String(source));
        replacementHook?.();
        realRename(source, destination);
      });

      try {
        await expect(StatusCommand.run(["alpha"], process.cwd())).rejects.toThrow(
          "replacement timer authority",
        );
      } finally {
        renameSpy.mockRestore();
      }

      expect(replaced).toBe(true);
      expect(StatusCommand.entered).toBe(false);
      expect(JSON.parse(fs.readFileSync(orphan.markerPath, "utf8"))).toEqual(replacement);
    },
  );

  it("denies a quarantined artifact without an exact process token (#10094)", async () => {
    const orphan = await reproduceCompletedAutoRestoreContainment(
      stateDir,
      "alpha",
      "8".repeat(32),
    );
    const quarantinePath = `${orphan.markerPath}.completed-invalid`;
    fs.renameSync(orphan.markerPath, quarantinePath);
    const invalidMarker = JSON.parse(fs.readFileSync(quarantinePath, "utf8"));
    delete invalidMarker.processToken;
    fs.writeFileSync(quarantinePath, JSON.stringify(invalidMarker));

    await expect(StatusCommand.run(["alpha"], process.cwd())).rejects.toThrow(
      "quarantined artifact without a usable process token",
    );

    expect(StatusCommand.entered).toBe(false);
    expect(fs.existsSync(quarantinePath)).toBe(true);
  });

  it(
    "recovers completed auto-restore for snapshot source and destination (#10094)",
    { timeout: 30_000 },
    async () => {
      const source = await reproduceCompletedAutoRestoreContainment(
        stateDir,
        "alpha",
        "1".repeat(32),
      );
      const destination = await reproduceCompletedAutoRestoreContainment(
        stateDir,
        "beta",
        "2".repeat(32),
      );
      const { recoverCompletedAutoRestoreForSnapshotRestore } =
        await import("../../src/lib/actions/sandbox/snapshot");

      expect(recoverCompletedAutoRestoreForSnapshotRestore(["beta", "alpha"], stateDir)).toEqual([
        "alpha",
        "beta",
      ]);

      const recoveryPaths = [
        ["alpha", source.markerPath],
        ["beta", destination.markerPath],
      ].flatMap(([sandboxName, markerPath]) => {
        const lockPath = lifecycleLock.getMcpLifecycleLockPath(sandboxName, stateDir);
        return [markerPath, lockPath, `${lockPath}.deadline`, `${lockPath}.containment`];
      });
      expect(recoveryPaths.map((file) => fs.existsSync(file))).toEqual(
        recoveryPaths.map(() => false),
      );
    },
  );

  it("keeps snapshot restore denied for an ambiguous live timer owner (#10094)", async () => {
    const orphan = await reproduceCompletedAutoRestoreContainment(
      stateDir,
      "alpha",
      "3".repeat(32),
    );
    const marker = JSON.parse(fs.readFileSync(orphan.markerPath, "utf8"));
    marker.pid = process.pid;
    fs.writeFileSync(orphan.markerPath, JSON.stringify(marker));
    const { recoverCompletedAutoRestoreForSnapshotRestore } =
      await import("../../src/lib/actions/sandbox/snapshot");
    const operation = vi.fn();

    recoverCompletedAutoRestoreForSnapshotRestore(["alpha"], stateDir);
    expect(() =>
      lifecycleLock.withMcpLifecycleLockSync("alpha", operation, {
        stateDir,
        pollIntervalMs: 5,
        timeoutMs: 25,
        corruptLockGraceMs: 1,
      }),
    ).toThrow("containment is active");
    expect(operation).not.toHaveBeenCalled();
    expect(fs.existsSync(orphan.markerPath)).toBe(true);
  });

  it(
    "retries a retained completed marker quarantine on the next command (#10094)",
    { timeout: 30_000 },
    async () => {
      const processToken = "4".repeat(32);
      const orphan = await reproduceCompletedAutoRestoreContainment(
        stateDir,
        "alpha",
        processToken,
      );
      const proofPath = path.join(
        stateDir,
        `shields-timer-authorization-alpha-${processToken}.json`,
      );
      fs.writeFileSync(proofPath, "retained proof");
      const realUnlink = fs.unlinkSync.bind(fs);
      const realLink = fs.linkSync.bind(fs);
      const denyUnlink = (): never => {
        const error = new Error("injected quarantine unlink failure") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      };
      const denyLink = (): never => {
        const error = new Error("injected marker restore failure") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      };
      const unlinkSpy = vi
        .spyOn(fs, "unlinkSync")
        .mockImplementation((target) =>
          String(target).includes(".completed-") ? denyUnlink() : realUnlink(target),
        );
      const linkSpy = vi
        .spyOn(fs, "linkSync")
        .mockImplementation((source, destination) =>
          String(source).includes(".completed-") ? denyLink() : realLink(source, destination),
        );

      try {
        await expect(StatusCommand.run(["alpha"], process.cwd())).rejects.toThrow("retained");
        expect(StatusCommand.entered).toBe(false);
        expect(fs.existsSync(orphan.markerPath)).toBe(false);
        expect(
          fs.readdirSync(stateDir).filter((name) => name.includes(".completed-")),
        ).toHaveLength(1);
      } finally {
        unlinkSpy.mockRestore();
        linkSpy.mockRestore();
      }

      await expect(StatusCommand.run(["alpha"], process.cwd())).resolves.toBeUndefined();

      expect(StatusCommand.entered).toBe(true);
      expect(fs.existsSync(proofPath)).toBe(false);
      expect(fs.readdirSync(stateDir).filter((name) => name.includes(".completed-"))).toEqual([]);
    },
  );

  it("retires multiple exact completed marker artifacts (#10094)", async () => {
    const orphan = await reproduceCompletedAutoRestoreContainment(
      stateDir,
      "alpha",
      "5".repeat(32),
    );
    const artifacts = [`${orphan.markerPath}.completed-a`, `${orphan.markerPath}.completed-b`];
    fs.renameSync(orphan.markerPath, artifacts[0]);
    fs.copyFileSync(artifacts[0], artifacts[1], fs.constants.COPYFILE_EXCL);

    await expect(StatusCommand.run(["alpha"], process.cwd())).resolves.toBeUndefined();

    expect(StatusCommand.entered).toBe(true);
    expect(artifacts.map((artifact) => fs.existsSync(artifact))).toEqual([false, false]);
  });

  it("fails closed with exact remediation for distinct completed artifacts (#10094)", async () => {
    const orphan = await reproduceCompletedAutoRestoreContainment(
      stateDir,
      "alpha",
      "6".repeat(32),
    );
    const artifacts = [`${orphan.markerPath}.completed-a`, `${orphan.markerPath}.completed-b`];
    fs.renameSync(orphan.markerPath, artifacts[0]);
    const changed = JSON.parse(fs.readFileSync(artifacts[0], "utf8"));
    changed.restoreAt = new Date(Date.now() - 120_000).toISOString();
    fs.writeFileSync(artifacts[1], JSON.stringify(changed));

    const remediation = new RegExp(
      [
        "Automatic Shields timer recovery stopped",
        stateDir,
        "Stop all NemoClaw processes",
        artifacts[0],
        artifacts[1],
        "Remove only an artifact whose exact process generation is proven obsolete",
        "nemoclaw alpha shields status",
      ]
        .map((text) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
        .join(".*"),
      "su",
    );

    await expect(StatusCommand.run(["alpha"], process.cwd())).rejects.toThrow(remediation);
    expect(StatusCommand.entered).toBe(false);
    expect(artifacts.map((artifact) => fs.existsSync(artifact))).toEqual([true, true]);
  });

  it("clears the child timeout when the timer process exits early (#10094)", async () => {
    vi.useFakeTimers();

    await expect(runChild("process.exit(1);", [], "OWNED", "timer")).rejects.toThrow(
      "timer child exited 1",
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});
