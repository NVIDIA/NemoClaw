// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { fork } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PROCESS_TOKEN = "a".repeat(32);

describe("detached Shields timer process", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "shields-timer-process-"));
    vi.stubEnv("HOME", tmpHome);
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it.skipIf(process.platform === "win32")(
    "exits after cooperative marker revocation",
    { timeout: 20_000 },
    async () => {
      const { killTimer } = await import("./timer-control");
      const stateDir = path.join(tmpHome, ".nemoclaw", "state");
      const sandboxName = "cooperative-cancellation";
      const snapshotPath = path.join(stateDir, "snapshot.yaml");
      const restoreAtIso = new Date(Date.now() + 60_000).toISOString();
      const markerPath = path.join(stateDir, `shields-timer-${sandboxName}.json`);
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(snapshotPath, "version: 1\nnetwork_policies:\n  default: {}\n");

      const child = fork(
        path.join(import.meta.dirname, "timer.ts"),
        [
          sandboxName,
          snapshotPath,
          restoreAtIso,
          "/sandbox/.openclaw/openclaw.json",
          "/sandbox/.openclaw",
          PROCESS_TOKEN,
          "0",
          "",
          "",
          "openclaw",
        ],
        {
          env: { ...process.env, HOME: tmpHome },
          execArgv: ["--import", "tsx"],
          stdio: ["ignore", "ignore", "pipe", "ipc"],
        },
      );
      expect(child.pid).toBeTypeOf("number");
      const childPid = child.pid as number;
      let childStderr = "";
      child.stderr?.setEncoding("utf-8");
      child.stderr?.on("data", (chunk: string) => {
        childStderr += chunk;
      });

      try {
        fs.writeFileSync(
          markerPath,
          JSON.stringify({
            pid: childPid,
            sandboxName,
            snapshotPath,
            restoreAt: restoreAtIso,
            processToken: PROCESS_TOKEN,
            agentName: "openclaw",
            configPath: "/sandbox/.openclaw/openclaw.json",
            configDir: "/sandbox/.openclaw",
          }),
          { mode: 0o600 },
        );

        const authorization = once(child, "message", { signal: AbortSignal.timeout(10_000) });
        child.send({ type: "authorize", processToken: PROCESS_TOKEN, acknowledge: true });
        const [message] = await authorization;
        expect(message).toEqual({ type: "authorized", processToken: PROCESS_TOKEN });
        child.disconnect();

        const exit = once(child, "exit", { signal: AbortSignal.timeout(10_000) });
        const cancellation = killTimer(sandboxName);
        expect(cancellation).toMatchObject({
          markerFound: true,
          markerPid: childPid,
          wasAlive: true,
          terminated: false,
          authorityRevoked: true,
        });
        expect([
          [],
          [
            `Unable to verify shields timer PID ${String(childPid)} for sandbox '${sandboxName}'; clearing marker without signaling.`,
          ],
        ]).toContainEqual(cancellation.warnings);
        expect(fs.existsSync(markerPath)).toBe(false);
        const [code, signal] = await exit;
        expect({ code, signal }).toEqual({ code: 0, signal: null });
      } catch (error) {
        throw new Error(`Detached timer process regression failed: ${childStderr}`, {
          cause: error,
        });
      } finally {
        child.kill("SIGKILL");
        await vi.waitFor(
          () => expect(child.exitCode !== null || child.signalCode !== null).toBe(true),
          { timeout: 1_000, interval: 10 },
        );
      }
    },
  );
});
