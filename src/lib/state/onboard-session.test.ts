// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeMessagingPlan } from "../../../test/helpers/messaging-plan-fixtures";
import { decisionSelected } from "./onboard-checkpoint-decision";

const require = createRequire(import.meta.url);
const distPath = require.resolve("./onboard-session");
const eventsDistPath = require.resolve("../onboard/machine/events");
const originalHome = process.env.HOME;
type OnboardSessionModule = typeof import("./onboard-session");
type OnboardMachineEventsModule = typeof import("../onboard/machine/events");
type OnboardMachineEvent = import("../onboard/machine/events").OnboardMachineEvent;
type LoadedSession = NonNullable<ReturnType<OnboardSessionModule["loadSession"]>>;
type DebugSummary = NonNullable<ReturnType<OnboardSessionModule["summarizeForDebug"]>>;
type NullableSessionUpdateKey = import("./onboard-session").NullableSessionUpdateKey;
let session: OnboardSessionModule;
let machineEvents: OnboardMachineEventsModule;
let tmpDir: string;

const _nullableSessionUpdateKeyAcceptsNullableFields: Record<
  Extract<"model" | "credentialEnv" | "webSearchConfig", NullableSessionUpdateKey>,
  true
> = {
  model: true,
  credentialEnv: true,
  webSearchConfig: true,
};
const _nullableSessionUpdateKeyRejectsNonNullableFields: Record<
  Extract<"status" | "gpuPassthrough" | "metadata", NullableSessionUpdateKey>,
  never
> = {};
void _nullableSessionUpdateKeyAcceptsNullableFields;
void _nullableSessionUpdateKeyRejectsNonNullableFields;

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

