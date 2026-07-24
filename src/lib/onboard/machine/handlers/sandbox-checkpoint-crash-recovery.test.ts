// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { decisionSelected, decisionUnset } from "../../../state/onboard-checkpoint-decision";
import {
  CHECKPOINT_SCHEMA_VERSION,
  type OnboardCheckpoint,
} from "../../../state/onboard-checkpoint-types";
import { createSession, type Session, type SessionUpdates } from "../../../state/onboard-session";
import {
  type CredentialProviderRegistrationDeps,
  createCredentialProviderRegistration,
} from "../../credential-provider-registration";
import { detectMessagingChannelsFromEnv } from "../../messaging-channel-setup";
import type { MessagingTokenDef } from "../../messaging-prep";
import { handleSandboxState } from "./sandbox";
import { baseOptions, createDeps, makeMinimalPlan } from "./sandbox-test-fixtures";

vi.mock("../../messaging-channel-setup", () => ({
  detectMessagingChannelsFromEnv: vi.fn(() => []),
}));

vi.mocked(detectMessagingChannelsFromEnv).mockReturnValue([]);

function defaultCreateFingerprint(sandboxName = "my-assistant"): string {
  return [
    sandboxName,
    "default",
    "provider",
    "model",
    "openai-completions",
    "",
    JSON.stringify({ sandboxGpuEnabled: false, mode: "0" }),
    "",
  ].join("|");
}

function crashedCheckpoint(overrides: Partial<OnboardCheckpoint> = {}): OnboardCheckpoint {
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    sessionId: "sess-1",
    machineState: "sandbox",
    updatedAt: "2026-01-01T00:00:00.000Z",
    sandboxIdentity: decisionSelected({ name: "my-assistant", agent: "openclaw" }),
    webSearch: decisionUnset(),
    messaging: decisionUnset(),
    resourceProfile: decisionUnset(),
    gatewayAuthority: decisionUnset(),
    effectGroups: {
      sandbox_create: {
        completedAt: "2026-01-01T00:00:00.000Z",
        fingerprint: defaultCreateFingerprint(),
      },
    },
    bindings: { credentialEnvs: [], registeredProviders: [] },
    ...overrides,
  };
}

type StubbedRunOpenshellResult = { status: number; stdout: string; stderr: string };

const OK_RESULT: StubbedRunOpenshellResult = { status: 0, stdout: "", stderr: "" };

function fakeGatewayRunOpenshell() {
  const createdProviders = new Map<string, { type: string; credentialEnv: string }>();

  const handleGet = (args: string[]): StubbedRunOpenshellResult => {
    const name = args[args.length - 1];
    const provider = createdProviders.get(name);
    return provider
      ? {
          status: 0,
          stdout: [
            `Name: ${name}`,
            `Type: ${provider.type}`,
            `Credential keys: ${provider.credentialEnv}`,
            "Config keys: <none>",
          ].join("\n"),
          stderr: "",
        }
      : { status: 1, stdout: "", stderr: "not found" };
  };

  const handleCreate = (args: string[]): StubbedRunOpenshellResult => {
    createdProviders.set(args[args.indexOf("--name") + 1] ?? "", {
      type: args[args.indexOf("--type") + 1] ?? "generic",
      credentialEnv: args[args.indexOf("--credential") + 1] ?? "",
    });
    return OK_RESULT;
  };

  const handlersByAction: Record<string, (args: string[]) => StubbedRunOpenshellResult> = {
    get: handleGet,
    create: handleCreate,
    update: () => OK_RESULT,
  };

  const runOpenshell = vi.fn(
    (args: string[]): StubbedRunOpenshellResult =>
      (args[0] === "provider" ? handlersByAction[args[1]] : undefined)?.(args) ?? OK_RESULT,
  );
  return { runOpenshell, createdProviders };
}

