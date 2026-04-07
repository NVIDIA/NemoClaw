// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  buildVersionedUninstallUrl,
  exitWithSpawnResult,
  resolveUninstallScript,
  runUninstallCommand,
} from "../../dist/lib/uninstall-command";

describe("uninstall command", () => {
  it("builds a version-pinned uninstall URL", () => {
    expect(buildVersionedUninstallUrl("0.1.0")).toBe(
      "https://raw.githubusercontent.com/NVIDIA/NemoClaw/refs/tags/v0.1.0/uninstall.sh",
    );
    expect(buildVersionedUninstallUrl("v0.1.0-3-gdeadbee")).toBe(
      "https://raw.githubusercontent.com/NVIDIA/NemoClaw/refs/tags/v0.1.0/uninstall.sh",
    );
  });

  it("selects the first existing uninstall script", () => {
    const script = resolveUninstallScript(["/a", "/b"], (candidate) => candidate === "/b");
    expect(script).toBe("/b");
  });

  it("maps spawn signals to shell-style exit codes", () => {
    expect(() =>
      exitWithSpawnResult(
        { status: null, signal: "SIGTERM" },
        ((code: number) => {
          throw new Error(`exit:${code}`);
        }) as never,
      ),
    ).toThrow("exit:143");
  });

  it("runs the local uninstall script when present", () => {
    const spawnSyncImpl = vi.fn(() => ({ status: 0, signal: null }));
    expect(() =>
      runUninstallCommand({
        args: ["--yes"],
        rootDir: "/repo",
        currentDir: "/repo/bin",
        remoteScriptUrl: "https://example.invalid/uninstall.sh",
        env: process.env,
        spawnSyncImpl,
        execFileSyncImpl: vi.fn(),
        existsSyncImpl: (candidate) => candidate === "/repo/uninstall.sh",
        log: () => {},
        error: () => {},
        exit: ((code: number) => {
          throw new Error(`exit:${code}`);
        }) as never,
      }),
    ).toThrow("exit:0");
    expect(spawnSyncImpl).toHaveBeenCalledWith("bash", ["/repo/uninstall.sh", "--yes"], {
      stdio: "inherit",
      cwd: "/repo",
      env: process.env,
    });
  });

  it("downloads and runs the remote uninstall script when no local copy exists", () => {
    const execFileSyncImpl = vi.fn();
    const spawnSyncImpl = vi.fn(() => ({ status: 0, signal: null }));
    const rmSyncImpl = vi.fn();
    expect(() =>
      runUninstallCommand({
        args: ["--yes"],
        rootDir: "/repo",
        currentDir: "/repo/bin",
        remoteScriptUrl: "https://example.invalid/uninstall.sh",
        env: process.env,
        spawnSyncImpl,
        execFileSyncImpl,
        existsSyncImpl: () => false,
        mkdtempSyncImpl: () => "/tmp/nemoclaw-uninstall-123",
        rmSyncImpl,
        tmpdirFn: () => "/tmp",
        log: () => {},
        error: () => {},
        exit: ((code: number) => {
          throw new Error(`exit:${code}`);
        }) as never,
      }),
    ).toThrow("exit:0");
    expect(execFileSyncImpl).toHaveBeenCalledWith(
      "curl",
      ["-fsSL", "https://example.invalid/uninstall.sh", "-o", "/tmp/nemoclaw-uninstall-123/uninstall.sh"],
      { stdio: "inherit" },
    );
    expect(rmSyncImpl).toHaveBeenCalledWith("/tmp/nemoclaw-uninstall-123", {
      recursive: true,
      force: true,
    });
  });
});
