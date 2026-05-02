// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { HostAssessment } from "./preflight";
import {
  getLatestNemoClawVersion,
  isUpdateAvailable,
  resolveSandboxSyncCommand,
  runDetachedUpdateWorker,
  runUpdateCommand,
  shouldUseSudoForPrefix,
  type DetachedUpdatePayload,
} from "../../dist/lib/update";

function buildHostAssessment(dockerReachable: boolean): HostAssessment {
  return {
    platform: "linux",
    isWsl: false,
    runtime: "docker",
    packageManager: "apt",
    systemctlAvailable: true,
    dockerServiceActive: true,
    dockerServiceEnabled: true,
    dockerInstalled: true,
    dockerRunning: dockerReachable,
    dockerReachable,
    nodeInstalled: true,
    openshellInstalled: true,
    dockerInfoSummary: "Docker 26",
    dockerCgroupVersion: "v2",
    dockerDefaultCgroupnsMode: "host",
    dockerStorageDriver: "overlay2",
    dockerUsesContainerdSnapshotter: false,
    hasNestedOverlayConflict: false,
    requiresHostCgroupnsFix: false,
    isUnsupportedRuntime: false,
    isHeadlessLikely: false,
    hasNvidiaGpu: false,
    notes: [],
  };
}

function normalizePathForAssert(value: string): string {
  return value.replace(/\\/g, "/");
}

describe("update helpers", () => {
  it("isUpdateAvailable returns expected values for older/current/newer versions", () => {
    expect(isUpdateAvailable("0.1.0", "0.1.1")).toBe(true);
    expect(isUpdateAvailable("0.1.0", "0.1.0")).toBe(false);
    expect(isUpdateAvailable("0.2.0", "0.1.9")).toBe(false);
  });

  it("getLatestNemoClawVersion retries transient failures", async () => {
    let attempts = 0;
    const latest = await getLatestNemoClawVersion({
      retries: 2,
      minTimeoutMs: 1,
      captureCommandImpl: () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error("registry timeout");
        }
        return "0.2.0";
      },
    });

    expect(latest).toBe("0.2.0");
    expect(attempts).toBe(3);
  });

  it("shouldUseSudoForPrefix respects writable user-local prefixes", () => {
    expect(
      shouldUseSudoForPrefix("/home/tester/.local", {
        platform: "linux",
        getuidImpl: () => 1000,
        isPrefixWritableImpl: () => true,
      }),
    ).toBe(false);

    expect(
      shouldUseSudoForPrefix("/usr/local", {
        platform: "linux",
        getuidImpl: () => 1000,
        isPrefixWritableImpl: () => false,
      }),
    ).toBe(true);
  });

  it("resolveSandboxSyncCommand prefers prefix-resolved nemoclaw binary", () => {
    const expected = "/usr/local/bin/nemoclaw";
    const command = resolveSandboxSyncCommand("/usr/local", "linux", {
      existsSyncImpl: (candidate) => normalizePathForAssert(candidate) === expected,
    });
    expect(normalizePathForAssert(command)).toBe(expected);
  });
});

