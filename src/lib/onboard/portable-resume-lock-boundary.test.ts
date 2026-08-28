// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { testTimeoutOptions } from "../../../test/helpers/timeouts";

const originalEnv = { ...process.env };
const STOP_AFTER_PREPARATION = "stop after observed portable preparation";
let tempHome: string;
let configWriteMarker: string;
let socketActivationMarker: string;
let preparationObservedLock = false;
let preparationObservedHostFence = false;
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
  for (const directory of [".nemoclaw", ".nemoclaw/gateways/19093"]) {
    fs.mkdirSync(path.join(tempHome, directory), { mode: 0o700, recursive: true });
    fs.chmodSync(path.join(tempHome, directory), 0o700);
  }
  configWriteMarker = path.join(tempHome, "portable-config-written");
  socketActivationMarker = path.join(tempHome, "podman-socket-activated");
  fs.rmSync(configWriteMarker, { force: true });
  fs.rmSync(socketActivationMarker, { force: true });
  preparationObservedLock = false;
  preparationObservedHostFence = false;
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
  const retirement = await import("../state/portable-uninstall-retirement");
  return {
    command,
    onboardModule,
    session,
    checkpointMigration,
    resumeIntent,
    retirement,
  };
}
function replacementReentryState(profile: "default" | "portable", phase: string) {
  const { checkpointMigration, retirement, session } = boundaryModules;
  const stateDir = path.join(tempHome, ".nemoclaw");
  const sessionFile = session.SESSION_FILE;
  const registryFile = path.join(stateDir, "sandboxes.json");
  const receiptDir = path.join(stateDir, "portable-demo-lifecycle");
  const receiptName = `${"a".repeat(64)}.json`;
  const configDir = path.join(tempHome, ".config/nemoclaw/portable");
  const configFile = path.join(configDir, "containers.conf");
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(configDir, { recursive: true, force: true });
  fs.mkdirSync(receiptDir, { mode: 0o700, recursive: true });
  fs.mkdirSync(configDir, { mode: 0o700, recursive: true });
  fs.writeFileSync(path.join(receiptDir, receiptName), "{}\n", { mode: 0o600 });
  fs.writeFileSync(registryFile, '{"sandboxes":{"alpha":{"name":"alpha"}}}\n', {
    mode: 0o600,
  });
  fs.writeFileSync(configFile, "[engine]\n", { mode: 0o600 });
  retirement.publishAndRetirePortableEvidence(
    retirement.preparePortableRetirement(tempHome, [receiptName]),
  );
  const stored = session.createSession({
    agent: "openclaw",
    sandboxName: "later-sandbox",
    sessionId: `replacement-${profile}-${phase}`,
  });
  stored.status = phase === "pre-complete" ? "failed" : "in_progress";
  stored.resumable = true;
  const uid = process.getuid?.() ?? 1001;
  stored.checkpoint = checkpointMigration.deriveCheckpointFromSession(stored, {
    profile,
    runtimeAuthority:
      profile === "portable"
        ? {
            schemaVersion: 1,
            kind: "podman",
            ownership: "current-user",
            uid,
            homeDir: tempHome,
            configHome: path.join(tempHome, ".config"),
            runtimeDir: `/run/user/${String(uid)}`,
            socketPath: `/run/user/${String(uid)}/podman/podman.sock`,
          }
        : null,
  });
  fs.mkdirSync(path.dirname(sessionFile), { mode: 0o700, recursive: true });
  fs.writeFileSync(sessionFile, `${JSON.stringify(stored)}\n`, { mode: 0o600 });
  profile === "portable" &&
    (() => {
      fs.mkdirSync(configDir, { mode: 0o700, recursive: true });
      fs.writeFileSync(configFile, "[engine]\nreplacement=true\n", { mode: 0o600 });
      phase !== "config" &&
        (() => {
          fs.mkdirSync(receiptDir, { mode: 0o700, recursive: true });
          fs.writeFileSync(path.join(receiptDir, receiptName), "{}\n", { mode: 0o600 });
        })();
    })();
  (phase === "registry" || phase === "pre-complete") &&
    fs.writeFileSync(registryFile, "{}\n", { mode: 0o600 });
  const record = path.join(stateDir, "portable-uninstall-retirement.json");
  return {
    record,
    recordBytes: fs.readFileSync(record),
    sessionFile,
    sessionBytes: fs.readFileSync(sessionFile),
  };
}
function runWithObservedPreparation(
  onboardModule: { onboard(options?: import("./types").OnboardOptions): Promise<void> },
  options: import("./command").OnboardCommandOptions,
): Promise<void> {
  return onboardModule.onboard({
    ...options,
    preparePortableHost: () => {
      preparationObservedLock = fs.existsSync(activeLockFile);
      preparationObservedHostFence = fs.existsSync(
        boundaryModules.retirement.portableHostFencePath(tempHome),
      );
      return preparePortableHost();
    },
  });
}

