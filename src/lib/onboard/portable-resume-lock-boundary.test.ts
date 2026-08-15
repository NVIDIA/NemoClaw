// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };
const STOP_AFTER_PREPARATION = "stop after observed portable preparation";
let tempHome: string;
let configWriteMarker: string;
let socketActivationMarker: string;
let preparationObservedLock = false;
let activeLockFile = "";
let boundaryModules: Awaited<ReturnType<typeof loadBoundaryModules>>;
const preparePortableHost = vi.fn((): never => {
  fs.writeFileSync(configWriteMarker, "prepared", { mode: 0o600 });
  fs.writeFileSync(socketActivationMarker, "activated", { mode: 0o600 });
  throw new Error(STOP_AFTER_PREPARATION);
});

beforeAll(async () => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-lock-boundary-"));
  process.env = {
    ...originalEnv,
    HOME: tempHome,
    NEMOCLAW_GATEWAY_PORT: "19093",
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
  };
  try {
    boundaryModules = await loadBoundaryModules();
  } finally {
    process.env = { ...originalEnv };
  }
}, 30_000);

beforeEach(() => {
  configWriteMarker = path.join(tempHome, "portable-config-written");
  socketActivationMarker = path.join(tempHome, "podman-socket-activated");
  fs.rmSync(configWriteMarker, { force: true });
  fs.rmSync(socketActivationMarker, { force: true });
  preparationObservedLock = false;
  preparePortableHost.mockClear();
  process.env = {
    ...originalEnv,
    HOME: tempHome,
    NEMOCLAW_GATEWAY_PORT: "19093",
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...originalEnv };
});

afterAll(() => {
  fs.rmSync(tempHome, { recursive: true, force: true });
});

async function loadBoundaryModules() {
  const command = await import("./command");
  const session = await import("../state/onboard-session");
  activeLockFile = session.LOCK_FILE;
  const onboardModule = (await import("../onboard")) as {
    onboard(options?: import("./types").OnboardOptions): Promise<void>;
    onboardSession: typeof import("../state/onboard-session");
  };
  const checkpointMigration = await import("../state/onboard-checkpoint-migrate");
  const resumeIntent = await import("./resume/portable-resume-intent");
  return { command, onboardModule, session, checkpointMigration, resumeIntent };
}

function runWithObservedPreparation(
  onboardModule: { onboard(options?: import("./types").OnboardOptions): Promise<void> },
  options: import("./command").OnboardCommandOptions,
): Promise<void> {
  return onboardModule.onboard({
    ...options,
    preparePortableHost: () => {
      preparationObservedLock = fs.existsSync(activeLockFile);
      return preparePortableHost();
    },
  });
}

describe("portable resume command lock boundary", () => {
  it("rejects a losing CLI before portable config writes or socket activation (#9035)", async () => {
    const { command, onboardModule, session } = boundaryModules;
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
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${String(code ?? 0)}`);
    }) as typeof process.exit);

    try {
      await expect(
        command.runOnboardCommand({
          flags: {
            fresh: true,
            "experimental-profile": "portable",
            "yes-i-accept-third-party-software": true,
          },
          env: process.env,
          resolveResumeIntent: () => ({ effectiveResume: false, snapshot: null }),
          runOnboard: (options) => runWithObservedPreparation(onboardModule, options),
        }),
      ).rejects.toThrow("exit:1");
      expect(preparePortableHost).not.toHaveBeenCalled();
      expect(fs.existsSync(configWriteMarker)).toBe(false);
      expect(fs.existsSync(socketActivationMarker)).toBe(false);
    } finally {
      const exited = once(child, "exit");
      child.kill();
      await exited;
      fs.rmSync(session.LOCK_FILE, { force: true });
    }
  }, 15_000);

  it("releases the first lock before one bounded pre-read retry and preparation (#9035)", async () => {
    const { command, onboardModule, session, checkpointMigration, resumeIntent } = boundaryModules;
    expect(onboardModule.onboardSession.SESSION_FILE).toBe(session.SESSION_FILE);
    expect(onboardModule.onboardSession.LOCK_FILE).toBe(session.LOCK_FILE);
    const currentUser = os.userInfo();
    const authority = {
      schemaVersion: 1 as const,
      kind: "podman" as const,
      ownership: "current-user" as const,
      uid: currentUser.uid,
      homeDir: currentUser.homedir,
      configHome: path.join(currentUser.homedir, ".config"),
      runtimeDir: `/run/user/${String(currentUser.uid)}`,
      socketPath: `/run/user/${String(currentUser.uid)}/podman/podman.sock`,
    };
    const stored = session.createSession({ sessionId: "portable-lock-race" });
    stored.status = "failed";
    stored.resumable = true;
    stored.checkpoint = checkpointMigration.deriveCheckpointFromSession(stored, {
      profile: "portable",
      runtimeAuthority: authority,
    });
    session.saveSession(stored);

    let resolutions = 0;
    const resolvedFingerprints: string[] = [];
    const resolvedRaw: string[] = [];
    const afterResolution = [
      () => {
        const changed = JSON.parse(fs.readFileSync(session.SESSION_FILE, "utf8")) as Record<
          string,
          unknown
        >;
        changed.updatedAt = "2026-08-13T21:00:00.000Z";
        fs.writeFileSync(session.SESSION_FILE, JSON.stringify(changed, null, 2));
      },
      () => {},
    ];
    const resolveResumeIntent = (options: {
      explicitResume: boolean;
      fresh: boolean;
      explicitProfile: "default" | "portable" | null;
    }) => {
      const resolved = resumeIntent.resolveOnboardResumeIntent({
        ...options,
        sessionFile: session.SESSION_FILE,
      });
      resolutions += 1;
      resolvedFingerprints.push(resolved.snapshot!.fingerprint);
      afterResolution[resolutions - 1]!();
      resolvedRaw.push(fs.readFileSync(session.SESSION_FILE, "utf8"));
      return resolved;
    };

    const failure = await command
      .runOnboardCommand({
        flags: { resume: true },
        env: process.env,
        resolveResumeIntent,
        loadPortableInferenceDescriptor: async () => null,
        runOnboard: (options) => runWithObservedPreparation(onboardModule, options),
      })
      .then(
        () => null,
        (error: unknown) => error,
      );

    const afterFailure = resumeIntent.resolveOnboardResumeIntent({
      explicitResume: true,
      fresh: false,
      explicitProfile: null,
      sessionFile: session.SESSION_FILE,
    });
    expect(JSON.parse(fs.readFileSync(session.SESSION_FILE, "utf8"))).toEqual(
      JSON.parse(resolvedRaw.at(-1)!),
    );
    expect(afterFailure.snapshot?.fingerprint).toBe(resolvedFingerprints.at(-1));
    expect(failure).toMatchObject({ message: STOP_AFTER_PREPARATION });

    expect(resolutions).toBe(2);
    expect(preparePortableHost).toHaveBeenCalledTimes(1);
    expect(preparationObservedLock).toBe(true);
    expect(fs.readFileSync(configWriteMarker, "utf8")).toBe("prepared");
    expect(fs.readFileSync(socketActivationMarker, "utf8")).toBe("activated");
    expect(fs.existsSync(session.LOCK_FILE)).toBe(false);
  });
});
