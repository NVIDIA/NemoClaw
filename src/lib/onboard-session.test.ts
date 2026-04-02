// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-session-"));
const require = createRequire(import.meta.url);
// Clear both the shim and the dist module so HOME changes take effect.
const shimPath = require.resolve("../../bin/lib/onboard-session");
const distPath = require.resolve("../../dist/lib/onboard-session");
const originalHome = process.env.HOME;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let session: any;

beforeEach(() => {
  process.env.HOME = tmpDir;
  delete require.cache[shimPath];
  delete require.cache[distPath];
  session = require("../../dist/lib/onboard-session");
  session.clearSession();
  session.releaseOnboardLock();
});

afterEach(() => {
  delete require.cache[shimPath];
  delete require.cache[distPath];
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
      "provider auth failed with NVIDIA_API_KEY=nvapi-secret Bearer topsecret sk-secret-value ghp_1234567890123456789012345",
    );

    const loaded = session.loadSession();
    expect(loaded.steps.inference.error).toContain("NVIDIA_API_KEY=<REDACTED>");
    expect(loaded.steps.inference.error).toContain("Bearer <REDACTED>");
    expect(loaded.steps.inference.error).not.toContain("nvapi-secret");
    expect(loaded.steps.inference.error).not.toContain("topsecret");
    expect(loaded.steps.inference.error).not.toContain("sk-secret-value");
    expect(loaded.steps.inference.error).not.toContain("ghp_1234567890123456789012345");
    expect(loaded.failure.message).toBe(loaded.steps.inference.error);
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
});
