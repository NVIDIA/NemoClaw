// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  buildVersionedUninstallUrl,
  exitWithSpawnResult,
  resolveUninstallScript,
  runUninstallCommand,
  UNINSTALL_SCRIPT_SHA256,
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

  it("exports a non-empty pinned SHA-256 hash constant", () => {
    expect(UNINSTALL_SCRIPT_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("runs the local uninstall script when present", () => {
    const localScriptPath = path.join("/repo", "uninstall.sh");
    const spawnSyncImpl = vi.fn(() => ({ status: 0, signal: null }));
    expect(() =>
      runUninstallCommand({
        args: ["--yes"],
        rootDir: "/repo",
        currentDir: path.join("/repo", "bin"),
        remoteScriptUrl: "https://example.invalid/uninstall.sh",
        env: process.env,
        spawnSyncImpl,
        execFileSyncImpl: vi.fn(),
        existsSyncImpl: (candidate) => candidate === localScriptPath,
        log: () => {},
        error: () => {},
        exit: ((code: number) => {
          throw new Error(`exit:${code}`);
        }) as never,
      }),
    ).toThrow("exit:0");
    expect(spawnSyncImpl).toHaveBeenCalledWith("bash", [localScriptPath, "--yes"], {
      stdio: "inherit",
      cwd: "/repo",
      env: process.env,
    });
  });

  it("downloads and runs the remote uninstall script when no local copy exists", () => {
    const crypto = require("node:crypto");
    const mockContent = Buffer.from("mock-script-content");
    const realHash = crypto.createHash("sha256").update(mockContent).digest("hex");
    const expectedScriptPath = path.join("/tmp/nemoclaw-uninstall-123", "uninstall.sh");

    const execFileSyncImpl = vi.fn();
    const spawnSyncImpl = vi.fn(() => ({ status: 0, signal: null }));
    const rmSyncImpl = vi.fn();
    expect(() =>
      runUninstallCommand({
        args: ["--yes"],
        rootDir: "/repo",
        currentDir: path.join("/repo", "bin"),
        remoteScriptUrl: "https://example.invalid/uninstall.sh",
        expectedHash: realHash,
        env: process.env,
        spawnSyncImpl,
        execFileSyncImpl,
        existsSyncImpl: () => false,
        mkdtempSyncImpl: () => "/tmp/nemoclaw-uninstall-123",
        rmSyncImpl,
        readFileSyncImpl: () => mockContent,
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
      ["-fsSL", "https://example.invalid/uninstall.sh", "-o", expectedScriptPath],
      { stdio: "inherit" },
    );
    expect(spawnSyncImpl).toHaveBeenCalledWith(
      "bash",
      [expectedScriptPath, "--yes"],
      expect.objectContaining({ stdio: "inherit", cwd: "/repo" }),
    );
    expect(rmSyncImpl).toHaveBeenCalledWith("/tmp/nemoclaw-uninstall-123", {
      recursive: true,
      force: true,
    });
  });

  it("refuses to execute remote script when checksum does not match", () => {
    const execFileSyncImpl = vi.fn();
    const spawnSyncImpl = vi.fn(() => ({ status: 0, signal: null }));
    const rmSyncImpl = vi.fn();
    const errors: string[] = [];

    expect(() =>
      runUninstallCommand({
        args: ["--yes"],
        rootDir: "/repo",
        currentDir: path.join("/repo", "bin"),
        remoteScriptUrl: "https://example.invalid/uninstall.sh",
        expectedHash: "0000000000000000000000000000000000000000000000000000000000000000",
        env: process.env,
        spawnSyncImpl,
        execFileSyncImpl,
        existsSyncImpl: () => false,
        mkdtempSyncImpl: () => "/tmp/nemoclaw-uninstall-456",
        rmSyncImpl,
        readFileSyncImpl: () => Buffer.from("tampered-script-content"),
        tmpdirFn: () => "/tmp",
        log: () => {},
        error: (msg?: string) => {
          if (msg) errors.push(msg);
        },
        exit: ((code: number) => {
          throw new Error(`exit:${code}`);
        }) as never,
      }),
    ).toThrow("exit:1");

    // The remote script must NOT have been executed
    expect(spawnSyncImpl).not.toHaveBeenCalled();

    // Error output should contain both expected and actual hashes
    const errorOutput = errors.join("\n");
    expect(errorOutput).toContain("Integrity check failed");
    expect(errorOutput).toContain("0000000000000000000000000000000000000000000000000000000000000000");
    expect(errorOutput).toContain("Refusing to execute");

    // Temp directory should still be cleaned up
    expect(rmSyncImpl).toHaveBeenCalled();
  });
});
