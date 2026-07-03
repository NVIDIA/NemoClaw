// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const sessionPath = require.resolve("./onboard-session");
const originalHome = process.env.HOME;
type OnboardSessionModule = typeof import("./onboard-session");
let session: OnboardSessionModule;
let tempHome: string;

function restoreHome(): boolean {
  return originalHome === undefined
    ? Reflect.deleteProperty(process.env, "HOME")
    : Reflect.set(process.env, "HOME", originalHome);
}

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-lock-process-"));
  process.env.HOME = tempHome;
  delete require.cache[sessionPath];
  session = require("./onboard-session");
  session.releaseOnboardLock();
});

afterEach(() => {
  session.releaseOnboardLock();
  delete require.cache[sessionPath];
  fs.rmSync(tempHome, { recursive: true, force: true });
  restoreHome();
});

describe("cross-process onboard lock", () => {
  it("rejects a concurrent CLI process before gateway creation", async () => {
    const childScript = `
      const fs = require("node:fs");
      const path = require("node:path");
      const lockFile = process.argv[1];
      fs.mkdirSync(path.dirname(lockFile), { recursive: true });
      const fd = fs.openSync(lockFile, "wx", 0o600);
      fs.writeSync(fd, JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        command: "separate nemoclaw onboard process",
      }));
      process.stdout.write("locked\\n");
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ["-e", childScript, session.LOCK_FILE], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    await once(child.stdout, "data");

    try {
      const acquired = session.acquireOnboardLock("competing nemoclaw onboard");
      expect(acquired.acquired).toBe(false);
      expect(acquired.holderPid).toBe(child.pid);
      expect(acquired.holderCommand).toBe("separate nemoclaw onboard process");
    } finally {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  });
});