function realStageSandboxCredentialProviders(
  tokenDefs: MessagingTokenDef[],
  crashAfterFirstSuccess: boolean,
) {
  const { runOpenshell } = fakeGatewayRunOpenshell();
  const registrationSession = { stagedCredentialProviders: [] as string[] } as Session;
  const registration = createCredentialProviderRegistration({
    root: "/repo",
    runOpenshell: runOpenshell as unknown as CredentialProviderRegistrationDeps["runOpenshell"],
    redact: (input) => input,
    getGatewayName: () => "nemoclaw",
    normalizeCredentialValue: (value) => (typeof value === "string" ? value.trim() : ""),
    updateSession: (mutator) => (mutator(registrationSession) ?? registrationSession) as Session,
    stagedLegacyValues: new Map(),
    migratedLegacyKeys: new Set(),
    persistMigratedLegacyKeys: vi.fn(),
  });
  let crashPending = crashAfterFirstSuccess;
  const stageSandboxCredentialProviders = vi.fn(
    async (input: {
      sandboxName: string;
      enabledChannels: readonly string[];
      webSearchConfig: unknown;
      agent: unknown;
    }) => {
      const staged = await registration.stageSandboxCredentialProviders(
        input as never,
        async () => ({ messagingTokenDefs: tokenDefs }),
      );
      const shouldCrash = crashPending;
      crashPending = false;
      return shouldCrash
        ? Promise.reject(new Error("gateway connection dropped mid-registration"))
        : staged;
    },
  );
  return {
    stageSandboxCredentialProviders,
    providerMatchesGatewayCredential: registration.providerMatchesGatewayCredential,
    runOpenshell,
  };
}

function sessionWithCheckpoint(checkpoint: OnboardCheckpoint): Session {
  const session = createSession({
    sessionId: "sess-1",
    agent: "openclaw",
    sandboxName: "my-assistant",
    sandboxPromptProgress: {
      sandboxName: true,
      webSearch: false,
      messaging: false,
      resourceProfile: false,
    },
  });
  session.checkpoint = checkpoint;
  return session;
}

