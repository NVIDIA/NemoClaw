// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const distPath = require.resolve("../../dist/lib/onboard-session");
const originalHome = process.env.HOME;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let session: any;
let tmpDir: string;

beforeEach(() => {
  // Recreate tmpDir per test so lock artifacts (and any other on-disk state)
  // from a previous test cannot leak into this one. Without this, malformed
  // lock files left behind by releaseOnboardLock() make lock tests
  // order-dependent. See issue #1284.
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-session-"));
  process.env.HOME = tmpDir;
  delete require.cache[distPath];
  session = require("../../dist/lib/onboard-session");
  session.clearSession();
  session.releaseOnboardLock();
});

afterEach(() => {
  delete require.cache[distPath];
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
});

describe("onboard session", () => {
  it("starts empty", () => {
    expect(session.loadSession()).toBeNull();
  });

  it("creates and persists a session with restrictive permissions", () => {
    const created = session.createSession({ mode: "non-interactive" });
    const saved = session.saveSession(created);
    const stat = fs.statSync(session.SESSION_FILE);
    const dirStat = fs.statSync(path.dirname(session.SESSION_FILE));

    expect(saved.mode).toBe("non-interactive");
    expect(fs.existsSync(session.SESSION_FILE)).toBe(true);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(dirStat.mode & 0o777).toBe(0o700);
  });

  it("redacts credential-bearing endpoint URLs before persisting them", () => {
    session.saveSession(session.createSession());
    session.markStepComplete("provider_selection", {
      endpointUrl:
        "https://alice:secret@example.com/v1/models?token=abc123&sig=def456&X-Amz-Signature=ghi789&keep=yes#token=frag",
    });

    const loaded = session.loadSession();
    expect(loaded.endpointUrl).toBe(
      "https://example.com/v1/models?token=%3CREDACTED%3E&sig=%3CREDACTED%3E&X-Amz-Signature=%3CREDACTED%3E&keep=yes",
    );
    expect(session.summarizeForDebug().endpointUrl).toBe(loaded.endpointUrl);
  });

  it("marks steps started, completed, and failed", () => {
    session.saveSession(session.createSession());
    session.markStepStarted("gateway");
    let loaded = session.loadSession();
    expect(loaded.steps.gateway.status).toBe("in_progress");
    expect(loaded.lastStepStarted).toBe("gateway");
    expect(loaded.steps.gateway.completedAt).toBeNull();

    session.markStepComplete("gateway", { sandboxName: "my-assistant" });
    loaded = session.loadSession();
    expect(loaded.steps.gateway.status).toBe("complete");
    expect(loaded.sandboxName).toBe("my-assistant");
    expect(loaded.steps.gateway.completedAt).toBeTruthy();

    session.markStepFailed("sandbox", "Sandbox creation failed");
    loaded = session.loadSession();
    expect(loaded.steps.sandbox.status).toBe("failed");
    expect(loaded.steps.sandbox.completedAt).toBeNull();
    expect(loaded.failure.step).toBe("sandbox");
    expect(loaded.failure.message).toMatch(/Sandbox creation failed/);
  });

  it("persists safe provider metadata without persisting secrets", () => {
    session.saveSession(session.createSession());
    session.markStepComplete("provider_selection", {
      provider: "nvidia-nim",
      model: "nvidia/test-model",
      sandboxName: "my-assistant",
      endpointUrl: "https://example.com/v1",
      credentialEnv: "NVIDIA_API_KEY",
      preferredInferenceApi: "openai-completions",
      nimContainer: "nim-123",
      policyPresets: ["pypi", "npm"],
      apiKey: "nvapi-secret",
      metadata: {
        gatewayName: "nemoclaw",
        token: "secret",
      },
    });

    const loaded = session.loadSession();
    expect(loaded.provider).toBe("nvidia-nim");
    expect(loaded.model).toBe("nvidia/test-model");
    expect(loaded.sandboxName).toBe("my-assistant");
    expect(loaded.endpointUrl).toBe("https://example.com/v1");
    expect(loaded.credentialEnv).toBe("NVIDIA_API_KEY");
    expect(loaded.preferredInferenceApi).toBe("openai-completions");
    expect(loaded.nimContainer).toBe("nim-123");
    expect(loaded.policyPresets).toEqual(["pypi", "npm"]);
    expect(loaded.apiKey).toBeUndefined();
    expect(loaded.metadata.gatewayName).toBe("nemoclaw");
    expect(loaded.metadata.token).toBeUndefined();
  });

  it("persists messagingChannels across save/load roundtrips", () => {
    const created = session.createSession();
    created.messagingChannels = ["telegram", "slack"];
    session.saveSession(created);

    const loaded = session.loadSession();
    expect(loaded.messagingChannels).toEqual(["telegram", "slack"]);
  });

  it("filters non-string entries out of persisted messagingChannels", () => {
    const created = session.createSession();
    created.messagingChannels = ["telegram", 42, null, "discord"];
    session.saveSession(created);

    const loaded = session.loadSession();
    expect(loaded.messagingChannels).toEqual(["telegram", "discord"]);
  });

  it("defaults messagingChannels to null for fresh sessions", () => {
    const fresh = session.createSession();
    expect(fresh.messagingChannels).toBeNull();
  });

  it("persists and clears web search config through safe session updates", () => {
    session.saveSession(session.createSession());
    session.markStepComplete("provider_selection", {
      webSearchConfig: { fetchEnabled: true },
    });

    let loaded = session.loadSession();
    expect(loaded.webSearchConfig).toEqual({ fetchEnabled: true });

    session.completeSession({ webSearchConfig: null });
    loaded = session.loadSession();
    expect(loaded.webSearchConfig).toBeNull();
  });

  it("does not clear existing metadata when updates omit whitelisted metadata fields", () => {
    session.saveSession(session.createSession({ metadata: { gatewayName: "nemoclaw" } }));
    session.markStepComplete("provider_selection", {
      metadata: {
        token: "should-not-persist",
      },
    });

    const loaded = session.loadSession();
    expect(loaded.metadata.gatewayName).toBe("nemoclaw");
    expect(loaded.metadata.token).toBeUndefined();
  });

  it("drops non-string gatewayName during normalization", () => {
    fs.mkdirSync(path.dirname(session.SESSION_FILE), { recursive: true });
    fs.writeFileSync(
      session.SESSION_FILE,
      JSON.stringify({ version: 1, metadata: { gatewayName: 123 } }),
    );
    const loaded = session.loadSession();
    expect(loaded).not.toBeNull();
    expect(loaded!.metadata.gatewayName).toBe("nemoclaw");
  });

  it("returns null for corrupt session data", () => {
    fs.mkdirSync(path.dirname(session.SESSION_FILE), { recursive: true });
    fs.writeFileSync(session.SESSION_FILE, "not-json");
    expect(session.loadSession()).toBeNull();
  });

  it("acquires and releases the onboard lock", () => {
    const acquired = session.acquireOnboardLock("nemoclaw onboard");
    expect(acquired.acquired).toBe(true);
    expect(fs.existsSync(session.LOCK_FILE)).toBe(true);

    const secondAttempt = session.acquireOnboardLock("nemoclaw onboard --resume");
    expect(secondAttempt.acquired).toBe(false);
    expect(secondAttempt.holderPid).toBe(process.pid);

    session.releaseOnboardLock();
    expect(fs.existsSync(session.LOCK_FILE)).toBe(false);
  });

  it("replaces a stale onboard lock", () => {
    fs.mkdirSync(path.dirname(session.LOCK_FILE), { recursive: true });
    fs.writeFileSync(
      session.LOCK_FILE,
      JSON.stringify({
        pid: 999999,
        startedAt: "2026-03-25T00:00:00.000Z",
        command: "nemoclaw onboard",
      }),
      { mode: 0o600 },
    );

    const acquired = session.acquireOnboardLock("nemoclaw onboard --resume");
    expect(acquired.acquired).toBe(true);

    const written = JSON.parse(fs.readFileSync(session.LOCK_FILE, "utf8"));
    expect(written.pid).toBe(process.pid);
  });

  it("regression #1281: stale-cleanup race does not unlink a fresh lock claimed by another process", () => {
    // Reproduces the race: the lock file we read as 'stale' gets replaced
    // with a fresh claim from a faster concurrent process between our
    // read and our unlink. The slower process must NOT unlink the fresh
    // lock, otherwise both processes end up thinking they hold the lock.
    fs.mkdirSync(path.dirname(session.LOCK_FILE), { recursive: true });

    // 1. Lay down a stale lock from a dead PID (PID 999999 on the test box).
    const staleLock = JSON.stringify({
      pid: 999999,
      startedAt: "2026-03-25T00:00:00.000Z",
      command: "nemoclaw onboard",
    });
    fs.writeFileSync(session.LOCK_FILE, staleLock, { mode: 0o600 });

    // 2. Wrap fs.statSync so the swap happens just before stat #2:
    //    - stat #1 (inside acquireOnboardLock): reads the stale inode
    //      and returns it unmodified. readFileSync then reads the
    //      ORIGINAL stale lock (dead PID 999999), isProcessAlive
    //      returns false, and acquireOnboardLock enters the stale-
    //      cleanup path calling unlinkIfInodeMatches.
    //    - stat #2 (inside unlinkIfInodeMatches): BEFORE the actual
    //      stat, swap the file for a fresh claim. stat #2 then sees
    //      a different inode → must skip the unlink.
    //
    //    CodeRabbit correctly flagged the original test: swapping on
    //    stat #1 caused readFileSync to see the live PID and exit
    //    via isProcessAlive, never reaching unlinkIfInodeMatches.
    let statCallCount = 0;
    const originalStatSync = fs.statSync;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fs as any).statSync = function (...args: unknown[]) {
      statCallCount += 1;
      // Just before stat #2 (inside unlinkIfInodeMatches), simulate
      // the race: a concurrent fast process unlinks the stale lock
      // and writes a fresh claim. stat #2 then sees a new inode.
      if (statCallCount === 2) {
        // Write the fresh claim to a temp file first, then rename over
        // the stale lock. This guarantees a different inode even on
        // tmpfs/overlayfs which can reuse inodes after unlink+recreate.
        const tmpClaim = session.LOCK_FILE + ".race-tmp";
        fs.writeFileSync(
          tmpClaim,
          JSON.stringify({
            pid: process.ppid,
            startedAt: new Date().toISOString(),
            command: "nemoclaw onboard (fresh claim from concurrent process)",
          }),
          { mode: 0o600 },
        );
        fs.renameSync(tmpClaim, session.LOCK_FILE);
      }
      return (originalStatSync as unknown as (...a: unknown[]) => unknown).apply(fs, args);
    };

    try {
      // The acquire call will see EEXIST (stale lock present), stat it,
      // then the swap happens, then the second stat (inside the cleanup
      // helper) sees a different inode → must NOT unlink.
      const result = session.acquireOnboardLock("nemoclaw onboard --resume");
      // The fresh lock that the simulated concurrent process wrote
      // should still be on disk after acquireOnboardLock returns.
      expect(fs.existsSync(session.LOCK_FILE)).toBe(true);
      const onDisk = JSON.parse(fs.readFileSync(session.LOCK_FILE, "utf8"));
      // The lock content should be the fresh claim, NOT the stale one
      // and NOT a new one written by acquireOnboardLock after a wrong
      // unlink.
      expect(onDisk.command).toContain("fresh claim from concurrent process");
      // The fresh claim is held by a different live PID (process.ppid),
      // so acquireOnboardLock MUST report acquisition failure and
      // surface that pid as the holder. This is the mutual-exclusion
      // loser path — without it, the regression would only verify the
      // fresh file survived, not that the contender correctly stood
      // down.
      expect(result.acquired).toBe(false);
      expect(result.holderPid).toBe(process.ppid);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (fs as any).statSync = originalStatSync;
    }
  });

  it("treats unreadable or transient lock contents as a retry, not a stale lock", () => {
    fs.mkdirSync(path.dirname(session.LOCK_FILE), { recursive: true });
    fs.writeFileSync(session.LOCK_FILE, "{not-json", { mode: 0o600 });

    const acquired = session.acquireOnboardLock("nemoclaw onboard --resume");
    expect(acquired.acquired).toBe(false);
    expect(acquired.stale).toBe(true);
    expect(fs.existsSync(session.LOCK_FILE)).toBe(true);
  });

  it("ignores malformed lock files when releasing the onboard lock", () => {
    fs.mkdirSync(path.dirname(session.LOCK_FILE), { recursive: true });
    fs.writeFileSync(session.LOCK_FILE, "{not-json", { mode: 0o600 });

    session.releaseOnboardLock();
    expect(fs.existsSync(session.LOCK_FILE)).toBe(true);
  });

  it("redacts sensitive values from persisted failure messages", () => {
    session.saveSession(session.createSession());
    session.markStepFailed(
      "inference",
      "provider auth failed with NVIDIA_API_KEY=nvapi-secret Bearer topsecret sk-secret-value-that-is-long-enough ghp_1234567890123456789012345",
    );

    const loaded = session.loadSession();
    expect(loaded.steps.inference.error).toContain("NVIDIA_API_KEY=<REDACTED>");
    expect(loaded.steps.inference.error).toContain("Bearer <REDACTED>");
    expect(loaded.steps.inference.error).not.toContain("nvapi-secret");
    expect(loaded.steps.inference.error).not.toContain("topsecret");
    expect(loaded.steps.inference.error).not.toContain("sk-secret-value-that-is-long-enough");
    expect(loaded.steps.inference.error).not.toContain("ghp_1234567890123456789012345");
    expect(loaded.failure.message).toBe(loaded.steps.inference.error);
  });

  it("round-trips null messagingChannels through normalizeSession", () => {
    const created = session.createSession();
    expect(created.messagingChannels).toBeNull();
    const saved = session.saveSession(created);
    const loaded = session.loadSession();
    expect(saved.messagingChannels).toBeNull();
    expect(loaded.messagingChannels).toBeNull();
  });

  it("round-trips messagingChannels=['telegram'] through normalizeSession", () => {
    const created = session.createSession({ messagingChannels: ["telegram"] });
    expect(created.messagingChannels).toEqual(["telegram"]);
    const saved = session.saveSession(created);
    const loaded = session.loadSession();
    expect(saved.messagingChannels).toEqual(["telegram"]);
    expect(loaded.messagingChannels).toEqual(["telegram"]);
  });

  it("filterSafeUpdates preserves messagingChannels field", () => {
    session.saveSession(session.createSession());
    session.markStepComplete("provider_selection", {
      messagingChannels: ["slack", "discord"],
    });

    const loaded = session.loadSession();
    expect(loaded.messagingChannels).toEqual(["slack", "discord"]);
  });

  it("createSession with messagingChannels override", () => {
    const created = session.createSession({ messagingChannels: ["telegram", "slack"] });
    expect(created.messagingChannels).toEqual(["telegram", "slack"]);
    expect(created.provider).toBeNull();
  });

  it("summarizes the session for debug output", () => {
    session.saveSession(session.createSession({ sandboxName: "my-assistant" }));
    session.markStepStarted("preflight");
    session.markStepComplete("preflight");
    session.completeSession();
    const summary = session.summarizeForDebug();

    expect(summary.sandboxName).toBe("my-assistant");
    expect(summary.steps.preflight.status).toBe("complete");
    expect(summary.steps.preflight.startedAt).toBeTruthy();
    expect(summary.steps.preflight.completedAt).toBeTruthy();
    expect(summary.resumable).toBe(false);
  });

  it("keeps debug summaries redacted when failures were sanitized", () => {
    session.saveSession(session.createSession({ sandboxName: "my-assistant" }));
    session.markStepFailed("provider_selection", "Bearer abcdefghijklmnopqrstuvwxyz");
    const summary = session.summarizeForDebug();

    expect(summary.failure.message).toContain("Bearer <REDACTED>");
    expect(summary.failure.message).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });

  it("re-sanitizes in-memory failures in debug summaries", () => {
    const rawSession = session.createSession({
      failure: {
        step: "provider_selection",
        message: "Bearer abcdefghijklmnopqrstuvwxyz",
        recordedAt: "2026-04-01T00:00:00.000Z",
      },
    });

    const summary = session.summarizeForDebug(rawSession);
    expect(summary.failure.message).toContain("Bearer <REDACTED>");
    expect(summary.failure.message).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });
});