describe("runUpdateCommand", () => {
  it("--check mode produces summary only with no detached install", async () => {
    const startDetachedUpdateWorkerImpl = vi.fn(() => 1234);
    const result = await runUpdateCommand(["--check"], {
      getVersionImpl: () => "0.1.0",
      getLatestNemoClawVersionImpl: async () => "0.2.0",
      getNpmGlobalPrefixImpl: () => "/home/tester/.local",
      isPrefixWritableImpl: () => true,
      captureCredentialFileSnapshotImpl: () => ({
        filePath: "/home/tester/.nemoclaw/credentials.json",
        exists: true,
        mode: 0o600,
      }),
      getOpenshellVersionWarningImpl: () => null,
      startDetachedUpdateWorkerImpl,
      assessHostImpl: () => buildHostAssessment(true),
      log: () => {},
      warn: () => {},
    });

    expect(result.checkOnly).toBe(true);
    expect(result.updateAvailable).toBe(true);
    expect(result.detachedWorkerPid).toBe(null);
    expect(startDetachedUpdateWorkerImpl).not.toHaveBeenCalled();
  });

  it("skips sandbox sync when Docker is unreachable even with --auto", async () => {
    const startDetachedUpdateWorkerImpl = vi.fn(() => 5555);
    const warnings: string[] = [];

    await runUpdateCommand(["--auto"], {
      getVersionImpl: () => "0.1.0",
      getLatestNemoClawVersionImpl: async () => "0.2.0",
      getNpmGlobalPrefixImpl: () => "/home/tester/.local",
      isPrefixWritableImpl: () => true,
      captureCredentialFileSnapshotImpl: () => ({
        filePath: "/home/tester/.nemoclaw/credentials.json",
        exists: true,
        mode: 0o600,
      }),
      getOpenshellVersionWarningImpl: () => null,
      startDetachedUpdateWorkerImpl,
      assessHostImpl: () => buildHostAssessment(false),
      log: () => {},
      warn: (message = "") => warnings.push(message),
    });

    expect(startDetachedUpdateWorkerImpl).toHaveBeenCalledTimes(1);
    const firstCall = startDetachedUpdateWorkerImpl.mock.calls.at(0);
    const payload = firstCall?.[0] as DetachedUpdatePayload | undefined;
    expect(payload).toBeDefined();
    if (!payload) {
      throw new Error("Expected detached update payload");
    }
    expect(payload.runSandboxSync).toBe(false);
    expect(warnings.join("\n")).toContain("Docker is not reachable");
  });

  it("emits openshell min-version warning without hard failing update", async () => {
    const warnings: string[] = [];
    const result = await runUpdateCommand(["--check"], {
      getVersionImpl: () => "0.1.0",
      getLatestNemoClawVersionImpl: async () => "0.2.0",
      getNpmGlobalPrefixImpl: () => "/home/tester/.local",
      isPrefixWritableImpl: () => true,
      captureCredentialFileSnapshotImpl: () => ({
        filePath: "/home/tester/.nemoclaw/credentials.json",
        exists: true,
        mode: 0o600,
      }),
      getOpenshellVersionWarningImpl: () =>
        "openshell 0.0.31 is below blueprint min_openshell_version 0.0.32.",
      assessHostImpl: () => buildHostAssessment(true),
      log: () => {},
      warn: (message = "") => warnings.push(message),
    });

    expect(result.openshellWarning).toContain("below blueprint min_openshell_version");
    expect(warnings.join("\n")).toContain("below blueprint min_openshell_version");
  });

  it("uses home-based update log fallback when credentials path is unavailable", async () => {
    const startDetachedUpdateWorkerImpl = vi.fn(() => 7777);

    await runUpdateCommand([], {
      env: { HOME: "/home/tester" },
      platform: "linux",
      getVersionImpl: () => "0.1.0",
      getLatestNemoClawVersionImpl: async () => "0.2.0",
      getNpmGlobalPrefixImpl: () => "/usr/local",
      isPrefixWritableImpl: () => false,
      captureCredentialFileSnapshotImpl: () => ({
        filePath: null,
        exists: false,
        mode: null,
      }),
      getOpenshellVersionWarningImpl: () => null,
      assessHostImpl: () => buildHostAssessment(true),
      startDetachedUpdateWorkerImpl,
      resolveSandboxSyncCommandImpl: () => "/usr/local/bin/nemoclaw",
      log: () => {},
      warn: () => {},
    });

    expect(startDetachedUpdateWorkerImpl).toHaveBeenCalledTimes(1);
    const firstCall = startDetachedUpdateWorkerImpl.mock.calls.at(0);
    const payload = firstCall?.[0] as DetachedUpdatePayload | undefined;
    expect(payload).toBeDefined();
    if (!payload) {
      throw new Error("Expected detached update payload");
    }
    expect(normalizePathForAssert(payload.logFilePath)).toMatch(
      /(?:^|.*\/)(home\/tester\/\.nemoclaw\/update\.log)$/,
    );
    expect(payload.sandboxSyncCommand).toBe("/usr/local/bin/nemoclaw");
  });

  it("fails loudly when detached worker does not start", async () => {
    await expect(
      runUpdateCommand([], {
        env: { HOME: "/home/tester" },
        platform: "linux",
        getVersionImpl: () => "0.1.0",
        getLatestNemoClawVersionImpl: async () => "0.2.0",
        getNpmGlobalPrefixImpl: () => "/usr/local",
        isPrefixWritableImpl: () => false,
        captureCredentialFileSnapshotImpl: () => ({
          filePath: "/home/tester/.nemoclaw/credentials.json",
          exists: true,
          mode: 0o600,
        }),
        getOpenshellVersionWarningImpl: () => null,
        assessHostImpl: () => buildHostAssessment(true),
        startDetachedUpdateWorkerImpl: () => null,
        log: () => {},
        warn: () => {},
      }),
    ).rejects.toThrow("Failed to start detached update worker");
  });
});

