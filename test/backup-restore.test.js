// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { sandboxBackup, sandboxRestore, syncSandboxGithubTokenEnv } from "../bin/nemoclaw.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sandbox backup command", () => {
  it("creates a backup with an optional label", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const createBackup = vi.fn().mockReturnValue({
      backupDir: "/tmp/backups/the-crucible/pre-upgrade",
      archivePath: "/tmp/backups/the-crucible/pre-upgrade/sandbox.tar.gz",
      sizeBytes: 2048,
    });

    const result = sandboxBackup("the-crucible", ["--label", "pre-upgrade"], {
      isAvailable: true,
      createBackup,
      exit: null,
    });

    expect(createBackup).toHaveBeenCalledWith("the-crucible", { label: "pre-upgrade" });
    expect(result.backupDir).toContain("pre-upgrade");
    const printed = logSpy.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(printed).toContain("Creating backup for sandbox 'the-crucible'");
    expect(printed).toContain("Backup saved to /tmp/backups/the-crucible/pre-upgrade");
  });

  it("lists existing backups without requiring a live sandbox", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = sandboxBackup("the-crucible", ["--list"], {
      listBackups: vi
        .fn()
        .mockReturnValue([
          { id: "pre-upgrade", createdAt: "2026-03-28T10:20:30Z", sizeBytes: 1024 },
        ]),
      exit: null,
    });

    expect(result).toHaveLength(1);
    const printed = logSpy.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(printed).toContain("Backups for sandbox 'the-crucible'");
    expect(printed).toContain("pre-upgrade");
  });

  it("returns false when backup is requested for a stale sandbox", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.fn();

    const result = sandboxBackup("the-crucible", [], {
      isAvailable: false,
      exit: exitSpy,
      error: console.error,
    });

    expect(result).toBe(false);
    expect(exitSpy).toHaveBeenCalledWith(1);
    const printed = errorSpy.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(printed).toContain("Sandbox 'the-crucible' is stale");
  });
});

describe("sandbox restore command", () => {
  it("recreates a missing sandbox before restoring the backup", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const ensureGateway = vi.fn();
    const createSandbox = vi.fn().mockResolvedValue("the-crucible");
    const configureSandbox = vi.fn().mockResolvedValue();
    const restoreBackup = vi.fn().mockReturnValue({});

    const result = await sandboxRestore("the-crucible", ["pre-upgrade"], {
      isAvailable: false,
      resolveBackup: vi.fn().mockReturnValue({
        id: "pre-upgrade",
        path: "/tmp/backups/the-crucible/pre-upgrade",
        manifest: {
          registry: {
            gpuEnabled: true,
            model: "nvidia/nemotron-3-super-120b-a12b",
            provider: "nvidia-prod",
            policies: ["telegram"],
          },
        },
      }),
      ensureGateway,
      createSandbox,
      configureSandbox,
      restoreBackup,
      exit: null,
    });

    expect(ensureGateway).toHaveBeenCalled();
    expect(createSandbox).toHaveBeenCalledWith(true, null, null, null, "the-crucible");
    expect(restoreBackup).toHaveBeenCalledWith(
      "the-crucible",
      "/tmp/backups/the-crucible/pre-upgrade",
    );
    expect(configureSandbox).toHaveBeenCalledWith(
      "the-crucible",
      {
        registry: {
          gpuEnabled: true,
          model: "nvidia/nemotron-3-super-120b-a12b",
          provider: "nvidia-prod",
          policies: ["telegram"],
        },
      },
      { backupDir: "/tmp/backups/the-crucible/pre-upgrade" },
    );
    expect(result).toEqual({
      sandboxName: "the-crucible",
      backupId: "pre-upgrade",
      recreated: true,
    });
    const printed = logSpy.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(printed).toContain("Recreating sandbox 'the-crucible' from backup 'pre-upgrade'");
    expect(printed).toContain("Restoring backup 'pre-upgrade' into sandbox 'the-crucible'");
  });

  it("cancels restoring into a live sandbox unless explicitly confirmed", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const restoreBackup = vi.fn();

    const result = await sandboxRestore("the-crucible", [], {
      isAvailable: true,
      prompt: vi.fn().mockResolvedValue("nope"),
      resolveBackup: vi.fn().mockReturnValue({
        id: "20260328-102030",
        path: "/tmp/backups/the-crucible/20260328-102030",
        manifest: {},
      }),
      restoreBackup,
      exit: null,
    });

    expect(result).toBe(false);
    expect(restoreBackup).not.toHaveBeenCalled();
    const printed = logSpy.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(printed).toContain("Restore will overwrite files inside sandbox 'the-crucible'");
    expect(printed).toContain("Cancelled.");
  });
});

describe("restore token sync", () => {
  it("writes GitHub token environment when a token is available", () => {
    const runFn = vi.fn().mockReturnValue({ status: 0 });
    const logFn = vi.fn();
    const warnFn = vi.fn();

    const result = syncSandboxGithubTokenEnv("the-crucible", {
      githubToken: "gho_test_token",
      run: runFn,
      log: logFn,
      warn: warnFn,
    });

    expect(result).toBe(true);
    expect(runFn).toHaveBeenCalledTimes(1);
    expect(logFn).toHaveBeenCalledWith("  ✓ Synced GitHub token into sandbox environment");
    expect(warnFn).not.toHaveBeenCalled();
  });

  it("skips sync when no GitHub token is available", () => {
    const runFn = vi.fn();

    const result = syncSandboxGithubTokenEnv("the-crucible", {
      githubToken: "",
      run: runFn,
    });

    expect(result).toBe(false);
    expect(runFn).not.toHaveBeenCalled();
  });
});
