// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const distPath = require.resolve("../../../dist/lib/state/onboard-session");
const eventsDistPath = require.resolve("../../../dist/lib/onboard/machine/events");
const originalHome = process.env.HOME;
type OnboardSessionModule = typeof import("../../../dist/lib/state/onboard-session");
type OnboardMachineEventsModule = typeof import("../../../dist/lib/onboard/machine/events");
type OnboardMachineEvent = import("../../../dist/lib/onboard/machine/events").OnboardMachineEvent;
type LoadedSession = NonNullable<ReturnType<OnboardSessionModule["loadSession"]>>;
type DebugSummary = NonNullable<ReturnType<OnboardSessionModule["summarizeForDebug"]>>;
type MessagingPlan = NonNullable<LoadedSession["messagingPlan"]>;
type MessagingChannelId = MessagingPlan["channels"][number]["channelId"];
let session: OnboardSessionModule;
let machineEvents: OnboardMachineEventsModule;
let tmpDir: string;

function requireLoadedSession(
  loaded: ReturnType<OnboardSessionModule["loadSession"]>,
): LoadedSession {
  expect(loaded).not.toBeNull();
  if (!loaded) {
    throw new Error("Expected onboard session to be present");
  }
  return loaded;
}

function requireDebugSummary(
  summary: ReturnType<OnboardSessionModule["summarizeForDebug"]>,
): DebugSummary {
  expect(summary).not.toBeNull();
  if (!summary) {
    throw new Error("Expected debug session summary to be present");
  }
  return summary;
}

function normalizeLegacySession(
  legacy: unknown,
): ReturnType<OnboardSessionModule["normalizeSession"]> {
  return session.normalizeSession(
    legacy as Parameters<OnboardSessionModule["normalizeSession"]>[0],
  );
}

function makeMessagingPlan(
  sandboxName: string,
  channels: readonly MessagingChannelId[] = [],
  disabledChannels: readonly MessagingChannelId[] = [],
): MessagingPlan {
  const disabled = new Set(disabledChannels);
  return {
    schemaVersion: 1,
    sandboxName,
    agent: "openclaw",
    workflow: "onboard",
    channels: channels.map((channelId) => ({
      channelId,
      displayName: channelId,
      authMode: "token-paste",
      active: !disabled.has(channelId),
      selected: true,
      configured: true,
      disabled: disabled.has(channelId),
      inputs: [],
      hooks: [],
    })),
    disabledChannels: [...disabledChannels],
    credentialBindings: [],
    networkPolicy: { presets: [], entries: [] },
    agentRender: [],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
  };
}

beforeEach(() => {
  // Recreate tmpDir per test so lock artifacts (and any other on-disk state)
  // from a previous test cannot leak into this one. Without this, malformed
  // lock files left behind by releaseOnboardLock() make lock tests
  // order-dependent. See issue #1284.
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-session-"));
  process.env.HOME = tmpDir;
  delete require.cache[distPath];
  delete require.cache[eventsDistPath];
  session = require("../../../dist/lib/state/onboard-session");
  machineEvents = require("../../../dist/lib/onboard/machine/events");
  machineEvents.clearOnboardMachineEventListeners();
  session.clearSession();
  session.releaseOnboardLock();
});

