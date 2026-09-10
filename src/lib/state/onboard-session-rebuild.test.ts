// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { CheckpointSandboxRecreatePhase } from "./onboard-checkpoint-types";

let session: typeof import("./onboard-session");
let transactions: typeof import("../onboard/sandbox-recreate-transaction");
let guards: typeof import("../actions/sandbox/rebuild-preflight-guards");
let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-rebuild-session-")));
  vi.stubEnv("HOME", tmpDir);
  vi.resetModules();
  session = await import("./onboard-session");
  transactions = await import("../onboard/sandbox-recreate-transaction");
  guards = await import("../actions/sandbox/rebuild-preflight-guards");
}, 30_000);

beforeEach(() => {
  vi.stubEnv("HOME", tmpDir);
  session.saveSession(session.createSession({ sandboxName: "alpha", agent: "openclaw" }));
});

afterEach(() => {
  session.releaseOnboardLock();
  fs.rmSync(session.SESSION_DIR, { recursive: true, force: true });
});

afterAll(() => {
  vi.resetModules();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function withRebuildLock<T>(name: string, run: () => T): T {
  const release = guards.acquireRebuildOnboardLock(name, (message): never => {
    throw new Error(message);
  });
  expect(release).not.toBeNull();
  try {
    return run();
  } finally {
    process.removeListener("exit", release!);
    release!();
  }
}

function begin(name: string, phase: CheckpointSandboxRecreatePhase = "planned") {
  return session.updateSession((current) => {
    const transaction = transactions.beginSandboxRecreateTransaction(current, {
      sandboxName: name,
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      sourceEntry: { name, agent: "openclaw" },
      observation: {
        state: "ready",
        liveIdentityFingerprint: transactions.fingerprintSandboxRecreateValue(`${name}-source`),
      },
      targetIntentFingerprint: transactions.fingerprintSandboxRecreateValue(`${name}-target`),
    });
    current.checkpoint = {
      ...current.checkpoint!,
      sandboxIdentity: { kind: "selected", value: { name, agent: "openclaw" } },
      gatewayAuthority: {
        kind: "selected",
        value: {
          gatewayName: "nemoclaw",
          gatewayPort: 8080,
          mode: "nemoclaw-managed",
          source: "standalone",
          endpoint: null,
          stateDir: null,
          supervisor: null,
          requiredCapabilities: [],
        },
      },
      sandboxRecreate: { ...transaction, phase },
    };
  });
}

describe("rebuild session selection", () => {
  it.each<CheckpointSandboxRecreatePhase>([
    "planned",
    "deleting",
    "deleted",
    "creating",
    "created",
    "registry_committing",
    "completed",
  ])("rebuilds another sandbox while preserving a transaction at %s (#11379)", (phase) => {
    const alpha = withRebuildLock("alpha", () => begin("alpha", phase));
    expect(alpha.checkpoint?.sandboxRecreate?.phase).toBe(phase);

    const beta = withRebuildLock("beta", () => begin("beta"));

    expect(beta.checkpoint?.sandboxRecreate?.sandboxName).toBe("beta");
    expect(beta.sessionId).not.toBe(alpha.sessionId);
    expect(session.loadRebuildSession("alpha")).toEqual(alpha);
    expect(session.loadSession()).toEqual(beta);
    withRebuildLock("alpha", () => {
      expect(session.loadSession()).toEqual(alpha);
    });
    withRebuildLock("beta", () => {
      expect(session.loadSession()).toEqual(beta);
    });
  });

  it("does not restore a completed transaction after switching away and back", () => {
    withRebuildLock("alpha", () => begin("alpha"));
    const beta = withRebuildLock("beta", () => begin("beta", "completed"));
    withRebuildLock("beta", () => {
      session.updateSession((current) => {
        transactions.clearCompletedSandboxRecreateTransaction(
          current,
          beta.checkpoint!.sandboxRecreate!.id,
        );
      });
      session.completeSession({}, { emitEvents: false });
    });

    withRebuildLock("alpha", () =>
      expect(session.loadSession()?.checkpoint?.sandboxRecreate?.sandboxName).toBe("alpha"),
    );
    const next = withRebuildLock("beta", () => begin("beta"));

    expect(next.checkpoint?.sandboxRecreate?.id).not.toBe(beta.checkpoint?.sandboxRecreate?.id);
  });

  it.each(["beta", "alpha", null])(
    "preserves unfinished onboarding for %j when selecting retained recovery",
    (sandboxName) => {
      const alpha = withRebuildLock("alpha", () => begin("alpha"));
      withRebuildLock("beta", () => undefined);
      const onboarding = session.saveSession(
        session.createSession({ sandboxName, resumable: true }),
      );

      expect(() => withRebuildLock("alpha", () => undefined)).toThrow(/onboarding.*unfinished/);

      expect(session.loadSession()).toEqual(onboarding);
      expect(session.loadRebuildSession("alpha")).toEqual(alpha);
      expect(session.isOnboardLockHeldByCurrentProcess()).toBe(false);
    },
  );

  it("resumes retained recovery after another rebuild stops before recording a transaction", () => {
    const alpha = withRebuildLock("alpha", () => begin("alpha"));
    withRebuildLock("beta", () => expect(session.loadSession()?.resumable).toBe(false));

    withRebuildLock("alpha", () => expect(session.loadSession()).toEqual(alpha));
  });

  it("still rejects a changed target for the same sandbox", () => {
    const alpha = withRebuildLock("alpha", () => begin("alpha"));
    withRebuildLock("beta", () => begin("beta"));

    withRebuildLock("alpha", () => {
      const current = session.loadSession()!;
      expect(() =>
        transactions.beginSandboxRecreateTransaction(current, {
          ...current.checkpoint!.sandboxRecreate!,
          sourceEntry: null,
          observation: { state: "missing", liveIdentityFingerprint: null },
          targetIntentFingerprint: transactions.fingerprintSandboxRecreateValue("changed-target"),
        }),
      ).toThrow(/different recreate transaction in progress/);
      expect(session.loadSession()).toEqual(alpha);
    });
  });

  it("recovers both sessions after an interrupted switch and releases the lock", () => {
    const alpha = withRebuildLock("alpha", () => begin("alpha"));
    const beta = withRebuildLock("beta", () => begin("beta"));
    const rename = fs.renameSync;
    const failure = vi
      .spyOn(fs, "renameSync")
      .mockImplementationOnce(rename)
      .mockImplementationOnce(() => {
        throw new Error("injected session activation failure");
      });

    expect(() => withRebuildLock("alpha", () => undefined)).toThrow(
      /injected session activation failure/,
    );
    expect(session.isOnboardLockHeldByCurrentProcess()).toBe(false);
    failure.mockRestore();

    withRebuildLock("alpha", () => expect(session.loadSession()).toEqual(alpha));
    withRebuildLock("beta", () => expect(session.loadSession()).toEqual(beta));
  });

  it.each(["../escape", "", "a".repeat(64)])(
    "rejects an invalid sandbox name %j before moving recovery",
    (name) => {
      const alpha = withRebuildLock("alpha", () => begin("alpha"));

      expect(() => withRebuildLock(name, () => undefined)).toThrow(/invalid sandbox name/);

      expect(session.isOnboardLockHeldByCurrentProcess()).toBe(false);
      expect(session.loadSession()).toEqual(alpha);
    },
  );

  it("rejects a retained session belonging to another sandbox without changing either session", () => {
    const alpha = withRebuildLock("alpha", () => begin("alpha"));
    const beta = withRebuildLock("beta", () => begin("beta"));
    const retained = path.join(session.SESSION_DIR, ".onboard-rebuild-alpha.json");
    fs.writeFileSync(retained, JSON.stringify(beta));

    expect(() => withRebuildLock("alpha", () => undefined)).toThrow(
      /does not identify sandbox 'alpha'/,
    );

    expect(session.loadSession()).toEqual(beta);
    expect(JSON.parse(fs.readFileSync(retained, "utf8"))).toEqual(beta);
    expect(alpha.sessionId).not.toBe(beta.sessionId);
  });

  it("preserves private file permissions when retaining and restoring a session", () => {
    withRebuildLock("alpha", () => begin("alpha"));
    withRebuildLock("beta", () => begin("beta"));
    const retained = path.join(session.SESSION_DIR, ".onboard-rebuild-alpha.json");
    expect(fs.statSync(retained).mode & 0o777).toBe(0o600);

    withRebuildLock("alpha", () => undefined);

    expect(fs.existsSync(retained)).toBe(false);
    expect(fs.statSync(session.SESSION_FILE).mode & 0o777).toBe(0o600);
  });

  it("requires the onboarding lock before switching sessions", () => {
    const alpha = withRebuildLock("alpha", () => begin("alpha"));

    expect(() => session.selectRebuildSession("beta")).toThrow(/lock/i);

    expect(session.loadSession()).toEqual(alpha);
  });

  it.skipIf(process.platform === "win32")(
    "rejects a FIFO recovery file without blocking",
    () => {
      withRebuildLock("alpha", () => begin("alpha"));
      const beta = withRebuildLock("beta", () => begin("beta"));
      const retained = path.join(session.SESSION_DIR, ".onboard-rebuild-alpha.json");
      fs.unlinkSync(retained);
      const fifo = spawnSync("mkfifo", ["-m", "600", retained], {
        encoding: "utf8",
        timeout: 1000,
      });
      expect(fifo.status, fifo.stderr).toBe(0);

      // A separate process makes a blocking-open regression fail within a bounded time.
      const probe = spawnSync(
        process.execPath,
        [
          "--require",
          "tsx/cjs",
          "-e",
          `
      const assert = require("node:assert/strict");
      const session = require(process.argv[1]);
      assert.throws(() => session.loadRebuildSession("alpha"), /session state changed/);
      assert.equal(session.acquireOnboardLock("FIFO recovery probe").acquired, true);
      try {
        assert.throws(() => session.selectRebuildSession("alpha"), /session state changed/);
      } finally {
        session.releaseOnboardLock();
      }
    `,
          fileURLToPath(new URL("./onboard-session.ts", import.meta.url)),
        ],
        {
          env: { ...process.env, HOME: tmpDir },
          encoding: "utf8",
          timeout: 15_000,
        },
      );

      expect(probe.error).toBeUndefined();
      expect(probe.status, probe.stderr).toBe(0);
      expect(session.loadSession()).toEqual(beta);
    },
    30_000,
  );

  it.each([
    {
      kind: "malformed",
      corrupt: (retained: string, _victim: string) =>
        fs.writeFileSync(retained, "{invalid", { mode: 0o600 }),
    },
    {
      kind: "symlink",
      corrupt: (retained: string, victim: string) => fs.symlinkSync(victim, retained),
    },
    {
      kind: "hardlink",
      corrupt: (retained: string, victim: string) => fs.linkSync(victim, retained),
    },
  ])("rejects a $kind recovery file during discovery and selection", ({ corrupt }) => {
    const alpha = withRebuildLock("alpha", () => begin("alpha"));
    const beta = withRebuildLock("beta", () => begin("beta"));
    const retained = path.join(session.SESSION_DIR, ".onboard-rebuild-alpha.json");
    const victim = path.join(tmpDir, "recovery-source.json");
    fs.writeFileSync(victim, JSON.stringify(alpha), { mode: 0o600 });
    fs.unlinkSync(retained);
    corrupt(retained, victim);

    expect(() => session.loadRebuildSession("alpha")).toThrow();
    expect(() => withRebuildLock("alpha", () => undefined)).toThrow();

    expect(session.isOnboardLockHeldByCurrentProcess()).toBe(false);
    expect(session.loadSession()).toEqual(beta);
    expect(fs.readFileSync(victim, "utf8")).toBe(JSON.stringify(alpha));
  });
});
