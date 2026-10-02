// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { testTimeoutOptions } from "../../../test/helpers/timeouts";
import { withMcpLifecycleLock } from "../state/mcp-lifecycle-lock-acquisition";
import { type ProcessControl, readCloudflaredState, showStatus, startAll } from "./services";

describe("showStatus named tunnel diagnostics", () => {
  let pidDir: string;

  beforeEach(() => {
    pidDir = mkdtempSync(join(tmpdir(), "nemoclaw-named-tunnel-status-test-"));
  });

  afterEach(() => {
    rmSync(pidDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("explains how to diagnose a running named tunnel with no logged ingress route", () => {
    writeFileSync(join(pidDir, "cloudflared.pid"), String(process.pid));
    const processControl: ProcessControl = {
      isAlive: () => true,
      commandLine: () => "cloudflared tunnel run",
      signal: vi.fn(),
    };
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    showStatus({ pidDir, dashboardPort: 18_791, processControl });

    const output = logSpy.mock.calls.flat().join("\n");
    expect(output).toContain("cloudflared  (PID");
    expect(output).toContain("dashboard target is unconfirmed for port 18791");
    expect(output).toContain("rerun `nemoclaw tunnel status`");
  });
});

describe("startAll named tunnel validation", () => {
  let tmpDir: string;
  let pidDir: string;
  let originalPath: string | undefined;
  let cleanup: () => void;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nemoclaw-named-tunnel-test-"));
    pidDir = join(tmpDir, "pids");
    originalPath = process.env.PATH;
    cleanup = () => {};
  });

  afterEach(() => {
    cleanup();
    process.env.PATH = originalPath;
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it(
    "stops a new named tunnel when its ingress configuration is not confirmed",
    testTimeoutOptions(25_000),
    async () => {
      const binDir = join(tmpDir, "bin");
      mkdirSync(binDir, { recursive: true });
      const fakeCloudflared = join(binDir, "cloudflared");
      writeFileSync(fakeCloudflared, "#!/usr/bin/env sh\nsleep 20\n");
      chmodSync(fakeCloudflared, 0o700);
      process.env.PATH = `${binDir}:${originalPath ?? ""}`;
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      let alive = true;
      const signal = vi.fn(() => {
        alive = false;
      });
      const processControl: ProcessControl = {
        isAlive: () => alive,
        commandLine: () => "cloudflared tunnel run",
        signal,
      };

      await expect(
        startAll({
          pidDir,
          dashboardPort: 18_791,
          cloudflareTunnelToken: "named-secret",
          processControl,
        }),
      ).rejects.toThrow("did not log its ingress route");

      const tunnelState = readCloudflaredState(pidDir, processControl);
      expect(tunnelState.kind).toBe("stopped");
      expect(signal).toHaveBeenCalledWith(expect.any(Number), "SIGTERM");
      expect(logSpy.mock.calls.flat().join("\n")).not.toContain("dashboard target is unconfirmed");
      expect(() => readFileSync(join(pidDir, "cloudflared.pid"), "utf-8")).toThrow();
    },
  );

  it(
    "does not stop a replacement tunnel while waiting for the lifecycle lock",
    testTimeoutOptions(15_000),
    async () => {
      const binDir = join(tmpDir, "bin");
      mkdirSync(binDir, { recursive: true });
      const fakeCloudflared = join(binDir, "cloudflared");
      writeFileSync(
        fakeCloudflared,
        [
          "#!/usr/bin/env sh",
          "sleep 1",
          `echo 'config="{\\"ingress\\":[{\\"hostname\\":\\"agent.example.com\\", \\"service\\":\\"http://localhost:9999\\"}]}"'`,
          "sleep 20",
        ].join("\n"),
      );
      chmodSync(fakeCloudflared, 0o700);
      process.env.PATH = `${binDir}:${originalPath ?? ""}`;
      vi.spyOn(console, "log").mockImplementation(() => {});
      const pidFile = join(pidDir, "cloudflared.pid");
      const processControl: ProcessControl = {
        isAlive: () => true,
        commandLine: () => "cloudflared tunnel run",
        signal: vi.fn(),
      };
      const startPromise = startAll({
        pidDir,
        dashboardPort: 18_791,
        cloudflareTunnelToken: "named-secret",
        processControl,
      });
      let originalPidContents: string | undefined;
      const pidFileDeadline = Date.now() + 5_000;
      while (originalPidContents === undefined && Date.now() < pidFileDeadline) {
        originalPidContents = await readFile(pidFile, "utf-8").catch(
          (error: NodeJS.ErrnoException) =>
            error.code === "ENOENT" ? undefined : Promise.reject(error),
        );
        await new Promise((resolveWait) => setTimeout(resolveWait, 25));
      }
      expect(originalPidContents).toBeDefined();
      const originalPid = Number(originalPidContents);
      cleanup = () => {
        try {
          process.kill(originalPid, "SIGTERM");
        } catch {
          // The fake tunnel may have exited already.
        }
      };

      const replacementPid = process.pid + 1000;
      const lifecycleLockName = `cloudflared-${createHash("sha256")
        .update(resolve(pidDir))
        .digest("hex")}`;
      let releaseLock!: () => void;
      let lockAcquired!: () => void;
      const lockReleased = new Promise<void>((resolveLock) => {
        releaseLock = resolveLock;
      });
      const lockIsAcquired = new Promise<void>((resolveLock) => {
        lockAcquired = resolveLock;
      });
      const lockPromise = withMcpLifecycleLock(lifecycleLockName, async () => {
        lockAcquired();
        await lockReleased;
      });
      await lockIsAcquired;
      await new Promise((resolveWait) => setTimeout(resolveWait, 1_500));
      const replacementPidFile = join(pidDir, "cloudflared.pid.replacement");
      writeFileSync(replacementPidFile, String(replacementPid), { flag: "wx", mode: 0o600 });
      renameSync(replacementPidFile, pidFile);
      releaseLock();
      await lockPromise;
      await startPromise;

      expect(readFileSync(pidFile, "utf-8")).toBe(String(replacementPid));
      expect(processControl.signal).not.toHaveBeenCalled();
    },
  );
});