afterEach(() => {
  machineEvents.clearOnboardMachineEventListeners();
  delete require.cache[distPath];
  delete require.cache[eventsDistPath];
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
    const created = session.createSession({
      mode: "non-interactive",
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    const saved = session.saveSession(created);
    const stat = fs.statSync(session.SESSION_FILE);
    const dirStat = fs.statSync(path.dirname(session.SESSION_FILE));

    expect(saved.mode).toBe("non-interactive");
    expect(saved.machine).toMatchObject({
      version: 1,
      state: "init",
      revision: 0,
    });
    expect(saved.machine.stateEnteredAt).toBe("2026-01-01T00:00:00.000Z");
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

    const loaded = requireLoadedSession(session.loadSession());
    expect(loaded.endpointUrl).toBe(
      "https://example.com/v1/models?token=%3CREDACTED%3E&sig=%3CREDACTED%3E&X-Amz-Signature=%3CREDACTED%3E&keep=yes",
    );
    const summary = requireDebugSummary(session.summarizeForDebug());
    expect(summary.endpointUrl).toBe(loaded.endpointUrl);
  });

  it("marks steps started, completed, and failed", () => {
    session.saveSession(session.createSession());
    session.markStepStarted("gateway");
    let loaded = requireLoadedSession(session.loadSession());
    expect(loaded.steps.gateway.status).toBe("in_progress");
    expect(loaded.lastStepStarted).toBe("gateway");
    expect(loaded.steps.gateway.completedAt).toBeNull();

    session.markStepComplete("gateway", { sandboxName: "my-assistant" });
    loaded = requireLoadedSession(session.loadSession());
    expect(loaded.steps.gateway.status).toBe("complete");
    expect(loaded.sandboxName).toBe("my-assistant");
    expect(loaded.steps.gateway.completedAt).toBeTruthy();

    session.markStepFailed("sandbox", "Sandbox creation failed");
    loaded = requireLoadedSession(session.loadSession());
    expect(loaded.steps.sandbox.status).toBe("failed");
    expect(loaded.steps.sandbox.completedAt).toBeNull();
    expect(loaded.failure).not.toBeNull();
    if (!loaded.failure) {
      throw new Error("Expected failure metadata after markStepFailed()");
    }
    expect(loaded.failure.step).toBe("sandbox");
    expect(loaded.failure.message).toMatch(/Sandbox creation failed/);
    expect(loaded.machine.state).toBe("failed");
  });

  it("can record step boundaries without mutating the machine snapshot", () => {
    const emitted: OnboardMachineEvent[] = [];
    machineEvents.addOnboardMachineEventListener((event) => emitted.push(event));
    session.saveSession(session.createSession());

    session.markStepStarted("preflight", { updateMachine: false });
    let loaded = requireLoadedSession(session.loadSession());
    expect(loaded.steps.preflight.status).toBe("in_progress");
    expect(loaded.status).toBe("in_progress");
    expect(loaded.machine).toMatchObject({ state: "init", revision: 0 });

    session.markStepComplete(
      "preflight",
      { sandboxName: "my-assistant" },
      { updateMachine: false },
    );
    loaded = requireLoadedSession(session.loadSession());
    expect(loaded.steps.preflight.status).toBe("complete");
    expect(loaded.sandboxName).toBe("my-assistant");
    expect(loaded.machine).toMatchObject({ state: "init", revision: 0 });

    session.markStepFailed("gateway", "Gateway failed", { updateMachine: false });
    loaded = requireLoadedSession(session.loadSession());
    expect(loaded.steps.gateway.status).toBe("failed");
    expect(loaded.status).toBe("in_progress");
    expect(loaded.failure).toBeNull();
    expect(loaded.machine).toMatchObject({ state: "init", revision: 0 });
    expect(emitted.map((event) => event.type)).toEqual(["context.updated"]);
  });

  it("persists a compact machine snapshot across step boundaries", () => {
    session.saveSession(session.createSession());
    let loaded = requireLoadedSession(session.loadSession());
    expect(loaded.machine).toMatchObject({ state: "init", revision: 0 });

    session.markStepStarted("preflight");
    loaded = requireLoadedSession(session.loadSession());
    expect(loaded.machine).toMatchObject({ state: "preflight", revision: 1 });
    expect(loaded.machine.stateEnteredAt).toBe(loaded.steps.preflight.startedAt);

    session.markStepComplete("preflight");
    loaded = requireLoadedSession(session.loadSession());
    expect(loaded.machine).toMatchObject({ state: "gateway", revision: 2 });
    expect(loaded.machine.stateEnteredAt).toBe(loaded.steps.preflight.completedAt);

    session.markStepComplete("gateway");
    loaded = requireLoadedSession(session.loadSession());
    expect(loaded.machine).toMatchObject({ state: "provider_selection", revision: 3 });

    session.completeSession();
    loaded = requireLoadedSession(session.loadSession());
    expect(loaded.machine).toMatchObject({ state: "complete", revision: 4 });
    expect(requireDebugSummary(session.summarizeForDebug()).machine).toEqual(loaded.machine);
  });

  it("normalizes old sessions without machine snapshots", () => {
    type LegacySession = Omit<ReturnType<OnboardSessionModule["createSession"]>, "machine"> & {
      machine?: unknown;
    };
    const legacy = session.createSession({
      sessionId: "legacy-session",
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:05:00.000Z",
    }) as unknown as LegacySession;
    delete legacy.machine;
    legacy.steps.gateway.status = "in_progress";
    legacy.steps.gateway.startedAt = "2026-01-01T00:02:00.000Z";
    legacy.lastStepStarted = "gateway";

    let normalized = requireLoadedSession(normalizeLegacySession(legacy));
    expect(normalized.machine).toEqual({
      version: 1,
      state: "gateway",
      stateEnteredAt: "2026-01-01T00:02:00.000Z",
      revision: 0,
    });

    legacy.steps.gateway.status = "complete";
    legacy.steps.gateway.completedAt = "2026-01-01T00:03:00.000Z";
    legacy.lastCompletedStep = "gateway";
    normalized = requireLoadedSession(normalizeLegacySession(legacy));
    expect(normalized.machine).toEqual({
      version: 1,
      state: "provider_selection",
      stateEnteredAt: "2026-01-01T00:03:00.000Z",
      revision: 0,
    });

    legacy.status = "failed";
    legacy.failure = {
      step: "gateway",
      message: "boom",
      recordedAt: "2026-01-01T00:04:00.000Z",
    };
    normalized = requireLoadedSession(normalizeLegacySession(legacy));
    expect(normalized.machine).toEqual({
      version: 1,
      state: "failed",
      stateEnteredAt: "2026-01-01T00:04:00.000Z",
      revision: 0,
    });

    legacy.status = "complete";
    normalized = requireLoadedSession(normalizeLegacySession(legacy));
    expect(normalized.machine.state).toBe("complete");
  });

  it("normalizes invalid machine snapshots from old sessions", () => {
    type LegacySession = Omit<ReturnType<OnboardSessionModule["createSession"]>, "machine"> & {
      machine?: unknown;
    };
    const legacy = session.createSession({
      lastCompletedStep: "policies",
    }) as unknown as LegacySession;
    legacy.steps.policies.status = "complete";
    legacy.steps.policies.completedAt = "2026-01-01T00:08:00.000Z";
    legacy.machine = {
      version: 1,
      state: "not-a-state",
      stateEnteredAt: "2026-01-01T00:09:00.000Z",
      revision: -1,
    };

    const normalized = requireLoadedSession(normalizeLegacySession(legacy));
    expect(normalized.machine).toEqual({
      version: 1,
      state: "finalizing",
      stateEnteredAt: "2026-01-01T00:08:00.000Z",
      revision: 0,
    });
  });

  it("emits redacted structured machine events for session step mutations", () => {
    const emitted: OnboardMachineEvent[] = [];
    machineEvents.addOnboardMachineEventListener((event) => emitted.push(event));

    session.saveSession(session.createSession({ sessionId: "session-1" }));
    session.markStepStarted("gateway");
    session.markStepComplete("gateway", {
      sandboxName: "my-assistant",
      endpointUrl:
        "https://alice:super-secret-token@example.com/v1?token=super-secret-token&keep=yes#token=super-secret-token",
      credentialEnv: "NVIDIA_API_KEY",
    });
    session.markStepSkipped("openclaw");
    session.markStepFailed("sandbox", "NVIDIA_API_KEY=super-secret-token");
    session.completeSession({ provider: "ollama-local", credentialEnv: null });

    expect(emitted.map((event) => event.type)).toEqual([
      "state.entered",
      "context.updated",
      "state.completed",
      "state.skipped",
      "state.failed",
      "onboard.failed",
      "context.updated",
      "onboard.completed",
    ]);
    expect(emitted[0]).toMatchObject({
      version: 1,
      sessionId: "session-1",
      state: "gateway",
      step: "gateway",
      error: null,
    });
    expect(emitted[1].context).toMatchObject({
      sandboxName: "my-assistant",
      credentialEnv: "NVIDIA_API_KEY",
    });
    expect(emitted[1].context.endpointOrigin).toBe("https://example.com");
    expect(emitted[1].metadata.fields).toEqual(["sandboxName", "endpointUrl", "credentialEnv"]);
    expect(emitted[4]).toMatchObject({
      type: "state.failed",
      state: "sandbox",
      step: "sandbox",
      error: "NVIDIA_API_KEY=<REDACTED>",
    });
    expect(emitted[5]).toMatchObject({ type: "onboard.failed", state: "failed" });
    expect(emitted.at(-1)).toMatchObject({ type: "onboard.completed", state: "complete" });
    expect(JSON.stringify(emitted)).not.toContain("super-secret-token");

    const persisted = JSON.parse(fs.readFileSync(session.SESSION_FILE, "utf8"));
    expect(persisted.events).toBeUndefined();
  });

  it("keeps event observer failures from changing session mutation behavior", () => {
    machineEvents.addOnboardMachineEventListener(() => {
      throw new Error("observer failed");
    });

    session.saveSession(session.createSession());
    expect(() => session.markStepStarted("preflight")).not.toThrow();

    const loaded = requireLoadedSession(session.loadSession());
    expect(loaded.steps.preflight.status).toBe("in_progress");
  });

  it("does not emit machine events for unknown session step names", () => {
    const emitted: OnboardMachineEvent[] = [];
    machineEvents.addOnboardMachineEventListener((event) => emitted.push(event));

    session.saveSession(session.createSession());
    session.markStepStarted("not_a_real_step");

    expect(emitted).toEqual([]);
  });

  it("does not emit duplicate events for no-op skipped and completed transitions", () => {
    const emitted: OnboardMachineEvent[] = [];
    machineEvents.addOnboardMachineEventListener((event) => emitted.push(event));

    session.saveSession(session.createSession({ sessionId: "session-1" }));
    session.markStepSkipped("openclaw");
    session.markStepSkipped("openclaw");
    session.completeSession();
    session.completeSession();

    expect(emitted.map((event) => event.type)).toEqual(["state.skipped", "onboard.completed"]);
    expect(emitted).toHaveLength(2);
  });

  it("persists safe provider metadata without persisting secrets", () => {
    session.saveSession(session.createSession());
    const unsafeProviderUpdate: Parameters<OnboardSessionModule["markStepComplete"]>[1] & {
      apiKey: string;
      metadata: { gatewayName: string; token: string };
    } = {
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
    };
    session.markStepComplete("provider_selection", unsafeProviderUpdate);

    const loaded = requireLoadedSession(session.loadSession());
    expect(loaded.provider).toBe("nvidia-nim");
    expect(loaded.model).toBe("nvidia/test-model");
    expect(loaded.sandboxName).toBe("my-assistant");
    expect(loaded.endpointUrl).toBe("https://example.com/v1");
    expect(loaded.credentialEnv).toBe("NVIDIA_API_KEY");
    expect(loaded.preferredInferenceApi).toBe("openai-completions");
    expect(loaded.nimContainer).toBe("nim-123");
    expect(loaded.policyPresets).toEqual(["pypi", "npm"]);
    expect("apiKey" in loaded).toBe(false);
    expect(loaded.metadata.gatewayName).toBe("nemoclaw");
    expect("token" in loaded.metadata).toBe(false);
  });

  // ── GH #2625: provider switch from remote→local must clear stale fields ──
  //
  // Before the fix, filterSafeUpdates only accepted `typeof === "string"` for
  // nullable session fields, so passing `null` (as the wizard does when a
  // local provider is selected) silently dropped the clear. A prior
  // remote-provider session's `credentialEnv: "OPENAI_API_KEY"` survived to
  // disk and the next rebuild preflight demanded a credential the current
  // sandbox did not need.

  it("clears credentialEnv when provider-selection update passes null (GH #2625)", () => {
    // Seed with a prior remote-provider onboard state.
    session.saveSession(session.createSession());
    session.markStepComplete("provider_selection", {
      provider: "openai",
      model: "gpt-4o",
      endpointUrl: "https://api.openai.com/v1",
      credentialEnv: "OPENAI_API_KEY",
      preferredInferenceApi: "openai-completions",
      nimContainer: null,
    });
    let loaded = requireLoadedSession(session.loadSession());
    expect(loaded.credentialEnv).toBe("OPENAI_API_KEY");

    // User re-runs onboard and picks local Ollama. The wizard emits
    // credentialEnv=null and nimContainer=null alongside the new provider.
    session.markStepComplete("provider_selection", {
      provider: "ollama-local",
      model: "qwen3:14b",
      endpointUrl: "http://host.docker.internal:11434/v1",
      credentialEnv: null,
      preferredInferenceApi: "openai-completions",
      nimContainer: null,
    });

    loaded = requireLoadedSession(session.loadSession());
    expect(loaded.provider).toBe("ollama-local");
    expect(loaded.model).toBe("qwen3:14b");
    expect(loaded.credentialEnv).toBeNull();
    expect(loaded.nimContainer).toBeNull();
  });

  it("leaves credentialEnv unchanged when the update does not supply it", () => {
    // Regression guard: undefined must mean "leave unchanged", distinct from
    // null ("clear"). Partial updates must not accidentally wipe fields.
    session.saveSession(session.createSession());
    session.markStepComplete("provider_selection", {
      provider: "openai",
      model: "gpt-4o",
      credentialEnv: "OPENAI_API_KEY",
    });
    session.markStepComplete("provider_selection", { model: "gpt-4o-mini" });

    const loaded = requireLoadedSession(session.loadSession());
    expect(loaded.model).toBe("gpt-4o-mini");
    expect(loaded.credentialEnv).toBe("OPENAI_API_KEY");
    expect(loaded.provider).toBe("openai");
  });

  it("only persists known Hermes auth methods", () => {
    session.saveSession(session.createSession());
    session.markStepComplete("provider_selection", {
      provider: "hermes-provider",
      hermesAuthMethod: "oauth",
    });
    let loaded = requireLoadedSession(session.loadSession());
    expect(loaded.hermesAuthMethod).toBe("oauth");

    session.markStepComplete("provider_selection", {
      hermesAuthMethod: "not-a-real-method" as never,
    });
    loaded = requireLoadedSession(session.loadSession());
    expect(loaded.hermesAuthMethod).toBe("oauth");

    session.markStepComplete("provider_selection", {
      hermesAuthMethod: null,
    });
    loaded = requireLoadedSession(session.loadSession());
    expect(loaded.hermesAuthMethod).toBeNull();
  });

  it("accepts null as an explicit clear for every nullable string field", () => {
    // All six nullable fields that travel through filterSafeUpdates must
    // support the null-clear contract. If any regresses to the old
    // string-only guard, the test below catches it.
    session.saveSession(session.createSession());
    session.markStepComplete("provider_selection", {
      sandboxName: "stale-sandbox",
      provider: "openai",
      model: "gpt-4o",
      endpointUrl: "https://api.openai.com/v1",
      credentialEnv: "OPENAI_API_KEY",
      preferredInferenceApi: "openai-completions",
      nimContainer: "nim-abc",
    });

    session.markStepComplete("provider_selection", {
      sandboxName: null,
      provider: null,
      model: null,
      endpointUrl: null,
      credentialEnv: null,
      preferredInferenceApi: null,
      nimContainer: null,
    });

    const loaded = requireLoadedSession(session.loadSession());
    expect(loaded.sandboxName).toBeNull();
    expect(loaded.provider).toBeNull();
    expect(loaded.model).toBeNull();
    expect(loaded.endpointUrl).toBeNull();
    expect(loaded.credentialEnv).toBeNull();
    expect(loaded.preferredInferenceApi).toBeNull();
    expect(loaded.nimContainer).toBeNull();
  });

  it("clears credentialEnv via completeSession when the wizard finishes on a local provider", () => {
    // Matches the terminal path at end of onboard(): completeSession is what
    // finalizes the session for a successful run. A local-provider onboard
    // must not leave a stale credentialEnv on the "complete" record either.
    session.saveSession(session.createSession());
    session.markStepComplete("provider_selection", {
      provider: "openai",
      credentialEnv: "OPENAI_API_KEY",
    });
    session.completeSession({
      provider: "ollama-local",
      model: "qwen3:14b",
      credentialEnv: null,
      nimContainer: null,
    });

    const loaded = requireLoadedSession(session.loadSession());
    expect(loaded.status).toBe("complete");
    expect(loaded.provider).toBe("ollama-local");
    expect(loaded.credentialEnv).toBeNull();
    expect(loaded.nimContainer).toBeNull();
  });

  it("persists messagingPlan across save/load roundtrips", () => {
    const created = session.createSession();
    created.messagingPlan = makeMessagingPlan("my-assistant", ["telegram", "slack"], ["slack"]);
    session.saveSession(created);

    const loaded = requireLoadedSession(session.loadSession());
    expect(loaded.messagingPlan).toEqual(created.messagingPlan);
  });

  it("drops malformed persisted messagingPlan on load", () => {
    const created = session.createSession();
    fs.mkdirSync(path.dirname(session.SESSION_FILE), { recursive: true });
    fs.writeFileSync(
      session.SESSION_FILE,
      JSON.stringify({
        ...created,
        messagingPlan: {
          ...makeMessagingPlan("my-assistant", ["telegram"]),
          disabledChannels: ["telegram", 42, null],
        },
      }),
    );

    const loaded = requireLoadedSession(session.loadSession());
    expect(loaded.messagingPlan).toBeNull();
  });

  it("persists disabled channel state inside messagingPlan", () => {
    // Regression: `channels stop X` followed by rebuild must carry the paused
    // set through the destroy/recreate window. The session plan is the only
    // place this can survive, because rebuild destroys the registry entry
    // before `onboard --resume` reads it back.
    const created = session.createSession();
    created.messagingPlan = makeMessagingPlan("my-assistant", ["telegram"], ["telegram"]);
    session.saveSession(created);

    const loaded = requireLoadedSession(session.loadSession());
    expect(loaded.messagingPlan?.disabledChannels).toEqual(["telegram"]);
    expect(loaded.messagingPlan?.channels[0]).toMatchObject({
      channelId: "telegram",
      active: false,
      disabled: true,
    });
  });

  it("filterSafeUpdates passes through messagingPlan and accepts explicit null clear", () => {
    session.saveSession(session.createSession());
    const plan = makeMessagingPlan("my-assistant", ["discord"]);
    session.markStepComplete("provider_selection", { messagingPlan: plan });
    expect(requireLoadedSession(session.loadSession()).messagingPlan).toEqual(plan);

    session.markStepComplete("provider_selection", { messagingPlan: null });
    expect(requireLoadedSession(session.loadSession()).messagingPlan).toBeNull();
  });

  it("defaults messagingPlan to null for fresh sessions", () => {
    const fresh = session.createSession();
    expect(fresh.messagingPlan).toBeNull();
  });

  it("#1737: persists telegramConfig across save/load roundtrips (requireMention=true)", () => {
    const created = session.createSession();
    created.telegramConfig = { requireMention: true };
    session.saveSession(created);

    const loaded = session.loadSession()!;
    expect(loaded.telegramConfig).toEqual({ requireMention: true });
  });

  it("#1737: persists telegramConfig across save/load roundtrips (requireMention=false)", () => {
    const created = session.createSession();
    created.telegramConfig = { requireMention: false };
    session.saveSession(created);

    const loaded = session.loadSession()!;
    expect(loaded.telegramConfig).toEqual({ requireMention: false });
  });

  it("#1737: rejects malformed telegramConfig on load", () => {
    // Simulate a hand-edited session file with garbage in telegramConfig.
    // Going through saveSession() would re-normalize the value before it
    // hits disk, so write raw JSON directly to exercise the load-time
    // parseTelegramConfig() path.
    const seed = session.createSession();
    session.saveSession(seed);
    const onDisk = JSON.parse(fs.readFileSync(session.SESSION_FILE, "utf-8"));
    onDisk.telegramConfig = { requireMention: "yes" };
    fs.writeFileSync(session.SESSION_FILE, JSON.stringify(onDisk));

    const loaded = session.loadSession()!;
    expect(loaded.telegramConfig).toBeNull();
  });

  it("#1737: defaults telegramConfig to null for fresh sessions", () => {
    const fresh = session.createSession();
    expect(fresh.telegramConfig).toBeNull();
  });

  it("persists wechatConfig across save/load roundtrips", () => {
    // wechatConfig captures the host-side QR handshake result. Persisting it
    // is what lets a later `nemoclaw onboard` resume detect IDC-baseUrl
    // drift and force a sandbox recreate (see onboard.ts wechatConfigChanged).
    const created = session.createSession();
    created.wechatConfig = {
      accountId: "ilink-bot-42",
      baseUrl: "https://ilinkai.wechat.com",
      userId: "user-42",
    };
    session.saveSession(created);

    const loaded = session.loadSession()!;
    expect(loaded.wechatConfig).toEqual({
      accountId: "ilink-bot-42",
      baseUrl: "https://ilinkai.wechat.com",
      userId: "user-42",
    });
  });

  it("rejects malformed wechatConfig on load and falls back to null", () => {
    // Hand-edited session — non-string fields should be discarded rather than
    // round-tripped through to consumers that expect strings.
    const seed = session.createSession();
    session.saveSession(seed);
    const onDisk = JSON.parse(fs.readFileSync(session.SESSION_FILE, "utf-8"));
    onDisk.wechatConfig = { accountId: 7, baseUrl: { nested: true }, userId: null };
    fs.writeFileSync(session.SESSION_FILE, JSON.stringify(onDisk));

    const loaded = session.loadSession()!;
    expect(loaded.wechatConfig).toBeNull();
  });

  it("keeps wechatConfig partial when only some fields are present", () => {
    // The QR handshake currently always produces all three fields, but the
    // type allows partial — e.g. a future flow where userId is opted-out.
    const created = session.createSession();
    created.wechatConfig = { accountId: "primary" };
    session.saveSession(created);
    const loaded = session.loadSession()!;
    expect(loaded.wechatConfig).toEqual({ accountId: "primary" });
  });

  it("defaults wechatConfig to null for fresh sessions", () => {
    const fresh = session.createSession();
    expect(fresh.wechatConfig).toBeNull();
  });

  it("persists and clears web search config through safe session updates", () => {
    session.saveSession(session.createSession());
    session.markStepComplete("provider_selection", {
      webSearchConfig: { fetchEnabled: true },
    });

    let loaded = requireLoadedSession(session.loadSession());
    expect(loaded.webSearchConfig).toEqual({ fetchEnabled: true });

    session.completeSession({ webSearchConfig: null });
    loaded = requireLoadedSession(session.loadSession());
    expect(loaded.webSearchConfig).toBeNull();
  });

  it("does not clear existing metadata when updates omit whitelisted metadata fields", () => {
    session.saveSession(
      session.createSession({ metadata: { gatewayName: "nemoclaw", fromDockerfile: null } }),
    );
    const unsafeMetadataUpdate: Parameters<OnboardSessionModule["markStepComplete"]>[1] & {
      metadata: { token: string };
    } = {
      metadata: {
        token: "should-not-persist",
      },
    };
    session.markStepComplete("provider_selection", unsafeMetadataUpdate);

    const loaded = requireLoadedSession(session.loadSession());
    expect(loaded.metadata.gatewayName).toBe("nemoclaw");
    expect("token" in loaded.metadata).toBe(false);
  });

  it("drops non-string gatewayName during normalization", () => {
    fs.mkdirSync(path.dirname(session.SESSION_FILE), { recursive: true });
    fs.writeFileSync(
      session.SESSION_FILE,
      JSON.stringify({ version: 1, metadata: { gatewayName: 123 } }),
    );
    const loaded = requireLoadedSession(session.loadSession());
    expect(loaded.metadata.gatewayName).toBe("nemoclaw");
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

  it("replaces a stale onboard lock when the recorded PID was reused by another process", () => {
    fs.mkdirSync(path.dirname(session.LOCK_FILE), { recursive: true });
    const reusedPid = 424242;
    fs.writeFileSync(
      session.LOCK_FILE,
      JSON.stringify({
        pid: reusedPid,
        startedAt: "1970-01-01T00:20:00.000Z",
        command: "nemoclaw onboard",
      }),
      { mode: 0o600 },
    );

    const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
    const originalReadFileSync = fs.readFileSync;
    const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation(((file, options) => {
      const fileName = String(file);
      if (fileName === `/proc/${reusedPid}/stat`) {
        const fieldsAfterComm = Array.from({ length: 50 }, (_, index) => {
          if (index === 0) return "S";
          if (index === 19) return "23000";
          return "0";
        }).join(" ");
        return `${reusedPid} (node) ${fieldsAfterComm}`;
      }
      if (fileName === "/proc/stat") {
        return "cpu  1 2 3 4\nbtime 1000\n";
      }
      return originalReadFileSync(file, options);
    }) as typeof fs.readFileSync);

    try {
      const acquired = session.acquireOnboardLock("nemoclaw onboard --resume");
      expect(acquired.acquired).toBe(true);

      const written = JSON.parse(fs.readFileSync(session.LOCK_FILE, "utf8"));
      expect(written.pid).toBe(process.pid);
    } finally {
      readSpy.mockRestore();
      killSpy.mockRestore();
      session.releaseOnboardLock();
    }
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
    //    - stat #1 (inside unlinkIfInodeMatches): BEFORE the actual
    //      stat, swap the file for a fresh claim. stat #1 then sees
    //      a different inode → must skip the unlink.
    //
    //    CodeRabbit correctly flagged the original test: swapping on
    //    stat #1 caused readFileSync to see the live PID and exit
    //    via isProcessAlive, never reaching unlinkIfInodeMatches.
    let statCallCount = 0;
    const originalStatSync = fs.statSync;
    const statSpy = vi.spyOn(fs, "statSync").mockImplementation((...args) => {
      statCallCount += 1;
      // Just before stat #1 (inside unlinkIfInodeMatches), simulate
      // the race: a concurrent fast process unlinks the stale lock
      // and writes a fresh claim. stat #1 then sees a new inode.
      if (statCallCount === 1) {
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
      return originalStatSync(...args);
    });

    try {
      // The acquire call will see EEXIST (stale lock present), read it
      // through a pinned descriptor, then the stat inside the cleanup
      // helper sees a different inode → must NOT unlink.
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
      statSpy.mockRestore();
    }
  });

  it("treats recent malformed lock as transient and does not remove it", () => {
    fs.mkdirSync(path.dirname(session.LOCK_FILE), { recursive: true });
    // Write a malformed lock with the current timestamp (< 30 s old).
    fs.writeFileSync(session.LOCK_FILE, "{not-json", { mode: 0o600 });

    const acquired = session.acquireOnboardLock("nemoclaw onboard --resume");
    expect(acquired.acquired).toBe(false);
    expect(acquired.stale).toBe(true);
    // Recent malformed lock is preserved because another process may be mid-write.
    expect(fs.existsSync(session.LOCK_FILE)).toBe(true);
  });

  it("removes a stale malformed lock file older than 30 seconds (#2765)", () => {
    fs.mkdirSync(path.dirname(session.LOCK_FILE), { recursive: true });
    fs.writeFileSync(session.LOCK_FILE, "{not-json", { mode: 0o600 });
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(session.LOCK_FILE, past, past);

    const acquired = session.acquireOnboardLock("nemoclaw onboard --resume");
    expect(acquired.acquired).toBe(true);
    expect(fs.existsSync(session.LOCK_FILE)).toBe(true);
    const written = JSON.parse(fs.readFileSync(session.LOCK_FILE, "utf8"));
    expect(written.pid).toBe(process.pid);
    session.releaseOnboardLock();
  });

  it("does not remove a fresh lock that replaces stale malformed lock debris during cleanup", () => {
    fs.mkdirSync(path.dirname(session.LOCK_FILE), { recursive: true });
    fs.writeFileSync(session.LOCK_FILE, "{not-json", { mode: 0o600 });
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(session.LOCK_FILE, past, past);

    let statCallCount = 0;
    const originalStatSync = fs.statSync;
    const statSpy = vi.spyOn(fs, "statSync").mockImplementation((...args) => {
      if (args[0] === session.LOCK_FILE) {
        statCallCount += 1;
        if (statCallCount === 1) {
          const tmpClaim = session.LOCK_FILE + ".race-tmp";
          fs.writeFileSync(
            tmpClaim,
            JSON.stringify({
              pid: process.pid,
              startedAt: new Date().toISOString(),
              command: "nemoclaw onboard (fresh malformed-cleanup race claimant)",
            }),
            { mode: 0o600 },
          );
          fs.renameSync(tmpClaim, session.LOCK_FILE);
        }
      }
      return originalStatSync(...args);
    });

    try {
      const acquired = session.acquireOnboardLock("nemoclaw onboard --resume");
      expect(acquired.acquired).toBe(false);
      expect(acquired.holderPid).toBe(process.pid);
      const onDisk = JSON.parse(fs.readFileSync(session.LOCK_FILE, "utf8"));
      expect(onDisk.command).toContain("fresh malformed-cleanup race claimant");
    } finally {
      statSpy.mockRestore();
    }
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

    const loaded = requireLoadedSession(session.loadSession());
    expect(loaded.steps.inference.error).toContain("NVIDIA_API_KEY=<REDACTED>");
    expect(loaded.steps.inference.error).toContain("Bearer <REDACTED>");
    expect(loaded.steps.inference.error).not.toContain("nvapi-secret");
    expect(loaded.steps.inference.error).not.toContain("topsecret");
    expect(loaded.steps.inference.error).not.toContain("sk-secret-value-that-is-long-enough");
    expect(loaded.steps.inference.error).not.toContain("ghp_1234567890123456789012345");
    expect(loaded.failure).not.toBeNull();
    if (!loaded.failure) {
      throw new Error("Expected failure metadata after markStepFailed()");
    }
    expect(loaded.failure.message).toBe(loaded.steps.inference.error);
  });

  it("round-trips null messagingPlan through normalizeSession", () => {
    const created = session.createSession();
    expect(created.messagingPlan).toBeNull();
    const saved = session.saveSession(created);
    const loaded = requireLoadedSession(session.loadSession());
    expect(saved.messagingPlan).toBeNull();
    expect(loaded.messagingPlan).toBeNull();
  });

  it("round-trips messagingPlan through normalizeSession", () => {
    const plan = makeMessagingPlan("my-assistant", ["telegram"]);
    const created = session.createSession({ messagingPlan: plan });
    expect(created.messagingPlan).toEqual(plan);
    const saved = session.saveSession(created);
    const loaded = requireLoadedSession(session.loadSession());
    expect(saved.messagingPlan).toEqual(plan);
    expect(loaded.messagingPlan).toEqual(plan);
  });

  it("filterSafeUpdates preserves messagingPlan field", () => {
    session.saveSession(session.createSession());
    const plan = makeMessagingPlan("my-assistant", ["slack", "discord"]);
    session.markStepComplete("provider_selection", {
      messagingPlan: plan,
    });

    const loaded = requireLoadedSession(session.loadSession());
    expect(loaded.messagingPlan).toEqual(plan);
  });

  it("filterSafeUpdates ignores malformed messagingPlan values", () => {
    session.saveSession(session.createSession());
    session.markStepComplete("provider_selection", {
      messagingPlan: { sandboxName: "my-assistant" },
    } as unknown as Parameters<OnboardSessionModule["markStepComplete"]>[1]);

    const loaded = requireLoadedSession(session.loadSession());
    expect(loaded.messagingPlan).toBeNull();
  });

  it("#1737: filterSafeUpdates routes telegramConfig through markStepComplete", () => {
    session.saveSession(session.createSession());
    session.markStepComplete("provider_selection", {
      telegramConfig: { requireMention: true },
    });

    const loaded = session.loadSession()!;
    expect(loaded.telegramConfig).toEqual({ requireMention: true });

    // Explicit null (clearing the field) should also round-trip.
    session.markStepComplete("provider_selection", { telegramConfig: null });
    const cleared = session.loadSession()!;
    expect(cleared.telegramConfig).toBeNull();
  });

  it("#1737: filterSafeUpdates drops malformed telegramConfig values", () => {
    session.saveSession(session.createSession());
    // Non-boolean requireMention — must not leak through.
    session.markStepComplete("provider_selection", {
      telegramConfig: { requireMention: "yes" } as unknown as { requireMention: boolean },
    });

    const loaded = session.loadSession()!;
    expect(loaded.telegramConfig).toBeNull();
  });

  it("filterSafeUpdates routes wechatConfig through markStepComplete", () => {
    session.saveSession(session.createSession());
    session.markStepComplete("provider_selection", {
      wechatConfig: { accountId: "primary", baseUrl: "https://x", userId: "u" },
    });

    const loaded = session.loadSession()!;
    expect(loaded.wechatConfig).toEqual({
      accountId: "primary",
      baseUrl: "https://x",
      userId: "u",
    });

    // Explicit null clears the field (used when WeChat is removed from the
    // enabled channels on a subsequent onboard).
    session.markStepComplete("provider_selection", { wechatConfig: null });
    const cleared = session.loadSession()!;
    expect(cleared.wechatConfig).toBeNull();
  });

  it("filterSafeUpdates drops malformed wechatConfig values", () => {
    session.saveSession(session.createSession());
    session.markStepComplete("provider_selection", {
      wechatConfig: { accountId: 9000 } as unknown as { accountId: string },
    });

    const loaded = session.loadSession()!;
    expect(loaded.wechatConfig).toBeNull();
  });

  it("createSession with messagingPlan override", () => {
    const plan = makeMessagingPlan("my-assistant", ["telegram", "slack"]);
    const created = session.createSession({ messagingPlan: plan });
    expect(created.messagingPlan).toEqual(plan);
    expect(created.provider).toBeNull();
  });

  it("filters non-string array entries in createSession overrides", () => {
    const created = session.createSession({
      policyPresets: ["pypi", 7, null, "npm"] as unknown as string[],
    });

    expect(created.policyPresets).toEqual(["pypi", "npm"]);
  });

  it("summarizes the session for debug output", () => {
    session.saveSession(session.createSession({ sandboxName: "my-assistant" }));
    session.markStepStarted("preflight");
    session.markStepComplete("preflight");
    session.completeSession();
    const summary = requireDebugSummary(session.summarizeForDebug());

    expect(summary.sandboxName).toBe("my-assistant");
    expect(summary.steps.preflight.status).toBe("complete");
    expect(summary.steps.preflight.startedAt).toBeTruthy();
    expect(summary.steps.preflight.completedAt).toBeTruthy();
    expect(summary.resumable).toBe(false);
  });

  it("keeps debug summaries redacted when failures were sanitized", () => {
    session.saveSession(session.createSession({ sandboxName: "my-assistant" }));
    session.markStepFailed("provider_selection", "Bearer abcdefghijklmnopqrstuvwxyz");
    const summary = requireDebugSummary(session.summarizeForDebug());

    expect(summary.failure).not.toBeNull();
    if (!summary.failure) {
      throw new Error("Expected failure metadata in debug summary");
    }
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

    const summary = requireDebugSummary(session.summarizeForDebug(rawSession));
    expect(summary.failure).not.toBeNull();
    if (!summary.failure) {
      throw new Error("Expected failure metadata in debug summary");
    }
    expect(summary.failure.message).toContain("Bearer <REDACTED>");
    expect(summary.failure.message).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });
});