describe("portable resume command lock boundary", () => {
  it(
    "rejects a losing CLI before portable config writes or socket activation (#9035)",
    testTimeoutOptions(30_000),
    async () => {
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
        ).rejects.toThrow(
          "Cannot update onboarding recovery while another onboarding run owns the lock.",
        );
        expect(preparePortableHost).not.toHaveBeenCalled();
        expect(fs.existsSync(configWriteMarker)).toBe(false);
        expect(fs.existsSync(socketActivationMarker)).toBe(false);
      } finally {
        const exited = once(child, "exit");
        child.kill();
        await exited;
        fs.rmSync(session.LOCK_FILE, { force: true });
      }
    },
  );

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
    expect(fs.readFileSync(session.SESSION_FILE, "utf8")).toBe(resolvedRaw.at(-1));
    expect(resolutions).toBe(2);
    expect(afterFailure.snapshot?.fingerprint).toBe(resolvedFingerprints.at(-1));
    expect(failure).toMatchObject({ message: STOP_AFTER_PREPARATION });

    expect(preparePortableHost).toHaveBeenCalledTimes(1);
    expect(preparationObservedLock).toBe(true);
    expect(preparationObservedHostFence).toBe(true);
    expect(fs.readFileSync(configWriteMarker, "utf8")).toBe("prepared");
    expect(fs.readFileSync(socketActivationMarker, "utf8")).toBe("activated");
    expect(fs.existsSync(session.LOCK_FILE)).toBe(false);
  });

  it("holds one async-owner fence across await and exact nested reentry (#9189)", async () => {
    const { portableHostFencePath, withPortableHostFence } = boundaryModules.retirement;
    const exitListeners = process.listenerCount("exit");
    const events: string[] = [];
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => (firstStarted = resolve));
    const blocked = new Promise<void>((resolve) => (releaseFirst = resolve));
    const first = withPortableHostFence(tempHome, async () => {
      events.push("first:start");
      const outer = fs.lstatSync(portableHostFencePath(tempHome), { bigint: true }).ino;
      firstStarted();
      await withPortableHostFence(tempHome, async () => {
        await Promise.resolve();
        expect(fs.lstatSync(portableHostFencePath(tempHome), { bigint: true }).ino).toBe(outer);
        events.push("nested");
      });
      await blocked;
      events.push("first:end");
    });
    await started;
    const second = withPortableHostFence(tempHome, () => events.push("second"));
    await Promise.resolve();
    expect(events).toEqual(["first:start", "nested"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "nested", "first:end", "second"]);
    expect(fs.existsSync(portableHostFencePath(tempHome))).toBe(false);
    expect(process.listenerCount("exit")).toBe(exitListeners);
  });

  it("drains an admitted detached reentry before releasing the physical fence (#9189)", async () => {
    const { portableHostFencePath, withPortableHostFence } = boundaryModules.retirement;
    const events: string[] = [];
    let nestedStarted!: () => void;
    let releaseNested!: () => void;
    const started = new Promise<void>((resolve) => (nestedStarted = resolve));
    const blocked = new Promise<void>((resolve) => (releaseNested = resolve));
    let detached!: Promise<void>;
    const first = withPortableHostFence(tempHome, async () => {
      const generation = fs.lstatSync(portableHostFencePath(tempHome), { bigint: true }).ino;
      detached = withPortableHostFence(tempHome, async () => {
        events.push("nested:start");
        nestedStarted();
        await blocked;
        expect(fs.lstatSync(portableHostFencePath(tempHome), { bigint: true }).ino).toBe(
          generation,
        );
        events.push("nested:end");
      });
      await started;
      events.push("outer:return");
    }).then(() => events.push("outer:resolved"));
    await started;
    const second = withPortableHostFence(tempHome, () => events.push("second"));
    await Promise.resolve();
    expect(events).toEqual(["nested:start", "outer:return"]);
    expect(fs.existsSync(portableHostFencePath(tempHome))).toBe(true);
    releaseNested();
    await Promise.all([detached, first, second]);
    expect(events).toEqual([
      "nested:start",
      "outer:return",
      "nested:end",
      "outer:resolved",
      "second",
    ]);
    expect(fs.existsSync(portableHostFencePath(tempHome))).toBe(false);
  });

  it("rejects a detached async owner and releases after nested throws (#9189)", async () => {
    const { portableHostFencePath, withPortableHostFence } = boundaryModules.retirement;
    const exitListeners = process.listenerCount("exit");
    let trigger!: () => void;
    let detached!: Promise<void>;
    await expect(
      withPortableHostFence(tempHome, async () => {
        const gate = new Promise<void>((resolve) => (trigger = resolve));
        detached = gate.then(() => withPortableHostFence(tempHome, () => undefined));
        await withPortableHostFence(tempHome, () => {
          throw new Error("nested failure");
        });
      }),
    ).rejects.toThrow("nested failure");
    trigger();
    await expect(detached).rejects.toThrow(/inactive/);
    await expect(withPortableHostFence(tempHome, () => "released")).resolves.toBe("released");
    expect(fs.existsSync(portableHostFencePath(tempHome))).toBe(false);
    expect(process.listenerCount("exit")).toBe(exitListeners);
  });

  it("balances the physical fence when the owning process exits (#9189)", () => {
    const { portableHostFencePath } = boundaryModules.retirement;
    const moduleUrl = new URL("../state/portable-uninstall-retirement.ts", import.meta.url).href;
    const script = String.raw`
      const retirement = (await import(process.argv[2])).default;
      await retirement.withPortableHostFence(process.argv[1], async () => process.exit(0));
    `;
    const result = spawnSync(
      process.execPath,
      [
        "--no-warnings",
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        script,
        tempHome,
        moduleUrl,
      ],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(portableHostFencePath(tempHome))).toBe(false);
  });

  it("keeps the host fence through the real onboarding preparation boundary (#9189)", async () => {
    const { portableHostFencePath } = boundaryModules.retirement;
    const { command, onboardModule } = boundaryModules;
    fs.rmSync(path.join(tempHome, ".nemoclaw"), { recursive: true, force: true });
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
    ).rejects.toThrow(STOP_AFTER_PREPARATION);
    expect(preparationObservedLock).toBe(true);
    expect(preparationObservedHostFence).toBe(true);
    expect(fs.existsSync(portableHostFencePath(tempHome))).toBe(false);
  });

  it.each(
    (
      [
        ["--resume", { resume: true }, true, "portable"],
        [
          "--fresh default",
          { fresh: true, "non-interactive": true, "yes-i-accept-third-party-software": true },
          false,
          "default",
        ],
        [
          "--fresh portable",
          {
            fresh: true,
            "experimental-profile": "portable",
            "yes-i-accept-third-party-software": true,
          },
          false,
          "portable",
        ],
      ] as const
    ).flatMap(([name, flags, resume, profile]) =>
      (["config", "receipt", "registry", "pre-complete"] as const).map(
        (phase) => [`${name} after ${phase}`, flags, resume, profile, phase] as const,
      ),
    ),
  )(
    "admits %s replacement publication before session mutation (#9189)",
    async (_case, flags, resume, profile, phase) => {
      const { command, onboardModule, resumeIntent } = boundaryModules;
      const state = replacementReentryState(profile, phase);
      const expected = {
        experimentalProfile: profile === "portable" ? "portable" : null,
        fresh: !resume,
        resume,
      };
      const prepare = vi
        .spyOn(onboardModule.onboardSession, "loadSession")
        .mockImplementation(() => {
          throw new Error(STOP_AFTER_PREPARATION);
        });
      const exitListeners = process.listenerCount("exit");
      await expect(
        command.runOnboardCommand({
          flags,
          env: process.env,
          loadPortableInferenceDescriptor: async () => null,
          resolveResumeIntent: (intent) =>
            resumeIntent.resolveOnboardResumeIntent({ ...intent, sessionFile: state.sessionFile }),
          runOnboard: (options) => {
            expect(options).toMatchObject(expected);
            return onboardModule.onboard(options);
          },
        }),
      ).rejects.toThrow(STOP_AFTER_PREPARATION);
      expect(process.listenerCount("exit")).toBe(exitListeners);
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(fs.readFileSync(state.record)).toEqual(state.recordBytes);
      expect(fs.readFileSync(state.sessionFile)).toEqual(state.sessionBytes);
      expect(preparePortableHost).not.toHaveBeenCalled();
    },
  );

  it("reenters one host-fence generation from the real rebuild into real onboarding (#9189)", async () => {
    fs.rmSync(path.join(tempHome, ".nemoclaw"), { recursive: true, force: true });
    const createdDirectories: string[] = [];
    const originalMkdtemp = fs.mkdtempSync.bind(fs);
    const mkdtemp = vi.spyOn(fs, "mkdtempSync").mockImplementation(((prefix: string) => {
      const directory = originalMkdtemp(prefix);
      createdDirectories.push(directory);
      return directory;
    }) as typeof fs.mkdtempSync);
    const harnessModule = await import("../../../test/helpers/rebuild-flow-generic-harness");
    const { onboardSession: rebuildOnboardSession, rebuildOnboardDependencies } =
      await import("../../../test/helpers/rebuild-flow-harness");
    const actualOnboard = rebuildOnboardDependencies.onboard.bind(rebuildOnboardDependencies) as (
      options: import("./types").OnboardOptions,
    ) => Promise<void>;
    const { retirement } = boundaryModules;
    let innerObserved = false;
    let innerError = "";
    const harness = harnessModule.createRebuildFlowHarness({
      onboard: async (_session, options) => {
        const lockPath = retirement.portableHostFencePath(tempHome);
        const outerInode = fs.lstatSync(lockPath, { bigint: true }).ino;
        const stateDir = path.join(tempHome, ".nemoclaw");
        fs.mkdirSync(stateDir, { mode: 0o700, recursive: true });
        fs.writeFileSync(path.join(stateDir, "portable-uninstall-retirement.json"), "{}", {
          mode: 0o600,
        });
        try {
          await actualOnboard(options);
        } catch (error) {
          innerError = String(error);
          innerObserved = String(error).includes("retirement record");
          expect(fs.lstatSync(lockPath, { bigint: true }).ino).toBe(outerInode);
          throw error;
        }
      },
    });
    vi.mocked(rebuildOnboardSession.acquireOnboardLock).mockRestore();
    vi.mocked(rebuildOnboardSession.releaseOnboardLock).mockRestore();

    try {
      await harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }).catch(() => {});
      expect(innerObserved, innerError).toBe(true);
      expect(fs.existsSync(retirement.portableHostFencePath(tempHome))).toBe(false);
    } finally {
      mkdtemp.mockRestore();
      createdDirectories.reverse().forEach((directory) => {
        fs.rmSync(directory, { recursive: true, force: true });
      });
    }
  }, 30_000);
});
