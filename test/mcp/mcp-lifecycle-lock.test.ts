// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  withMcpLifecycleLock,
  withMcpLifecycleLockSync,
} from "../../src/lib/state/mcp-lifecycle-lock-acquisition";
import { getMcpLifecycleLockPath } from "../../src/lib/state/mcp-lifecycle-lock-storage";

function waitForPath(filePath: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      switch (true) {
        case fs.existsSync(filePath):
          resolve();
          return;
        case Date.now() >= deadline:
          reject(new Error(`Timed out waiting for ${filePath}`));
          return;
        default:
          setTimeout(poll, 10);
      }
    };
    poll();
  });
}

describe("sandbox mutation lock integration", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-lock-"));
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("excludes a separate CLI process and releases after it exits", async () => {
    const enteredPath = path.join(stateDir, "child-entered");
    const releasePath = path.join(stateDir, "release-child");
    const modulePath = path.resolve("src/lib/state/mcp-lifecycle-lock-acquisition.ts");
    const script = `
      import fs from "node:fs";
      import lock from ${JSON.stringify(modulePath)};
      const { withMcpLifecycleLock } = lock;
      await withMcpLifecycleLock("alpha", async () => {
        fs.writeFileSync(${JSON.stringify(enteredPath)}, "entered");
        while (!fs.existsSync(${JSON.stringify(releasePath)})) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }, { stateDir: ${JSON.stringify(stateDir)}, pollIntervalMs: 1, timeoutMs: 5000 });
    `;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    try {
      await waitForPath(enteredPath);
      await expect(
        withMcpLifecycleLock("alpha", () => undefined, {
          stateDir,
          pollIntervalMs: 1,
          timeoutMs: 25,
        }),
      ).rejects.toThrow("Timed out waiting for the sandbox mutation lock");
      fs.writeFileSync(releasePath, "release");
      await new Promise<void>((resolve, reject) => {
        child.once("exit", (code) => {
          switch (code) {
            case 0:
              resolve();
              break;
            default:
              reject(new Error(`child exited ${String(code)}: ${Buffer.concat(stderr).toString()}`));
          }
        });
        child.once("error", reject);
      });
      await expect(
        withMcpLifecycleLock("alpha", () => "acquired", {
          stateDir,
          pollIntervalMs: 1,
          timeoutMs: 500,
        }),
      ).resolves.toBe("acquired");
    } finally {
      switch (child.exitCode) {
        case null:
          child.kill("SIGKILL");
      }
    }
  });

  it("keeps synchronous failure cleanup exact to the owned generation", () => {
    const lockPath = getMcpLifecycleLockPath("alpha", stateDir);
    expect(() =>
      withMcpLifecycleLockSync(
        "alpha",
        () => {
          expect(fs.existsSync(lockPath)).toBe(true);
          throw new Error("operation failed");
        },
        { stateDir, pollIntervalMs: 1, timeoutMs: 500 },
      ),
    ).toThrow("operation failed");
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
