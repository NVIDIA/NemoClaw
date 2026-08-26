// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { resolveNemoclawStateDir } from "../state/paths";
import { cleanupShieldsDestroyArtifacts } from "./destroy-cleanup";

describe("Shields destroy cleanup", () => {
  it("destroy neutralizes active shields timer and only deletes target sandbox files", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "destroy-shields-"));
    const alphaRecovery = path.join(stateDir, "shields-external-policy-alpha.yaml");
    const alphaState = path.join(stateDir, "shields-alpha.json");
    const alphaTimer = path.join(stateDir, "shields-timer-alpha.json");
    const betaRecovery = path.join(stateDir, "shields-external-policy-beta.yaml");
    const betaState = path.join(stateDir, "shields-beta.json");
    const betaTimer = path.join(stateDir, "shields-timer-beta.json");

    fs.writeFileSync(alphaRecovery, "version: 1\nnetwork_policies: {}\n");
    fs.writeFileSync(alphaState, '{"shieldsDown":true}');
    fs.writeFileSync(alphaTimer, '{"pid":9999}');
    fs.writeFileSync(betaRecovery, "version: 1\nnetwork_policies: {}\n");
    fs.writeFileSync(betaState, '{"shieldsDown":true}');
    fs.writeFileSync(betaTimer, '{"pid":9999}');

    const cleanupCalls: string[] = [];
    cleanupShieldsDestroyArtifacts("alpha", {
      stateDir,
      killShieldsTimer: (sandboxName) => {
        cleanupCalls.push(`revoke:${sandboxName}`);
        return {
          authorityRevoked: true,
          warnings: [],
        };
      },
      rmSync: ((...args: Parameters<typeof fs.rmSync>) => {
        cleanupCalls.push(`remove:${path.basename(String(args[0]))}`);
        fs.rmSync(...args);
      }) as typeof fs.rmSync,
    });

    expect(cleanupCalls).toEqual([
      "revoke:alpha",
      "remove:shields-external-policy-alpha.yaml",
      "remove:shields-alpha.json",
      "remove:shields-timer-alpha.json",
    ]);
    expect(fs.existsSync(alphaRecovery)).toBe(false);
    expect(fs.existsSync(alphaState)).toBe(false);
    expect(fs.existsSync(alphaTimer)).toBe(false);
    expect(fs.existsSync(betaRecovery)).toBe(true);
    expect(fs.existsSync(betaState)).toBe(true);
    expect(fs.existsSync(betaTimer)).toBe(true);

    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("destroy preserves all Shields artifacts when timer authority revocation fails (#9833)", () => {
    const warnings: string[] = [];
    const rmSync = vi.fn();

    expect(() =>
      cleanupShieldsDestroyArtifacts("alpha", {
        stateDir: "/tmp/nonexistent-state-dir",
        rmSync: rmSync as unknown as typeof fs.rmSync,
        killShieldsTimer: () => ({
          authorityRevoked: false,
          warnings: ["Failed to remove the Shields timer marker"],
        }),
        warn: (message) => warnings.push(message),
      }),
    ).toThrow(
      "Could not revoke Shields timer authority for sandbox 'alpha'. Shields cleanup artifacts were preserved for retry.",
    );

    expect(warnings).toEqual(["Failed to remove the Shields timer marker"]);
    expect(rmSync).not.toHaveBeenCalled();
  });

  it("destroy restores the recovery artifact when Shields state removal fails (#9833)", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "destroy-shields-rollback-"));
    const recoveryPath = path.join(stateDir, "shields-external-policy-alpha.yaml");
    const statePath = path.join(stateDir, "shields-alpha.json");
    const timerPath = path.join(stateDir, "shields-timer-alpha.json");
    const recoveryContent = "version: 1\nnetwork_policies: {}\n";
    const stateContent = '{"shieldsDown":true}';
    fs.writeFileSync(recoveryPath, recoveryContent, { mode: 0o600 });
    fs.writeFileSync(statePath, stateContent, { mode: 0o600 });
    fs.writeFileSync(timerPath, '{"pid":9999}', { mode: 0o600 });
    const rmSync = vi.fn((...args: Parameters<typeof fs.rmSync>) => {
      const [artifactPath] = args;
      switch (path.basename(String(artifactPath))) {
        case "shields-alpha.json": {
          const error = new Error("permission denied") as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        }
        default:
          fs.rmSync(...args);
      }
    });

    try {
      expect(() =>
        cleanupShieldsDestroyArtifacts("alpha", {
          stateDir,
          rmSync: rmSync as unknown as typeof fs.rmSync,
          killShieldsTimer: () => ({ authorityRevoked: true, warnings: [] }),
        }),
      ).toThrow(
        `Could not remove Shields state record '${statePath}': permission denied. Shields cleanup artifacts were restored or retained for retry.`,
      );

      expect(fs.readFileSync(recoveryPath, "utf8")).toBe(recoveryContent);
      expect(fs.readFileSync(statePath, "utf8")).toBe(stateContent);
      expect(fs.existsSync(timerPath)).toBe(true);
      expect(
        rmSync.mock.calls.map(([artifactPath]) => path.basename(String(artifactPath))),
      ).toEqual(["shields-external-policy-alpha.yaml", "shields-alpha.json"]);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("destroy preserves Shields state when external recovery cleanup fails (#9833)", () => {
    const warnings: string[] = [];
    const rmSync = vi.fn((artifactPath: string) => {
      switch (path.basename(artifactPath)) {
        case "shields-external-policy-alpha.yaml": {
          const error = new Error("permission denied") as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        }
      }
    });

    expect(() =>
      cleanupShieldsDestroyArtifacts("alpha", {
        stateDir: "/tmp/nonexistent-state-dir",
        rmSync: rmSync as unknown as typeof fs.rmSync,
        killShieldsTimer: () => ({
          authorityRevoked: true,
          warnings: ["Failed to terminate Shields timer PID 4242"],
        }),
        warn: (message) => warnings.push(message),
      }),
    ).toThrow(
      "Could not remove external Shields policy recovery artifact '/tmp/nonexistent-state-dir/shields-external-policy-alpha.yaml': permission denied. Shields state was preserved for retry.",
    );

    expect(warnings).toEqual(["Failed to terminate Shields timer PID 4242"]);
    expect(rmSync).toHaveBeenCalledOnce();
    expect(rmSync.mock.calls[0][0]).toContain("shields-external-policy-alpha.yaml");
  });

  it("state-dir helper resolves ~/.nemoclaw/state from a single shared helper", () => {
    const resolved = resolveNemoclawStateDir("/tmp/example-home");
    expect(resolved).toBe(path.join("/tmp/example-home", ".nemoclaw", "state"));
  });
});