describe("runDetachedUpdateWorker", () => {
  it("restores credentials mode to 0600 and records warning if mode changed", () => {
    const chmodSyncImpl = vi.fn();
    const appendFileSyncImpl = vi.fn();

    const result = runDetachedUpdateWorker(
      {
        npmCommand: "npm",
        useSudo: false,
        installArgs: ["install", "-g", "nemoclaw@latest"],
        runSandboxSync: false,
        sandboxSyncCommand: "nemoclaw",
        credentialsFilePath: "/tmp/credentials.json",
        credentialsMode: 0o600,
        logFilePath: "/tmp/update.log",
      },
      {
        spawnSyncImpl: () => ({ status: 0, stdout: "", stderr: "", signal: null } as never),
        existsSyncImpl: () => true,
        statSyncImpl: () => ({ mode: 0o100644 }),
        chmodSyncImpl,
        appendFileSyncImpl,
      },
    );

    expect(result.installStatus).toBe(0);
    expect(chmodSyncImpl).toHaveBeenCalledWith("/tmp/credentials.json", 0o600);
    expect(result.warnings.join("\n")).toContain("Restored to 0600");
    expect(appendFileSyncImpl).toHaveBeenCalled();
  });

  it("uses resolved sandbox command and records sync failure details", () => {
    const spawnSyncImpl = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: "install ok", stderr: "", signal: null })
      .mockReturnValueOnce({ status: 2, stdout: "", stderr: "sync failed", signal: null });

    const result = runDetachedUpdateWorker(
      {
        npmCommand: "npm",
        useSudo: false,
        installArgs: ["install", "-g", "nemoclaw@latest"],
        runSandboxSync: true,
        sandboxSyncCommand: "/usr/local/bin/nemoclaw",
        credentialsFilePath: null,
        credentialsMode: null,
        logFilePath: "/tmp/update.log",
      },
      {
        spawnSyncImpl,
        existsSyncImpl: () => false,
        statSyncImpl: () => ({ mode: 0o100600 }),
        chmodSyncImpl: vi.fn(),
        appendFileSyncImpl: vi.fn(),
      },
    );

    expect(spawnSyncImpl.mock.calls[1]?.[0]).toBe("/usr/local/bin/nemoclaw");
    expect(result.sandboxSyncStatus).toBe(2);
    expect(result.warnings.join("\n")).toContain("Sandbox synchronization failed");
  });

  it("records generic detached install failure warning without misleading sudo-only message", () => {
    const result = runDetachedUpdateWorker(
      {
        npmCommand: "npm",
        useSudo: false,
        installArgs: ["install", "-g", "nemoclaw@latest"],
        runSandboxSync: true,
        sandboxSyncCommand: "nemoclaw",
        credentialsFilePath: null,
        credentialsMode: null,
        logFilePath: "/tmp/update.log",
      },
      {
        spawnSyncImpl: () => ({ status: 1, stdout: "", stderr: "boom", signal: null } as never),
        existsSyncImpl: () => false,
        statSyncImpl: () => ({ mode: 0o100600 }),
        chmodSyncImpl: vi.fn(),
        appendFileSyncImpl: vi.fn(),
      },
    );

    expect(result.installStatus).toBe(1);
    expect(result.sandboxSyncStatus).toBe(null);
    expect(result.warnings.join("\n")).toContain("Detached install failed");
    expect(result.warnings.join("\n")).not.toContain("passwordless sudo failed");
  });

  it("surfaces spawn errors when detached install cannot start", () => {
    const spawnError = Object.assign(new Error("spawn npm ENOENT"), { code: "ENOENT" });

    const result = runDetachedUpdateWorker(
      {
        npmCommand: "npm",
        useSudo: false,
        installArgs: ["install", "-g", "nemoclaw@latest"],
        runSandboxSync: false,
        sandboxSyncCommand: "nemoclaw",
        credentialsFilePath: null,
        credentialsMode: null,
        logFilePath: "/tmp/update.log",
      },
      {
        spawnSyncImpl: () =>
          ({
            status: null,
            stdout: "",
            stderr: "",
            signal: null,
            error: spawnError,
          }) as never,
        existsSyncImpl: () => false,
        statSyncImpl: () => ({ mode: 0o100600 }),
        chmodSyncImpl: vi.fn(),
        appendFileSyncImpl: vi.fn(),
      },
    );

    expect(result.installStatus).toBe(1);
    expect(result.warnings.join("\n")).toContain("ENOENT");
    expect(result.warnings.join("\n")).toContain("spawn npm ENOENT");
  });
});
