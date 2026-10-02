// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { testTimeoutOptions } from "../../../test/helpers/timeouts";
import { withMcpLifecycleLock } from "../state/mcp-lifecycle-lock-acquisition";
import { type ProcessControl, readCloudflaredState, startAll } from "./services";

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
    "keeps a new named tunnel running when its ingress configuration has not been logged yet",
    testTimeoutOptions(25_000),
    async () => {
      const binDir = join(tmpDir, "bin");
      mkdirSync(binDir, { recursive: true });
      const fakeCloudflared = join(binDir, "cloudflared");
      writeFileSync(fakeCloudflared, "#!/usr/bin/env sh\nsleep 20\n");
      chmodSync(fakeCloudflared, 0o700);
      process.env.PATH = `${binDir}:${originalPath ?? ""}`;
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const signal = vi.fn();
      const processControl: ProcessControl = {
        isAlive: () => true,
        commandLine: () => "cloudflared tunnel run",
        signal,
      };

      await startAll({
        pidDir,
        dashboardPort: 18_791,
        cloudflareTunnelToken: "named-secret",
        processControl,
      });

      const tunnelState = readCloudflaredState(pidDir, processControl);
      expect(tunnelState.kind).toBe("running");
      expect(signal).not.toHaveBeenCalled();
      expect(logSpy.mock.calls.flat().join("\n")).toContain(
        "ingress route has not been logged yet",
      );
      const pid = Number(readFileSync(join(pidDir, "cloudflared.pid"), "utf-8"));
      cleanup = () => {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // The fake tunnel may have exited already.
        }
      };
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
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      const originalPid = Number(readFileSync(pidFile, "utf-8"));
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
      writeFileSync(pidFile, String(replacementPid));
      releaseLock();
      await lockPromise;
      await startPromise;

      expect(readFileSync(pidFile, "utf-8")).toBe(String(replacementPid));
      expect(processControl.signal).not.toHaveBeenCalled();
    },
  );
});
