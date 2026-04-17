// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import path from "node:path";

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
        existsSyncImpl: (candidate) => candidate === path.join("/repo", "uninstall.sh"),
        log: () => {},
        error: () => {},
        exit: ((code: number) => {
          throw new Error(`exit:${code}`);
        }) as never,
      }),
    ).toThrow("exit:0");
    expect(spawnSyncImpl).toHaveBeenCalledWith("bash", [path.join("/repo", "uninstall.sh"), "--yes"], {
      stdio: "inherit",
      cwd: "/repo",
      env: process.env,
    });
  });

  it("does not download or run a remote uninstall script when no local copy exists", () => {
    const spawnSyncImpl = vi.fn(() => ({ status: 0, signal: null }));
    const errors: string[] = [];
    expect(() =>
      runUninstallCommand({
        args: ["--yes"],
        rootDir: "/repo",
        currentDir: "/repo/bin",
        remoteScriptUrl: "https://example.invalid/uninstall.sh",
        env: process.env,
        spawnSyncImpl,
        existsSyncImpl: () => false,
        log: () => {},
        error: (message) => {
          errors.push(message ?? "");
        },
        exit: ((code: number) => {
          throw new Error(`exit:${code}`);
        }) as never,
      }),
    ).toThrow("exit:1");
    expect(spawnSyncImpl).not.toHaveBeenCalled();
    expect(errors.join("\n")).toContain("Remote uninstall fallback is disabled for security.");
    expect(errors.join("\n")).toContain("https://example.invalid/uninstall.sh");
  });
});
