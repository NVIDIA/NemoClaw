// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type OnboardSessionModule = typeof import("./onboard-session");
type LoadedSession = NonNullable<ReturnType<OnboardSessionModule["loadSession"]>>;
type MessagingPlan = NonNullable<LoadedSession["messagingPlan"]>;
let session: OnboardSessionModule;
let tmpDir: string;

function requireLoadedSession(loaded: LoadedSession | null): LoadedSession {
  expect(loaded).not.toBeNull();
  return loaded as LoadedSession;
}

function makeTelegramPlan(sandboxName: string): MessagingPlan {
  return {
    schemaVersion: 1,
    sandboxName,
    agent: "openclaw",
    workflow: "onboard",
    channels: [
      {
        channelId: "telegram",
        displayName: "telegram",
        authMode: "token-paste",
        active: true,
        selected: true,
        configured: true,
        disabled: false,
        inputs: [],
        hooks: [],
      },
    ],
    disabledChannels: [],
    credentialBindings: [],
    networkPolicy: { presets: [], entries: [] },
    agentRender: [],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
  };
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-prompt-session-"));
  vi.stubEnv("HOME", tmpDir);
  vi.resetModules();
  session = await import("./onboard-session");
  session.clearSession();
});

afterEach(() => {
  session.clearSession();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("onboard session sandbox prompt checkpoints", () => {
  it.each([
    ["OpenShell defaults", null],
    ["a selected profile", { cpu: "75%", memory: "75%" }],
  ] as const)("round-trips completed choices with %s without transient secrets or intent (#6743)", (_label, resourceProfile) => {
    const braveCredential = "brave-secret-value";
    const telegramCredential = "telegram-secret-value";
    const created = session.createSession({
      sandboxName: "tm",
      webSearchConfig: { fetchEnabled: true, provider: "brave" },
      messagingPlan: makeTelegramPlan("tm"),
      sandboxPromptProgress: {
        sandboxName: true,
        webSearch: true,
        messaging: true,
        resourceProfile: true,
      },
      resourceProfile,
      stagedCredentialProviders: ["tm-brave-search", "tm-telegram-bridge"],
    });
    Object.assign(created as unknown as Record<string, unknown>, {
      BRAVE_API_KEY: braveCredential,
      TELEGRAM_BOT_TOKEN: telegramCredential,
      sandboxCreateIntent: { resolved: { resourceCreateArgs: ["--cpu", "6"] } },
    });

    session.saveSession(created);

    const raw = JSON.parse(fs.readFileSync(session.SESSION_FILE, "utf-8"));
    expect(raw).toMatchObject({
      sandboxName: "tm",
      webSearchConfig: { fetchEnabled: true, provider: "brave" },
      sandboxPromptProgress: {
        sandboxName: true,
        webSearch: true,
        messaging: true,
        resourceProfile: true,
      },
      resourceProfile,
      stagedCredentialProviders: ["tm-brave-search", "tm-telegram-bridge"],
    });
    const serialized = JSON.stringify(raw);
    expect(serialized).not.toContain(braveCredential);
    expect(serialized).not.toContain(telegramCredential);
    expect(serialized).not.toContain('"sandboxCreateIntent"');
    expect(serialized).not.toContain('"resolved"');
    expect(serialized).not.toContain('"resourceCreateArgs"');

    const loaded = requireLoadedSession(session.loadSession());
    expect(loaded.sandboxPromptProgress).toEqual({
      sandboxName: true,
      webSearch: true,
      messaging: true,
      resourceProfile: true,
    });
    expect(loaded.resourceProfile).toEqual(resourceProfile);
    expect(loaded.stagedCredentialProviders).toEqual(["tm-brave-search", "tm-telegram-bridge"]);
  });

  it("defaults unanswered progress and resources for fresh sessions (#6743)", () => {
    const fresh = session.createSession();

    expect(fresh.sandboxPromptProgress).toEqual({
      sandboxName: false,
      webSearch: false,
      messaging: false,
      resourceProfile: false,
    });
    expect(fresh.resourceProfile).toBeNull();
    expect(fresh.stagedCredentialProviders).toEqual([]);
  });

  it("keeps explicit null choices complete but clears malformed or missing values (#6743)", () => {
    const explicitNone = session.createSession({
      sandboxName: "tm",
      webSearchConfig: null,
      messagingPlan: null,
      resourceProfile: null,
      sandboxPromptProgress: {
        sandboxName: true,
        webSearch: true,
        messaging: true,
        resourceProfile: true,
      },
    });
    expect(explicitNone.sandboxPromptProgress).toEqual({
      sandboxName: true,
      webSearch: true,
      messaging: true,
      resourceProfile: true,
    });

    const malformed = explicitNone as unknown as Record<string, unknown>;
    malformed.sandboxName = "Invalid Name";
    malformed.webSearchConfig = { fetchEnabled: false };
    delete malformed.messagingPlan;
    malformed.resourceProfile = { cpu: 42, memory: "75%" };

    const normalized = requireLoadedSession(session.normalizeSession(malformed as never));
    expect(normalized.sandboxPromptProgress).toEqual({
      sandboxName: false,
      webSearch: false,
      messaging: false,
      resourceProfile: false,
    });
  });

  it("preserves one-sided resource overrides as completed (#6743)", () => {
    const normalized = session.createSession({
      resourceProfile: { cpu: "", memory: "75%" },
      sandboxPromptProgress: {
        sandboxName: false,
        webSearch: false,
        messaging: false,
        resourceProfile: true,
      },
    });

    expect(normalized.resourceProfile).toEqual({ cpu: "", memory: "75%" });
    expect(normalized.sandboxPromptProgress.resourceProfile).toBe(true);
  });

  it("rejects completed messaging state for a different sandbox (#6743)", () => {
    const normalized = session.createSession({
      sandboxName: "tm",
      messagingPlan: makeTelegramPlan("other-sandbox"),
      sandboxPromptProgress: {
        sandboxName: true,
        webSearch: false,
        messaging: true,
        resourceProfile: false,
      },
    });

    expect(normalized.messagingPlan?.sandboxName).toBe("other-sandbox");
    expect(normalized.sandboxPromptProgress.messaging).toBe(false);
  });
});