describe("sandbox crash-recovery replay (#5961, #6228)", () => {
  it("reuses a surviving sandbox instead of recreating it under a stale step-incomplete decision", async () => {
    const { deps, calls } = createDeps({ getSandboxReuseState: () => "ready" });
    const session = sessionWithCheckpoint(crashedCheckpoint());

    await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "my-assistant",
    });

    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(calls.recordSkip).toHaveBeenCalled();
  });

  it("recreates only under the recorded durable identity when the sandbox is gone", async () => {
    const { deps, calls } = createDeps({ getSandboxReuseState: () => "missing" });
    const session = sessionWithCheckpoint(crashedCheckpoint());

    await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "my-assistant",
    });

    expect(calls.createSandbox).toHaveBeenCalled();
    expect((calls.createSandbox.mock.calls[0] as unknown[] | undefined)?.[4]).toBe("my-assistant");
  });

  it("rejects stale bindings before any mutation instead of guessing", async () => {
    const { deps, calls } = createDeps({ getSandboxReuseState: () => "missing" });
    const session = sessionWithCheckpoint(
      crashedCheckpoint({
        bindings: { credentialEnvs: ["OPENAI_API_KEY"], registeredProviders: [] },
      }),
    );

    await expect(
      handleSandboxState({
        ...baseOptions(deps, session),
        resume: true,
        sandboxName: "my-assistant",
        env: {},
      }),
    ).rejects.toThrow("exit 1");

    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(calls.error.mock.calls.flat().join("\n")).toContain("OPENAI_API_KEY");
  });

  it("does not engage the crash-recovery path for a normal fresh create (no checkpoint receipt)", async () => {
    const { deps, calls } = createDeps({ getSandboxReuseState: () => "missing" });
    const session = createSession({ sessionId: "sess-1", agent: "openclaw" });

    await handleSandboxState({ ...baseOptions(deps, session), resume: false });

    expect(calls.createSandbox).toHaveBeenCalled();
  });

  it("reuses a live sandbox even when the create receipt was lost in the crash window (#7022)", async () => {
    const { deps, calls } = createDeps({ getSandboxReuseState: () => "ready" });
    const session = sessionWithCheckpoint(crashedCheckpoint({ effectGroups: {} }));

    await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "my-assistant",
    });

    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(calls.recordSkip).toHaveBeenCalled();
  });

  it("does not reuse a live sandbox when the checkpoint identity does not match the resume target", async () => {
    const { deps, calls } = createDeps({ getSandboxReuseState: () => "ready" });
    const session = sessionWithCheckpoint(
      crashedCheckpoint({
        sandboxIdentity: decisionSelected({ name: "other-assistant", agent: "openclaw" }),
      }),
    );

    await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "my-assistant",
    });

    expect(calls.createSandbox).toHaveBeenCalled();
    expect(calls.recordSkip).not.toHaveBeenCalled();
  });

  it("rejects reuse when a checkpointed provider is no longer live-registered with the gateway", async () => {
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "missing",
      providerMatchesGatewayCredential: () => false,
    });
    const session = sessionWithCheckpoint(
      crashedCheckpoint({
        bindings: {
          credentialEnvs: [],
          registeredProviders: [
            { name: "my-assistant-brave-search", type: "brave", credentialEnv: "BRAVE_API_KEY" },
          ],
        },
      }),
    );

    await expect(
      handleSandboxState({
        ...baseOptions(deps, session),
        resume: true,
        sandboxName: "my-assistant",
      }),
    ).rejects.toThrow("exit 1");

    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(calls.error.mock.calls.flat().join("\n")).toContain("my-assistant-brave-search");
  });

  it("accepts a checkpointed provider that is still live-registered with the gateway", async () => {
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "ready",
      providerMatchesGatewayCredential: (name, type, credentialEnv) =>
        name === "my-assistant-brave-search" &&
        type === "brave" &&
        credentialEnv === "BRAVE_API_KEY",
    });
    const session = sessionWithCheckpoint(
      crashedCheckpoint({
        bindings: {
          credentialEnvs: [],
          registeredProviders: [
            { name: "my-assistant-brave-search", type: "brave", credentialEnv: "BRAVE_API_KEY" },
          ],
        },
      }),
    );

    await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "my-assistant",
    });

    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(calls.recordSkip).toHaveBeenCalled();
  });

  it("rejects reuse when a checkpointed provider name exists live under a different type or credential environment (#7022)", async () => {
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "missing",
      providerMatchesGatewayCredential: (name, type, credentialEnv) =>
        name === "my-assistant-brave-search" &&
        type === "generic" &&
        credentialEnv === "OTHER_API_KEY",
    });
    const session = sessionWithCheckpoint(
      crashedCheckpoint({
        bindings: {
          credentialEnvs: [],
          registeredProviders: [
            { name: "my-assistant-brave-search", type: "brave", credentialEnv: "BRAVE_API_KEY" },
          ],
        },
      }),
    );

    await expect(
      handleSandboxState({
        ...baseOptions(deps, session),
        resume: true,
        sandboxName: "my-assistant",
      }),
    ).rejects.toThrow("exit 1");

    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(calls.error.mock.calls.flat().join("\n")).toContain("my-assistant-brave-search");
  });

  it("records durable sandbox identity for a non-OpenClaw agent create so a crash can still be recovered", async () => {
    const { deps, getSession } = createDeps({ getSandboxReuseState: () => "missing" });
    const session = createSession({ sessionId: "sess-1", agent: "hermes" });

    await handleSandboxState({
      ...baseOptions(deps, session),
      resume: false,
      agent: { name: "hermes" },
      sandboxName: "my-assistant",
    });

    expect(getSession().checkpoint?.sandboxIdentity).toEqual(
      decisionSelected({ name: "my-assistant", agent: "hermes" }),
    );
  });

  it.each([
    "interactive",
    "non-interactive",
  ] as const)("replays %s web-search provider registration without duplicating the external effect after receipt loss (#7022)", async (mode) => {
    const { stageSandboxCredentialProviders, providerMatchesGatewayCredential, runOpenshell } =
      realStageSandboxCredentialProviders(
        [
          {
            name: "my-assistant-brave-search",
            envKey: "BRAVE_API_KEY",
            token: "brave-secret",
            providerType: "brave",
          },
        ],
        true,
      );
    const session = createSession({ sessionId: "sess-1", agent: "openclaw", mode });
    const { deps, getSession } = createDeps(
      {
        getSandboxReuseState: () => "missing",
        configureWebSearch: vi.fn(async () => ({ fetchEnabled: true as const })),
        stageSandboxCredentialProviders,
        providerMatchesGatewayCredential,
      },
      session,
    );

    await expect(
      handleSandboxState({ ...baseOptions(deps, session), resume: false }),
    ).rejects.toThrow("gateway connection dropped mid-registration");

    const crashedSession = getSession();
    expect(crashedSession.checkpoint?.effectGroups.web_search_provider).toBeUndefined();
    expect(crashedSession.checkpoint?.bindings.registeredProviders).toEqual([]);

    await handleSandboxState({
      ...baseOptions(deps, crashedSession),
      resume: true,
      sandboxName: "my-assistant",
      webSearchConfig: { fetchEnabled: true },
    });

    expect(stageSandboxCredentialProviders).toHaveBeenCalledTimes(2);
    expect(
      runOpenshell.mock.calls.filter(([args]) => args[0] === "provider" && args[1] === "create"),
    ).toHaveLength(1);
    const resumedSession = getSession();
    expect(resumedSession.checkpoint?.effectGroups.web_search_provider).toBeDefined();
    expect(resumedSession.checkpoint?.bindings.registeredProviders).toEqual([
      { name: "my-assistant-brave-search", type: "brave", credentialEnv: "BRAVE_API_KEY" },
    ]);
  });

  it.each([
    "interactive",
    "non-interactive",
  ] as const)("replays %s messaging provider registration without duplicating the external effect after receipt loss (#7022)", async (mode) => {
    const { stageSandboxCredentialProviders, providerMatchesGatewayCredential, runOpenshell } =
      realStageSandboxCredentialProviders(
        [
          {
            name: "my-assistant-discord-bridge",
            envKey: "DISCORD_BOT_TOKEN",
            token: "discord-secret",
          },
        ],
        true,
      );
    const session = createSession({ sessionId: "sess-1", agent: "openclaw", mode });
    const messagingPlan = makeMinimalPlan("my-assistant", "openclaw", ["discord"]);
    const { deps, getSession } = createDeps(
      {
        getSandboxReuseState: () => "missing",
        readMessagingPlanFromEnv: () => messagingPlan,
        stageSandboxCredentialProviders,
        providerMatchesGatewayCredential,
      },
      session,
    );

    await expect(
      handleSandboxState({ ...baseOptions(deps, session), resume: false }),
    ).rejects.toThrow("gateway connection dropped mid-registration");

    const crashedSession = getSession();
    expect(crashedSession.checkpoint?.effectGroups.messaging_providers).toBeUndefined();
    expect(crashedSession.checkpoint?.bindings.registeredProviders).toEqual([]);

    await handleSandboxState({
      ...baseOptions(deps, crashedSession),
      resume: true,
      sandboxName: "my-assistant",
    });

    expect(stageSandboxCredentialProviders).toHaveBeenCalledTimes(2);
    expect(
      runOpenshell.mock.calls.filter(([args]) => args[0] === "provider" && args[1] === "create"),
    ).toHaveLength(1);
    const resumedSession = getSession();
    expect(resumedSession.checkpoint?.effectGroups.messaging_providers).toBeDefined();
    expect(resumedSession.checkpoint?.bindings.registeredProviders).toEqual([
      { name: "my-assistant-discord-bridge", type: "generic", credentialEnv: "DISCORD_BOT_TOKEN" },
    ]);
  });

  it("rejects reuse when the recorded build/policy fingerprint drifted from the current request (#7022)", async () => {
    const { deps, calls } = createDeps({ getSandboxReuseState: () => "ready" });
    const session = sessionWithCheckpoint(
      crashedCheckpoint({
        effectGroups: {
          sandbox_create: { completedAt: "2026-01-01T00:00:00.000Z", fingerprint: "stale-build" },
        },
      }),
    );

    await expect(
      handleSandboxState({
        ...baseOptions(deps, session),
        resume: true,
        sandboxName: "my-assistant",
      }),
    ).rejects.toThrow("exit 1");

    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(calls.error.mock.calls.flat().join("\n")).toContain("--recreate-sandbox");
  });

  it("rejects reuse when a resolved policy or package input drifted despite an unchanged build version and policy tier (#7022)", async () => {
    const { deps, calls } = createDeps({ getSandboxReuseState: () => "ready" });
    const session = sessionWithCheckpoint(crashedCheckpoint());

    await expect(
      handleSandboxState({
        ...baseOptions(deps, session),
        resume: true,
        sandboxName: "my-assistant",
        hermesToolGateways: ["nous-web"],
      }),
    ).rejects.toThrow("exit 1");

    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(calls.error.mock.calls.flat().join("\n")).toContain("--recreate-sandbox");
  });

  it("reconciles changed live extra providers without treating gateway attachments as durable build drift (#7022)", async () => {
    const session = createSession({ sessionId: "sess-1", agent: "openclaw" });
    const updateSession = vi.fn((mutator: (value: typeof session) => void) => {
      mutator(session);
      return session;
    });
    const { deps: createDeps1 } = createDeps({
      getSandboxReuseState: () => "missing",
      updateSession,
      planRegisteredExtraProviders: () => ({
        extraProviders: ["provider-a"],
        staleExtraProviders: [],
      }),
    });

    await handleSandboxState({
      ...baseOptions(createDeps1, session),
      resume: false,
      sandboxName: "my-assistant",
    });

    expect(session.checkpoint?.effectGroups.sandbox_create).toBeDefined();

    const { deps: resumeDeps, calls } = createDeps({
      getSandboxReuseState: () => "missing",
      updateSession,
      planRegisteredExtraProviders: () => ({
        extraProviders: ["provider-b"],
        staleExtraProviders: ["provider-a"],
      }),
    });

    await handleSandboxState({
      ...baseOptions(resumeDeps, session),
      resume: true,
      sandboxName: "my-assistant",
    });

    expect(calls.createSandbox).toHaveBeenCalledTimes(1);
    expect(calls.error).not.toHaveBeenCalled();
  });

  it("rejects stable resolved create-intent drift despite an unchanged light fingerprint (#7022)", async () => {
    const session = createSession({ sessionId: "sess-1", agent: "openclaw" });
    const updateSession = vi.fn((mutator: (value: typeof session) => void) => {
      mutator(session);
      return session;
    });
    const firstRun = createDeps({ getSandboxReuseState: () => "missing", updateSession });

    await handleSandboxState({
      ...baseOptions(firstRun.deps, session),
      resume: false,
      sandboxName: "my-assistant",
    });

    const resumedRun = createDeps({ getSandboxReuseState: () => "missing", updateSession });
    const defaultResolve = resumedRun.calls.resolveCreateIntent.getMockImplementation();
    expect(defaultResolve).toBeDefined();
    resumedRun.calls.resolveCreateIntent.mockImplementation(async (input) => {
      const resolved = await defaultResolve!(input);
      return {
        ...resolved,
        policy: { ...resolved.policy, basePolicyPath: "/repo/changed-policy.yaml" },
      };
    });

    await expect(
      handleSandboxState({
        ...baseOptions(resumedRun.deps, session),
        resume: true,
        sandboxName: "my-assistant",
      }),
    ).rejects.toThrow("exit 1");

    expect(resumedRun.calls.createSandbox).not.toHaveBeenCalled();
    expect(resumedRun.calls.error.mock.calls.flat().join("\n")).toContain("--recreate-sandbox");
  });

  it("re-revalidates checkpoint bindings immediately before the locked destructive create, catching a race after the initial check (#7022)", async () => {
    let liveCheckCount = 0;
    const providerMatchesGatewayCredential = vi.fn(() => {
      liveCheckCount += 1;
      return liveCheckCount === 1;
    });
    const session = sessionWithCheckpoint(
      crashedCheckpoint({
        effectGroups: {},
        bindings: {
          credentialEnvs: [],
          registeredProviders: [
            { name: "my-assistant-brave-search", type: "brave", credentialEnv: "BRAVE_API_KEY" },
          ],
        },
      }),
    );
    const updateSession = vi.fn((mutator: (value: typeof session) => void) => {
      mutator(session);
      return session;
    });
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "missing",
      providerMatchesGatewayCredential,
      updateSession,
    });

    await expect(
      handleSandboxState({
        ...baseOptions(deps, session),
        resume: true,
        sandboxName: "my-assistant",
      }),
    ).rejects.toThrow("exit 1");

    expect(liveCheckCount).toBeGreaterThan(1);
    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(calls.error.mock.calls.flat().join("\n")).toContain("my-assistant-brave-search");
  });

  it("accepts a scrubbed host credential when its exact registered provider binding remains live (#7022)", async () => {
    const providerMatchesGatewayCredential = vi.fn(() => true);
    const session = sessionWithCheckpoint(
      crashedCheckpoint({
        effectGroups: {},
        bindings: {
          credentialEnvs: ["COMPATIBLE_API_KEY"],
          registeredProviders: [
            {
              name: "compatible-endpoint",
              type: "openai",
              credentialEnv: "COMPATIBLE_API_KEY",
            },
          ],
        },
      }),
    );
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "missing",
      providerMatchesGatewayCredential,
    });

    await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "my-assistant",
      env: {},
    });

    expect(providerMatchesGatewayCredential).toHaveBeenCalledWith(
      "compatible-endpoint",
      "openai",
      "COMPATIBLE_API_KEY",
    );
    expect(calls.createSandbox).toHaveBeenCalledTimes(1);
  });

  it.each([
    "interactive",
    "non-interactive",
  ] as const)("resumes a %s onboarding attempt that crashed after create succeeded but before its completion receipt (#7022)", async (mode) => {
    const recordStepComplete = vi
      .fn()
      .mockRejectedValueOnce(new Error("process crashed after create"));
    const { deps, calls, getSession } = createDeps({
      getSandboxReuseState: () => "missing",
      recordStepComplete,
    });
    const session = createSession({ sessionId: "sess-1", agent: "openclaw", mode });

    await expect(
      handleSandboxState({
        ...baseOptions(deps, session),
        resume: false,
        sandboxName: "my-assistant",
        authoritativeResumeConfig: true,
      }),
    ).rejects.toThrow("process crashed after create");

    expect(calls.createSandbox).toHaveBeenCalledTimes(1);
    expect(calls.promptName).not.toHaveBeenCalled();
    expect(calls.configureWebSearch).not.toHaveBeenCalled();
    const crashedSession = getSession();
    expect(crashedSession.checkpoint?.effectGroups.sandbox_create).toBeUndefined();
    expect(crashedSession.checkpoint?.sandboxIdentity).toEqual(
      decisionSelected({ name: "my-assistant", agent: "openclaw" }),
    );

    const { deps: resumeDeps, calls: resumeCalls } = createDeps({
      getSandboxReuseState: () => "ready",
    });

    await handleSandboxState({
      ...baseOptions(resumeDeps, crashedSession),
      resume: true,
      sandboxName: "my-assistant",
      authoritativeResumeConfig: true,
    });

    expect(resumeCalls.createSandbox).not.toHaveBeenCalled();
    expect(resumeCalls.recordSkip).toHaveBeenCalled();
  });

  it.each([
    "interactive",
    "non-interactive",
  ] as const)("backfills effect receipts after a %s crash following sandbox registration (#7022)", async (mode) => {
    let persistedSession = createSession({ sessionId: "sess-1", agent: "openclaw", mode });
    const updateSession = vi.fn((mutator: (value: Session) => Session | void) => {
      persistedSession = mutator(persistedSession) ?? persistedSession;
      return persistedSession;
    });
    const recordStepComplete = vi.fn(async (_stepName: string, updates: SessionUpdates) => {
      Object.assign(persistedSession, updates);
      updateSession.mockImplementationOnce(() => {
        throw new Error("process crashed after sandbox registration");
      });
      return persistedSession;
    });
    const firstRun = createDeps({
      getSandboxReuseState: () => "missing",
      recordStepComplete,
      updateSession,
    });

    await expect(
      handleSandboxState({
        ...baseOptions(firstRun.deps, persistedSession),
        resume: false,
        sandboxName: "my-assistant",
        authoritativeResumeConfig: true,
      }),
    ).rejects.toThrow("process crashed after sandbox registration");

    expect(firstRun.calls.createSandbox).toHaveBeenCalledTimes(1);
    expect(firstRun.calls.updateSandbox).toHaveBeenCalledTimes(1);
    expect(recordStepComplete).toHaveBeenCalledTimes(1);
    expect(persistedSession.checkpoint?.effectGroups.sandbox_create).toBeUndefined();
    expect(persistedSession.checkpoint?.effectGroups.sandbox_register).toBeUndefined();

    const resumeUpdateSession = vi.fn((mutator: (value: Session) => Session | void) => {
      persistedSession = mutator(persistedSession) ?? persistedSession;
      return persistedSession;
    });
    const recordStateSkipped = vi.fn(async () => persistedSession);
    const resumedRun = createDeps({
      getSandboxReuseState: () => "ready",
      recordStateSkipped,
      updateSession: resumeUpdateSession,
    });

    await handleSandboxState({
      ...baseOptions(resumedRun.deps, persistedSession),
      resume: true,
      sandboxName: "my-assistant",
      authoritativeResumeConfig: true,
    });

    expect(resumedRun.calls.createSandbox).not.toHaveBeenCalled();
    expect(recordStateSkipped).toHaveBeenCalledTimes(1);
    expect(resumedRun.calls.updateSandbox).toHaveBeenCalledWith("my-assistant", {
      pendingRouteReservation: undefined,
    });
    expect(
      resumedRun.calls.updateSandbox.mock.calls.some(([, updates]) =>
        Object.prototype.hasOwnProperty.call(updates, "provider"),
      ),
    ).toBe(false);
    expect(persistedSession.checkpoint?.effectGroups.sandbox_create?.fingerprint).toBe(
      defaultCreateFingerprint(),
    );
    expect(persistedSession.checkpoint?.effectGroups.sandbox_register?.fingerprint).toBe(
      "my-assistant",
    );
  });
});