describe("shields state cleanup on destroy (#3114)", () => {
  it("removes Shields state, timer, and external recovery files for the sandbox", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-shields-cleanup-"));
    try {
      const shieldsFile = path.join(tmpDir, "shields-alpha.json");
      const timerFile = path.join(tmpDir, "shields-timer-alpha.json");
      const recoveryFile = path.join(tmpDir, "shields-external-policy-alpha.yaml");
      fs.writeFileSync(shieldsFile, JSON.stringify({ shieldsDown: false }));
      fs.writeFileSync(timerFile, JSON.stringify({ pid: 12345 }));
      fs.writeFileSync(recoveryFile, "version: 1\nnetwork_policies: {}\n");

      cleanupShieldsDestroyArtifacts("alpha", {
        stateDir: tmpDir,
        killShieldsTimer: () => ({ authorityRevoked: true, warnings: [] }),
      });

      expect(fs.existsSync(shieldsFile)).toBe(false);
      expect(fs.existsSync(timerFile)).toBe(false);
      expect(fs.existsSync(recoveryFile)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("tolerates missing Shields artifacts after revoking timer authority", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-shields-cleanup-"));
    try {
      const killShieldsTimer = vi.fn(() => ({ authorityRevoked: true, warnings: [] }));

      expect(() =>
        cleanupShieldsDestroyArtifacts("nonexistent", {
          stateDir: tmpDir,
          killShieldsTimer,
        }),
      ).not.toThrow();

      expect(killShieldsTimer).toHaveBeenCalledWith("nonexistent");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not remove state files for other sandboxes", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-shields-cleanup-"));
    try {
      const otherFile = path.join(tmpDir, "shields-bravo.json");
      const otherRecoveryFile = path.join(tmpDir, "shields-external-policy-bravo.yaml");
      fs.writeFileSync(otherFile, JSON.stringify({ shieldsDown: false }));
      fs.writeFileSync(otherRecoveryFile, "version: 1\nnetwork_policies: {}\n");

      cleanupShieldsDestroyArtifacts("alpha", {
        stateDir: tmpDir,
        killShieldsTimer: () => ({ authorityRevoked: true, warnings: [] }),
      });

      expect(fs.existsSync(otherFile)).toBe(true);
      expect(fs.existsSync(otherRecoveryFile)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects path traversal in sandbox name", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-shields-cleanup-"));
    const escapedFile = path.join(tmpDir, "..", "shields-traversal.json");
    const killShieldsTimer = vi.fn(() => ({ authorityRevoked: true, warnings: [] }));
    const rmSync = vi.fn();
    try {
      fs.writeFileSync(escapedFile, "should survive");

      // A name containing ../ should not delete files outside stateDir
      cleanupShieldsDestroyArtifacts("../../../../shields-traversal", {
        stateDir: tmpDir,
        killShieldsTimer,
        rmSync: rmSync as unknown as typeof fs.rmSync,
      });

      expect(killShieldsTimer).toHaveBeenCalledWith("../../../../shields-traversal");
      expect(rmSync).not.toHaveBeenCalled();
      expect(fs.existsSync(escapedFile)).toBe(true);
    } finally {
      fs.rmSync(escapedFile, { force: true });
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