beforeEach(() => {
  // Recreate tmpDir per test so lock artifacts (and any other on-disk state)
  // from a previous test cannot leak into this one. Without this, malformed
  // lock files left behind by releaseOnboardLock() make lock tests
  // order-dependent. See issue #1284.
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-session-"));
  process.env.HOME = tmpDir;
  delete require.cache[distPath];
  delete require.cache[eventsDistPath];
  session = require("./onboard-session");
  machineEvents = require("../onboard/machine/events");
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
    expect(saved.toolDisclosure).toBe("progressive");
    expect(saved.observabilityEnabled).toBe(false);
    expect(saved.observabilityRequestedExplicitly).toBe(false);
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

  it("refuses malformed persisted APF compatibility selection without replacing it (#9833)", () => {
    session.saveSession(session.createSession({ apfInterceptorRequested: true }));
    const malformed = JSON.parse(fs.readFileSync(session.SESSION_FILE, "utf8"));
    malformed.apfInterceptorRequested = "true";
    fs.writeFileSync(session.SESSION_FILE, JSON.stringify(malformed), { mode: 0o600 });
    const refusal = /saved APF selection is invalid/u;
    expect(() => session.loadSession()).toThrow(refusal);
    expect(fs.readFileSync(session.SESSION_FILE, "utf8")).toContain(
      '"apfInterceptorRequested":"true"',
    );
  });

  it.each([
    true,
    false,
  ])("persists explicit observability intent when enabled=$enabled", (observabilityEnabled) => {
    session.saveSession(
      session.createSession({
        observabilityEnabled,
        observabilityRequestedExplicitly: true,
      }),
    );
    const loaded = requireLoadedSession(session.loadSession());
    const summary = requireDebugSummary(session.summarizeForDebug());

    expect(loaded.observabilityEnabled).toBe(observabilityEnabled);
    expect(loaded.observabilityRequestedExplicitly).toBe(true);
    expect(summary.observabilityEnabled).toBe(observabilityEnabled);
    expect(summary.observabilityRequestedExplicitly).toBe(true);
  });

  it("defaults legacy observability intent and provenance off", () => {
    const legacy = session.createSession() as unknown as Record<string, unknown>;
    delete legacy.observabilityEnabled;
    delete legacy.observabilityRequestedExplicitly;
    const normalized = requireLoadedSession(session.normalizeSession(legacy as never));

    expect(normalized.observabilityEnabled).toBe(false);
    expect(normalized.observabilityRequestedExplicitly).toBe(false);
  });

  it("persists serving profile provenance while accepting legacy sessions (#8246)", () => {
    const provenance = {
      schemaVersion: 1,
      catalogDigest: `sha256:${"1".repeat(64)}`,
      preset: {
        id: "vllm.dgx-spark-gb10.single.example",
        digest: `sha256:${"2".repeat(64)}`,
        displayName: "Example profile",
        supportState: "experimental",
      },
      recipe: {
        id: "vllm.dgx-spark-gb10.single.example",
        digest: `sha256:${"3".repeat(64)}`,
        backend: "vllm",
      },
      model: { id: "example/model", revision: "revision-1" },
      runtimeImage: `example.invalid/vllm@sha256:${"4".repeat(64)}`,
      estimatedImageDownloadBytes: 10,
      estimatedModelDownloadBytes: 20,
    } as const;
    session.saveSession(session.createSession({ servingProfileProvenance: provenance }));

    expect(requireLoadedSession(session.loadSession()).servingProfileProvenance).toEqual(
      provenance,
    );
    expect(requireDebugSummary(session.summarizeForDebug()).servingProfileProvenance).toEqual(
      provenance,
    );

    const legacy = session.createSession() as unknown as Record<string, unknown>;
    delete legacy.servingProfileProvenance;
    expect(
      requireLoadedSession(session.normalizeSession(legacy as never)).servingProfileProvenance,
    ).toBeNull();
  });

  it("fails closed on malformed persisted serving profile provenance (#8246)", () => {
    const malformed = session.createSession() as unknown as Record<string, unknown>;
    malformed.servingProfileProvenance = { schemaVersion: 1, catalogDigest: "latest" };
    expect(session.normalizeSession(malformed as never)).toBeNull();
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

  it("clears a spark Express intent once provider selection completes (#7231)", () => {
    session.saveSession(
      session.createSession({
        mode: "non-interactive",
        stationExpressIntent: { version: 1, kind: "spark", sandboxName: "my-assistant" },
      }),
    );
    session.markStepComplete("provider_selection", {
      provider: "vllm-local",
      model: "nvidia/Qwen3.6-35B-A3B-NVFP4",
      sandboxName: "my-assistant",
    });

    const loaded = requireLoadedSession(session.loadSession());
    expect(loaded.stationExpressIntent).toBeNull();
    expect(loaded.provider).toBe("vllm-local");
  });

  it("records step status without changing machine or terminal status", () => {
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
    expect(loaded.steps.sandbox.error).toBe("Sandbox creation failed");
    expect(loaded.failure).toBeNull();
    expect(loaded.status).toBe("in_progress");
    expect(loaded.machine).toMatchObject({ state: "init", revision: 0 });
  });

  it("clears provider selection authority when a review is rejected", () => {
    session.saveSession(
      session.createSession({
        provider: "ollama-local",
        model: "qwen3.5:9b",
        endpointUrl: "http://127.0.0.1:11435/v1",
        credentialEnv: "NEMOCLAW_OLLAMA_PROXY_TOKEN",
        sandboxName: "rejected-review",
        sandboxPromptProgress: {
          sandboxName: true,
          webSearch: false,
          messaging: false,
          resourceProfile: false,
        },
      }),
    );
    session.markStepStarted("provider_selection");
    session.updateSession((current) => {
      current.checkpoint = {
        schemaVersion: 4,
        profile: { kind: "selected", value: "default" },
        runtimeAuthority: { kind: "unset" },
        sessionId: current.sessionId,
        machineState: "init",
        updatedAt: new Date().toISOString(),
        sandboxIdentity: decisionSelected({ name: "rejected-review", agent: "openclaw" }),
        webSearch: { kind: "unset" },
        messaging: { kind: "unset" },
        resourceProfile: { kind: "unset" },
        gatewayAuthority: { kind: "unset" },
        effectGroups: {},
        bindings: { credentialEnvs: [], registeredProviders: [] },
        sandboxRecreate: null,
      };
      return current;
    });

    const rejected = session.markStepRejected("provider_selection");

    expect(rejected).toMatchObject({
      provider: null,
      model: null,
      endpointUrl: null,
      credentialEnv: null,
      sandboxName: null,
      sandboxPromptProgress: { sandboxName: false },
      lastStepStarted: null,
      resumable: false,
      status: "failed",
      failure: null,
      steps: { provider_selection: { status: "skipped" } },
      checkpoint: { sandboxIdentity: { kind: "unset" } },
    });
  });

  it("can record step boundaries without mutating the machine snapshot", () => {
    const emitted: OnboardMachineEvent[] = [];
    machineEvents.addOnboardMachineEventListener((event) => emitted.push(event));
    session.saveSession(session.createSession());

    session.markStepStarted("preflight");
    let loaded = requireLoadedSession(session.loadSession());
    expect(loaded.steps.preflight.status).toBe("in_progress");
    expect(loaded.status).toBe("in_progress");
    expect(loaded.machine).toMatchObject({ state: "init", revision: 0 });

    session.markStepComplete("preflight", { sandboxName: "my-assistant" });
    loaded = requireLoadedSession(session.loadSession());
    expect(loaded.steps.preflight.status).toBe("complete");
    expect(loaded.sandboxName).toBe("my-assistant");
    expect(loaded.machine).toMatchObject({ state: "init", revision: 0 });

    session.markStepFailed("gateway", "Gateway failed");
    loaded = requireLoadedSession(session.loadSession());
    expect(loaded.steps.gateway.status).toBe("failed");
    expect(loaded.status).toBe("in_progress");
    expect(loaded.failure).toBeNull();
    expect(loaded.machine).toMatchObject({ state: "init", revision: 0 });
    expect(emitted).toEqual([]);
  });

  it("leaves machine transition ownership outside step helpers", () => {
    session.saveSession(session.createSession());
    let loaded = requireLoadedSession(session.loadSession());
    expect(loaded.machine).toMatchObject({ state: "init", revision: 0 });

    session.markStepStarted("preflight");
    loaded = requireLoadedSession(session.loadSession());
    expect(loaded.machine).toMatchObject({ state: "init", revision: 0 });

    session.markStepComplete("preflight");
    loaded = requireLoadedSession(session.loadSession());
    expect(loaded.machine).toMatchObject({ state: "init", revision: 0 });

    session.markStepComplete("gateway");
    loaded = requireLoadedSession(session.loadSession());
    expect(loaded.machine).toMatchObject({ state: "init", revision: 0 });
    expect(requireDebugSummary(session.summarizeForDebug()).machine).toEqual(loaded.machine);
  });

  it("does not emit machine events for direct step mutations", () => {
    const emitted: OnboardMachineEvent[] = [];
    machineEvents.addOnboardMachineEventListener((event) => emitted.push(event));

    session.saveSession(session.createSession({ sessionId: "session-1" }));
    session.markStepStarted("gateway");
    session.markStepComplete("gateway", {
      sandboxName: "my-assistant",
      endpointUrl:
        "https://alice:super-secret-token@example.com/v1?token=super-secret-token&keep=yes#token=super-secret-token",
      credentialEnv: "NVIDIA_INFERENCE_API_KEY",
    });
    session.markStepSkipped("openclaw");
    session.markStepFailed("sandbox", "NVIDIA_INFERENCE_API_KEY=super-secret-token");

    expect(emitted).toEqual([]);

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

    expect(emitted.map((event) => event.type)).toEqual(["onboard.completed"]);
    expect(emitted).toHaveLength(1);
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
      credentialEnv: "NVIDIA_INFERENCE_API_KEY",
      preferredInferenceApi: "openai-completions",
      compatibleEndpointReasoning: "true",
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
    expect(loaded.credentialEnv).toBe("NVIDIA_INFERENCE_API_KEY");
    expect(loaded.preferredInferenceApi).toBe("openai-completions");
    expect(loaded.compatibleEndpointReasoning).toBe("true");
    expect(loaded.nimContainer).toBe("nim-123");
    expect(loaded.policyPresets).toEqual(["pypi", "npm"]);
    expect(requireDebugSummary(session.summarizeForDebug()).compatibleEndpointReasoning).toBe(
      "true",
    );
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

  it("clears credentialEnv when a provider-selection update passes null (#2625)", () => {
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

  // Session secret boundary from #6225. Endpoint query coverage for #6224
  // lives in onboard-session-redaction.test.ts.

  it("round-trips writer-shaped legacy migration hashes and drops non-string entries (#6225)", () => {
    // Digest shape mirrors legacyValueHash() in src/lib/onboard.ts, the only
    // production writer of this map. This test covers session filtering and
    // persistence; the writer owns converting credential values to digests.
    const legacyValue = "nvapi-sentinel6225-legacy-value-do-not-persist";
    const digest = createHash("sha256").update(legacyValue).digest("hex");
    session.saveSession(session.createSession());
    expect(
      JSON.parse(fs.readFileSync(session.SESSION_FILE, "utf8")).migratedLegacyValueHashes,
    ).toBeNull();

    session.markStepComplete("provider_selection", {
      migratedLegacyValueHashes: {
        NVIDIA_API_KEY: digest,
        BROKEN_NUMERIC: 123,
        BROKEN_NULL: null,
      } as unknown as Record<string, string>,
    });

    const raw = fs.readFileSync(session.SESSION_FILE, "utf8");
    expect(raw).toContain(digest);
    expect(raw).not.toContain("BROKEN_NUMERIC");
    const loaded = requireLoadedSession(session.loadSession());
    expect(loaded.migratedLegacyValueHashes).toEqual({ NVIDIA_API_KEY: digest });
    expect(loaded.migratedLegacyValueHashes?.NVIDIA_API_KEY).toMatch(/^[0-9a-f]{64}$/);
  });

  it("serializes missing and explicit-null credentialEnv identically (#6228)", () => {
    // #6228 contract gap: the schema cannot distinguish "never prompted",
    // "user declined", and "explicitly cleared" once they become null.
    session.saveSession(session.createSession());
    const unset = JSON.parse(fs.readFileSync(session.SESSION_FILE, "utf8")).credentialEnv;

    session.markStepComplete("provider_selection", {
      credentialEnv: "NVIDIA_INFERENCE_API_KEY",
    });
    session.markStepComplete("provider_selection", { credentialEnv: null });
    const declined = JSON.parse(fs.readFileSync(session.SESSION_FILE, "utf8")).credentialEnv;

    expect(unset).toBeNull();
    expect(declined).toBeNull();
    expect(declined).toBe(unset);
    expect(requireLoadedSession(session.loadSession()).credentialEnv).toBeNull();
  });

  // Focused endpoint secret-persistence coverage lives in onboard-session-redaction.test.ts.

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

  it("classifies nullable string update intent explicitly", () => {
    const unchanged = session.getNullableStringUpdateIntent(undefined);
    const malformed = session.getNullableStringUpdateIntent(42);
    const clear = session.getNullableStringUpdateIntent(null);
    const normalizedClear = session.getNullableStringUpdateIntent(
      "https://secret.example",
      () => null,
    );
    const set = session.getNullableStringUpdateIntent("model");

    expect(unchanged).toEqual({ kind: "unchanged" });
    expect(malformed).toEqual({ kind: "unchanged" });
    expect(clear).toEqual({ kind: "clear" });
    expect(normalizedClear).toEqual({ kind: "clear" });
    expect(set).toEqual({ kind: "set", value: "model" });
    expect(session.hasSessionUpdateValue(unchanged)).toBe(false);
    expect(session.hasSessionUpdateValue(clear)).toBe(true);
    expect(session.isSessionUpdateClear(clear)).toBe(true);
    expect(session.isSessionUpdateClear(set)).toBe(false);
  });

  it("applies nullable session update intent to safe updates", () => {
    const safe: Partial<LoadedSession> = {};

    session.applyNullableSessionUpdate(
      safe,
      "model",
      session.getNullableStringUpdateIntent("model-a"),
    );
    session.applyNullableSessionUpdate(
      safe,
      "credentialEnv",
      session.getNullableStringUpdateIntent(null),
    );
    session.applyNullableSessionUpdate(
      safe,
      "provider",
      session.getNullableStringUpdateIntent(undefined),
    );

    expect(safe).toEqual({ model: "model-a", credentialEnv: null });
  });

  it("accepts null as an explicit clear for every nullable string field", () => {
    // All nullable fields that travel through filterSafeUpdates must
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
      compatibleEndpointReasoning: "true",
      nimContainer: "nim-abc",
    });

    session.markStepComplete("provider_selection", {
      sandboxName: null,
      provider: null,
      model: null,
      endpointUrl: null,
      credentialEnv: null,
      preferredInferenceApi: null,
      compatibleEndpointReasoning: null,
      nimContainer: null,
    });

    const loaded = requireLoadedSession(session.loadSession());
    expect(loaded.sandboxName).toBeNull();
    expect(loaded.provider).toBeNull();
    expect(loaded.model).toBeNull();
    expect(loaded.endpointUrl).toBeNull();
    expect(loaded.credentialEnv).toBeNull();
    expect(loaded.preferredInferenceApi).toBeNull();
    expect(loaded.compatibleEndpointReasoning).toBeNull();
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
    created.messagingPlan = makeMessagingPlan({
      channels: ["telegram", "slack"],
      disabledChannels: ["slack"],
    });
    session.saveSession(created);

    const loaded = requireLoadedSession(session.loadSession());
    expect(loaded.messagingPlan).toMatchObject({
      schemaVersion: 1,
      sandboxName: "my-assistant",
      agent: "openclaw",
      workflow: "onboard",
      disabledChannels: ["slack"],
      channels: [
        expect.objectContaining({ channelId: "telegram", configured: true, disabled: false }),
        expect.objectContaining({ channelId: "slack", configured: true, disabled: true }),
      ],
    });
    expect(loaded.messagingPlan?.channels[0]?.inputs.map((input) => input.inputId)).toContain(
      "botToken",
    );
  });

  it("writes compact messagingPlan derived fields to onboard-session.json", () => {
    const created = session.createSession();
    created.messagingPlan = {
      ...makeMessagingPlan({ channels: ["telegram"] }),
      channels: [
        {
          ...makeMessagingPlan({ channels: ["telegram"] }).channels[0],
          hooks: [
            {
              channelId: "telegram",
              id: "telegram-token-paste",
              phase: "enroll",
              handler: "common.tokenPaste",
            },
          ],
        },
      ],
      agentRender: [
        {
          channelId: "telegram",
          renderId: "telegram-openclaw-channel",
          hookId: "telegram-openclaw-channel",
          handler: "common.staticOutputs",
          kind: "json-fragment",
          agent: "openclaw",
          target: "openclaw.json",
          path: "channels.telegram",
          value: { enabled: true },
          templateRefs: [],
        },
      ],
    };

    session.saveSession(created);

    const raw = JSON.parse(fs.readFileSync(session.SESSION_FILE, "utf-8"));
    expect(raw.messagingPlan.networkPolicy).toEqual({ presets: [], entries: [] });
    expect(raw.messagingPlan.agentRender).toBeUndefined();
    expect(raw.messagingPlan.buildSteps).toBeUndefined();
    expect(raw.messagingPlan.runtimeSetup).toBeUndefined();
    expect(raw.messagingPlan.stateUpdates).toBeUndefined();
    expect(raw.messagingPlan.healthChecks).toBeUndefined();
    expect(raw.messagingPlan.channels[0].displayName).toBeUndefined();
    expect(raw.messagingPlan.channels[0].authMode).toBeUndefined();
    expect(raw.messagingPlan.channels[0].active).toBe(true);
    expect(raw.messagingPlan.channels[0].selected).toBeUndefined();
    expect(raw.messagingPlan.channels[0].hooks).toBeUndefined();
    const reloadedPlan = requireLoadedSession(session.loadSession()).messagingPlan;
    expect(reloadedPlan?.agentRender).toEqual([]);
    expect(reloadedPlan?.channels[0]?.hooks).toEqual([]);
  });

  it("drops malformed persisted messagingPlan on load", () => {
    const created = session.createSession();
    fs.mkdirSync(path.dirname(session.SESSION_FILE), { recursive: true });
    fs.writeFileSync(
      session.SESSION_FILE,
      JSON.stringify({
        ...created,
        messagingPlan: {
          ...makeMessagingPlan({ channels: ["telegram"] }),
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
    created.messagingPlan = makeMessagingPlan({
      channels: ["telegram"],
      disabledChannels: ["telegram"],
    });
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
    const plan = makeMessagingPlan({ channels: ["discord"] });
    session.markStepComplete("provider_selection", { messagingPlan: plan });
    expect(requireLoadedSession(session.loadSession()).messagingPlan).toMatchObject({
      sandboxName: "my-assistant",
      channels: [expect.objectContaining({ channelId: "discord", configured: true })],
    });

    session.markStepComplete("provider_selection", { messagingPlan: null });
    expect(requireLoadedSession(session.loadSession()).messagingPlan).toBeNull();
  });

  it("defaults messagingPlan to null for fresh sessions", () => {
    const fresh = session.createSession();
    expect(fresh.messagingPlan).toBeNull();
  });

  it("persists telegramConfig across save/load roundtrips with requireMention=true (#1737)", () => {
    const created = session.createSession();
    created.telegramConfig = { requireMention: true };
    session.saveSession(created);

    const loaded = session.loadSession()!;
    expect(loaded.telegramConfig).toEqual({ requireMention: true });
  });

  it("persists telegramConfig across save/load roundtrips with requireMention=false (#1737)", () => {
    const created = session.createSession();
    created.telegramConfig = { requireMention: false };
    session.saveSession(created);

    const loaded = session.loadSession()!;
    expect(loaded.telegramConfig).toEqual({ requireMention: false });
  });

  it("rejects malformed telegramConfig on load (#1737)", () => {
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

  it("defaults telegramConfig to null for fresh sessions (#1737)", () => {
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
    expect(loaded.webSearchConfig).toEqual({ fetchEnabled: true, provider: "brave" });

    session.completeSession({ webSearchConfig: null });
    loaded = requireLoadedSession(session.loadSession());
    expect(loaded.webSearchConfig).toBeNull();
  });

  it("round-trips an explicit Tavily web search provider", () => {
    session.saveSession(
      session.createSession({
        webSearchConfig: { fetchEnabled: true, provider: "tavily" },
      }),
    );

    expect(requireLoadedSession(session.loadSession()).webSearchConfig).toEqual({
      fetchEnabled: true,
      provider: "tavily",
    });
  });

  it("migrates provider-less enabled web search state to Brave when loading", () => {
    session.saveSession(session.createSession());
    const persisted = JSON.parse(fs.readFileSync(session.SESSION_FILE, "utf8"));
    persisted.webSearchConfig = { fetchEnabled: true };
    fs.writeFileSync(session.SESSION_FILE, JSON.stringify(persisted));

    expect(requireLoadedSession(session.loadSession()).webSearchConfig).toEqual({
      fetchEnabled: true,
      provider: "brave",
    });
  });

  it("fails closed for an invalid persisted web search provider", () => {
    session.saveSession(session.createSession());
    const persisted = JSON.parse(fs.readFileSync(session.SESSION_FILE, "utf8"));
    persisted.webSearchConfig = { fetchEnabled: true, provider: "unexpected" };
    fs.writeFileSync(session.SESSION_FILE, JSON.stringify(persisted));

    expect(requireLoadedSession(session.loadSession()).webSearchConfig).toBeNull();
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

  it("round-trips secret-free read-only host mount metadata", () => {
    const hostMounts = [
      { source: "/srv/project", target: "/sandbox/project", readOnly: true as const },
    ];
    session.saveSession(
      session.createSession({
        metadata: { gatewayName: "nemoclaw", fromDockerfile: null, hostMounts },
      }),
    );

    const loaded = requireLoadedSession(session.loadSession());
    expect(loaded.metadata.hostMounts).toEqual(hostMounts);
    expect(loaded.metadata.hostMounts).not.toBe(hostMounts);
  });

  it("preserves a fail-closed marker for malformed host mount metadata", () => {
    const malformed = session.createSession();
    fs.mkdirSync(path.dirname(session.SESSION_FILE), { recursive: true });
    fs.writeFileSync(
      session.SESSION_FILE,
      JSON.stringify({
        ...malformed,
        metadata: {
          ...malformed.metadata,
          hostMounts: [
            { source: "/srv/project", target: "/sandbox/project", readOnly: true },
            { source: "/srv/private", target: "/sandbox/private", readOnly: false },
          ],
        },
      }),
    );

    const loaded = requireLoadedSession(session.loadSession());
    expect(session.hasInvalidSessionHostMounts(loaded)).toBe(true);
    expect(loaded.metadata.hostMounts).toBeUndefined();
  });

  it("preserves a fail-closed marker for terminal-control host mount metadata", () => {
    const malformed = session.createSession();
    fs.mkdirSync(path.dirname(session.SESSION_FILE), { recursive: true });
    fs.writeFileSync(
      session.SESSION_FILE,
      JSON.stringify({
        ...malformed,
        metadata: {
          ...malformed.metadata,
          hostMounts: [
            {
              source: "/srv/project",
              target: "/sandbox/project\u2028forged",
              readOnly: true,
            },
          ],
        },
      }),
    );

    const loaded = requireLoadedSession(session.loadSession());
    expect(session.hasInvalidSessionHostMounts(loaded)).toBe(true);
    expect(loaded.metadata.hostMounts).toBeUndefined();
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

  it("keeps completed legacy checkpoint sessions readable as status evidence", () => {
    const completed = session.createSession({ sessionId: "legacy-completed" });
    completed.status = "complete";
    completed.resumable = false;
    completed.machine = {
      version: 1,
      state: "complete",
      stateEnteredAt: completed.updatedAt,
      revision: 8,
    };
    const raw = JSON.parse(JSON.stringify(completed)) as Record<string, unknown>;
    raw.checkpoint = { schemaVersion: 3, sessionId: completed.sessionId };
    fs.mkdirSync(path.dirname(session.SESSION_FILE), { recursive: true });
    fs.writeFileSync(session.SESSION_FILE, JSON.stringify(raw, null, 2), { mode: 0o600 });

    const loaded = requireLoadedSession(session.loadSession());
    expect(loaded).toMatchObject({
      sessionId: "legacy-completed",
      status: "complete",
      resumable: false,
      machine: { state: "complete", revision: 8 },
      checkpoint: null,
    });
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

  it("does not unlink a fresh lock claimed by another process during a stale-cleanup race (#1281)", () => {
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
      "provider auth failed with NVIDIA_INFERENCE_API_KEY=nvapi-secret Bearer topsecret sk-secret-value-that-is-long-enough ghp_1234567890123456789012345",
    );

    const loaded = requireLoadedSession(session.loadSession());
    expect(loaded.steps.inference.error).toContain("NVIDIA_INFERENCE_API_KEY=<REDACTED>");
    expect(loaded.steps.inference.error).toContain("Bearer <REDACTED>");
    expect(loaded.steps.inference.error).not.toContain("nvapi-secret");
    expect(loaded.steps.inference.error).not.toContain("topsecret");
    expect(loaded.steps.inference.error).not.toContain("sk-secret-value-that-is-long-enough");
    expect(loaded.steps.inference.error).not.toContain("ghp_1234567890123456789012345");
    expect(loaded.failure).toBeNull();
    expect(loaded.machine).toMatchObject({ state: "init", revision: 0 });
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
    const plan = makeMessagingPlan({ channels: ["telegram"] });
    const created = session.createSession({ messagingPlan: plan });
    expect(created.messagingPlan).toEqual(plan);
    const saved = session.saveSession(created);
    const loaded = requireLoadedSession(session.loadSession());
    expect(saved.messagingPlan).toEqual(plan);
    expect(loaded.messagingPlan).toMatchObject({
      sandboxName: "my-assistant",
      channels: [expect.objectContaining({ channelId: "telegram", configured: true })],
    });
  });

  it("filterSafeUpdates preserves messagingPlan field", () => {
    session.saveSession(session.createSession());
    const plan = makeMessagingPlan({ channels: ["slack", "discord"] });
    session.markStepComplete("provider_selection", {
      messagingPlan: plan,
    });

    const loaded = requireLoadedSession(session.loadSession());
    expect(loaded.messagingPlan).toMatchObject({
      sandboxName: "my-assistant",
      channels: [
        expect.objectContaining({ channelId: "slack", configured: true }),
        expect.objectContaining({ channelId: "discord", configured: true }),
      ],
    });
  });

  it("filterSafeUpdates ignores malformed messagingPlan values", () => {
    session.saveSession(session.createSession());
    session.markStepComplete("provider_selection", {
      messagingPlan: { sandboxName: "my-assistant" },
    } as unknown as Parameters<OnboardSessionModule["markStepComplete"]>[1]);

    const loaded = requireLoadedSession(session.loadSession());
    expect(loaded.messagingPlan).toBeNull();
  });

  it("routes telegramConfig through markStepComplete in filterSafeUpdates (#1737)", () => {
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

  it("drops malformed telegramConfig values in filterSafeUpdates (#1737)", () => {
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

  it("creates a session with a messagingPlan override", () => {
    const plan = makeMessagingPlan({ channels: ["telegram", "slack"] });
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
    session.saveSession(
      session.createSession({
        sandboxName: "my-assistant",
        failure: {
          step: "provider_selection",
          message: "Bearer abcdefghijklmnopqrstuvwxyz",
          recordedAt: "2026-04-01T00:00:00.000Z",
        },
      }),
    );
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
