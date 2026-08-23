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
  it("updates under a caller-owned onboard lock without releasing it", () => {
    session.saveSession(
      session.createSession({
        sessionId: "destroy-session",
        sandboxName: "alpha",
      }),
    );
    expect(session.acquireOnboardLock("nemoclaw destroy").acquired).toBe(true);

    const result = session.compareAndSwapSession(
      (current) => current.sessionId === "destroy-session",
      (current) => {
        current.sandboxName = null;
        return current;
      },
    );

    expect(result).toBe("updated");
    expect(session.loadSession()?.sandboxName).toBeNull();
    expect(fs.existsSync(session.LOCK_FILE)).toBe(true);
  });

  it("reports the holder without acquiring a competing lock", async () => {
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

  it("does not replace a session written by the process that owns the onboard lock", async () => {
    session.saveSession(
      session.createSession({
        sessionId: "destroyed-sandbox-session",
        sandboxName: "alpha",
        endpointUrl: "http://host.openshell.internal:4000/v1",
        routerPid: 4242,
        routerCredentialHash: "old-hash",
      }),
    );
    const childScript = `
      const fs = require("node:fs");
      const path = require("node:path");
      const lockFile = process.argv[1];
      const sessionFile = process.argv[2];
      fs.mkdirSync(path.dirname(lockFile), { recursive: true });
      const fd = fs.openSync(lockFile, "wx", 0o600);
      fs.writeSync(fd, JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        command: "replacement nemoclaw onboard process",
      }));
      const replacement = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
      replacement.sessionId = "replacement-session";
      replacement.sandboxName = "alpha";
      replacement.endpointUrl = "http://host.openshell.internal:4000/v1";
      replacement.routerPid = 6262;
      replacement.routerCredentialHash = "replacement-hash";
      const tempFile = sessionFile + ".replacement";
      fs.writeFileSync(tempFile, JSON.stringify(replacement), { mode: 0o600 });
      fs.renameSync(tempFile, sessionFile);
      process.stdout.write("replacement-written\\n");
      setInterval(() => {}, 1000);
    `;
    const child = spawn(
      process.execPath,
      ["-e", childScript, session.LOCK_FILE, session.SESSION_FILE],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    await once(child.stdout, "data");

    try {
      const result = session.compareAndSwapSession(
        (current) => current.sessionId === "destroyed-sandbox-session",
        (current) => {
          current.routerPid = null;
          current.routerCredentialHash = null;
          return current;
        },
        "nemoclaw destroy Model Router session cleanup",
      );

      expect(result).toBe("busy");
      expect(session.loadSession()).toMatchObject({
        sessionId: "replacement-session",
        sandboxName: "alpha",
        endpointUrl: "http://host.openshell.internal:4000/v1",
        routerPid: 6262,
        routerCredentialHash: "replacement-hash",
      });
    } finally {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  });
});
