// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { decisionSelected, decisionUnset } from "../../../state/onboard-checkpoint-decision";
import {
  CHECKPOINT_SCHEMA_VERSION,
  type CheckpointProviderBinding,
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
  detectUnconfiguredMessagingChannels: vi.fn(() => []),
}));

vi.mocked(detectMessagingChannelsFromEnv).mockReturnValue([]);

function defaultCreateFingerprint(builtFingerprint = "my-assistant"): string {
  return [
    builtFingerprint,
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
    profile: { kind: "selected", value: "default" },
    runtimeAuthority: { kind: "unset" },
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
    sandboxRecreate: null,
    ...overrides,
  };
}

type StubbedRunOpenshellResult = { status: number; stdout: string; stderr: string };

const OK_RESULT: StubbedRunOpenshellResult = { status: 0, stdout: "", stderr: "" };
const EXACT_MESSAGING_PROFILE: StubbedRunOpenshellResult = {
  status: 0,
  stdout: JSON.stringify({
    id: "nemoclaw-mcp-v1",
    credentials: [],
    endpoints: [],
    binaries: [],
    inference_capable: false,
  }),
  stderr: "",
};
const EXACT_BRAVE_PROFILE: StubbedRunOpenshellResult = {
  status: 0,
  stdout: JSON.stringify({
    id: "brave",
    credentials: [
      {
        name: "api_key",
        env_vars: ["BRAVE_API_KEY"],
        required: true,
        auth_style: "header",
        header_name: "x-subscription-token",
        query_param: "",
      },
    ],
    endpoints: [
      {
        host: "api.search.brave.com",
        port: 443,
        protocol: "rest",
        access: "read-write",
        enforcement: "enforce",
      },
    ],
    binaries: ["/usr/local/bin/node", "/usr/bin/node", "/usr/local/bin/curl", "/usr/bin/curl"],
    inference_capable: false,
  }),
  stderr: "",
};

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
      : {
          status: 1,
          stdout: "",
          stderr:
            "Error: code: 'Some requested entity was not found', message: \"provider not found\"",
        };
  };

  const handleCreate = (args: string[]): StubbedRunOpenshellResult => {
    createdProviders.set(args[args.indexOf("--name") + 1] ?? "", {
      type: args[args.indexOf("--type") + 1] ?? "generic",
      credentialEnv: args[args.indexOf("--credential") + 1] ?? "",
    });
    return OK_RESULT;
  };

  const exactProfileExports = new Map([
    [
      "provider profile -g nemoclaw export brave --output json",
      EXACT_BRAVE_PROFILE,
    ],
    [
      "provider profile -g nemoclaw export nemoclaw-mcp-v1 --output json",
      EXACT_MESSAGING_PROFILE,
    ],
  ]);
  const rejectUnexpectedProfileCommand = (args: string[]): never => {
    throw new Error(`Unexpected provider profile command: ${args.join(" ")}`);
  };

  const handlersByAction: Record<string, (args: string[]) => StubbedRunOpenshellResult> = {
    profile: (args) =>
      exactProfileExports.get(args.join(" ")) ?? rejectUnexpectedProfileCommand(args),
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
    getGatewayName: () => "nemoclaw",
    getCredential: () => null,
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
      requiredBindings: readonly CheckpointProviderBinding[];
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

function discordMessagingPlan(): ReturnType<typeof makeMinimalPlan> {
  return {
    ...makeMinimalPlan("my-assistant", "openclaw", ["discord"]),
    credentialBindings: [
      {
        channelId: "discord",
        credentialId: "discordBotToken",
        sourceInput: "botToken",
        providerName: "my-assistant-discord-bridge",
        providerEnvKey: "DISCORD_BOT_TOKEN",
        placeholder: "openshell:resolve:env:DISCORD_BOT_TOKEN",
        credentialAvailable: true,
      },
    ],
  };
}

describe("sandbox crash-recovery replay (#5961, #6228)", () => {
  it("reuses the selected Ready portable sandbox without recreation or forward cleanup (#9068)", async () => {
    const checkpoint = crashedCheckpoint({
      profile: { kind: "selected", value: "portable" },
      effectGroups: {},
    });
    const session = sessionWithCheckpoint(checkpoint);
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "ready",
      checkGatewayRouteCompatibility: () => ({ ok: true }),
      getSandboxRegistryEntry: () => ({
        name: "my-assistant",
        agent: null,
        provider: "provider",
        model: "model",
        endpointUrl: null,
        preferredInferenceApi: "openai-completions",
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        pendingRouteReservation: true,
        reservationSessionId: session.sessionId,
      }),
    });

    await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "my-assistant",
      env: { NEMOCLAW_EXPERIMENTAL_PROFILE: "portable" },
    });

    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(calls.stopStale).not.toHaveBeenCalled();
    expect(calls.finalizeRouteReservation).toHaveBeenCalledExactlyOnceWith(
      "my-assistant",
      session.sessionId,
    );
    expect(calls.recordSkip).toHaveBeenCalled();
  });

  it("reuses a surviving sandbox with a legacy pre-reasoning fingerprint", async () => {
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

  it("rejects a stale credential binding before creating the missing sandbox", async () => {
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

  it("rejects a stale provider binding without an effect receipt before creating the missing sandbox", async () => {
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

  it.each([
    ["a malformed effect receipt", [",my-assistant-brave-search"], ["my-assistant-brave-search"]],
    [
      "whitespace around a provider name",
      [" my-assistant-brave-search"],
      [" my-assistant-brave-search"],
    ],
    [
      "duplicate names in one effect receipt",
      ["my-assistant-brave-search,my-assistant-brave-search"],
      ["my-assistant-brave-search"],
    ],
    [
      "a provider named by two effect receipts",
      ["my-assistant-brave-search", "my-assistant-brave-search"],
      ["my-assistant-brave-search"],
    ],
    [
      "an effect receipt without a matching binding",
      ["missing-provider"],
      ["my-assistant-brave-search"],
    ],
    [
      "duplicate registered provider bindings",
      ["my-assistant-brave-search"],
      ["my-assistant-brave-search", "my-assistant-brave-search"],
    ],
  ] as const)(
    "does not grant provider replay authority to %s",
    async (_case, fingerprints, registeredProviderNames) => {
      const [webFingerprint, messagingFingerprint] = fingerprints;
      const { deps, calls } = createDeps({
        getSandboxReuseState: () => "missing",
        providerMatchesGatewayCredential: () => false,
      });
      const session = sessionWithCheckpoint(
        crashedCheckpoint({
          effectGroups: {
            sandbox_create: {
              completedAt: "2026-01-01T00:00:00.000Z",
              fingerprint: defaultCreateFingerprint(),
            },
            web_search_provider: {
              completedAt: "2026-01-01T00:00:00.000Z",
              fingerprint: webFingerprint,
            },
            ...(messagingFingerprint
              ? {
                  messaging_providers: {
                    completedAt: "2026-01-01T00:00:00.000Z",
                    fingerprint: messagingFingerprint,
                  },
                }
              : {}),
          },
          bindings: {
            credentialEnvs: ["BRAVE_API_KEY"],
            registeredProviders: registeredProviderNames.map((name) => ({
              name,
              type: "brave",
              credentialEnv: "BRAVE_API_KEY",
            })),
          },
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
    },
  );

  it("rejects a malformed provider receipt before registering a changed selection (#7702)", async () => {
    const oldBinding = {
      name: "my-assistant-brave-search",
      type: "brave",
      credentialEnv: "BRAVE_API_KEY",
    };
    const currentBinding = {
      name: "my-assistant-tavily-search",
      type: "tavily",
      credentialEnv: "TAVILY_API_KEY",
    };
    const stageSandboxCredentialProviders = vi.fn(async () => [currentBinding]);
    const session = sessionWithCheckpoint(
      crashedCheckpoint({
        webSearch: decisionSelected({ fetchEnabled: true, provider: "brave" }),
        effectGroups: {
          sandbox_create: {
            completedAt: "2026-01-01T00:00:00.000Z",
            fingerprint: defaultCreateFingerprint(),
          },
          web_search_provider: {
            completedAt: "2026-01-01T00:00:00.000Z",
            fingerprint: `,${oldBinding.name}`,
          },
        },
        bindings: {
          credentialEnvs: [oldBinding.credentialEnv],
          registeredProviders: [oldBinding],
        },
      }),
    );
    session.webSearchConfig = { fetchEnabled: true, provider: "brave" };
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "missing",
      stageSandboxCredentialProviders,
      providerMatchesGatewayCredential: (name, type, credentialEnv) =>
        name === oldBinding.name &&
        type === oldBinding.type &&
        credentialEnv === oldBinding.credentialEnv,
    });

    await expect(
      handleSandboxState({
        ...baseOptions(deps, session),
        resume: true,
        sandboxName: "my-assistant",
        webSearchConfig: { fetchEnabled: true, provider: "tavily" },
      }),
    ).rejects.toThrow("exit 1");

    expect(stageSandboxCredentialProviders).not.toHaveBeenCalled();
    expect(calls.createSandbox).not.toHaveBeenCalled();
  });

  it.each([
    {
      invalidState: "a malformed provider receipt",
      fingerprint: ",my-assistant-brave-search",
      binding: {
        name: "my-assistant-brave-search",
        type: "brave",
        credentialEnv: "BRAVE_API_KEY",
      },
    },
    {
      invalidState: "an unowned provider binding with whitespace",
      fingerprint: null,
      binding: {
        name: " unowned-provider",
        type: "generic",
        credentialEnv: "UNOWNED_TOKEN",
      },
    },
  ])("rejects $invalidState before forced recreation (#7701)", async ({ fingerprint, binding }) => {
    const session = sessionWithCheckpoint(
      crashedCheckpoint({
        effectGroups: {
          sandbox_create: {
            completedAt: "2026-01-01T00:00:00.000Z",
            fingerprint: defaultCreateFingerprint(),
          },
          ...(fingerprint
            ? {
                web_search_provider: {
                  completedAt: "2026-01-01T00:00:00.000Z",
                  fingerprint,
                },
              }
            : {}),
        },
        bindings: {
          credentialEnvs: [binding.credentialEnv],
          registeredProviders: [binding],
        },
      }),
    );
    const stageSandboxCredentialProviders = vi.fn(async () => []);
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "ready",
      stageSandboxCredentialProviders,
    });

    await expect(
      handleSandboxState({
        ...baseOptions(deps, session),
        resume: true,
        recreateSandbox: () => true,
        sandboxName: "my-assistant",
      }),
    ).rejects.toThrow("exit 1");

    expect(stageSandboxCredentialProviders).not.toHaveBeenCalled();
    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(calls.removeSandbox).not.toHaveBeenCalled();
    expect(calls.retireReplacedSandboxWorkload).not.toHaveBeenCalled();
    expect(calls.error.mock.calls.flat().join("\n")).toContain("nemoclaw onboard --fresh");
  });

  it("rejects duplicate provider names when only one binding matches the gateway (#7022)", async () => {
    const providerName = "my-assistant-brave-search";
    const session = sessionWithCheckpoint(
      crashedCheckpoint({
        effectGroups: {
          sandbox_create: {
            completedAt: "2026-01-01T00:00:00.000Z",
            fingerprint: defaultCreateFingerprint(),
          },
          web_search_provider: {
            completedAt: "2026-01-01T00:00:00.000Z",
            fingerprint: providerName,
          },
        },
        bindings: {
          credentialEnvs: ["BRAVE_API_KEY"],
          registeredProviders: [
            { name: providerName, type: "brave", credentialEnv: "BRAVE_API_KEY" },
            { name: providerName, type: "tavily", credentialEnv: "BRAVE_API_KEY" },
          ],
        },
      }),
    );
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "ready",
      providerMatchesGatewayCredential: (_name, type) => type === "brave",
    });

    await expect(
      handleSandboxState({
        ...baseOptions(deps, session),
        resume: true,
        sandboxName: "my-assistant",
        env: {},
      }),
    ).rejects.toThrow("exit 1");

    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(calls.recordSkip).not.toHaveBeenCalled();
  });

  it("rejects a stale provider binding with an effect receipt during locked live-sandbox reuse (#7022)", async () => {
    let gatewayLockEntered = false;
    const withGatewayRouteMutationLock = async <T>(
      _gatewayName: string,
      operation: () => Promise<T> | T,
    ): Promise<T> => {
      gatewayLockEntered = true;
      return await operation();
    };
    const session = sessionWithCheckpoint(
      crashedCheckpoint({
        effectGroups: {
          sandbox_create: {
            completedAt: "2026-01-01T00:00:00.000Z",
            fingerprint: defaultCreateFingerprint(),
          },
          web_search_provider: {
            completedAt: "2026-01-01T00:00:00.000Z",
            fingerprint: "my-assistant-brave-search",
          },
        },
        bindings: {
          credentialEnvs: ["BRAVE_API_KEY"],
          registeredProviders: [
            { name: "my-assistant-brave-search", type: "brave", credentialEnv: "BRAVE_API_KEY" },
          ],
        },
      }),
    );
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "ready",
      providerMatchesGatewayCredential: () => false,
      withGatewayRouteMutationLock,
    });

    await expect(
      handleSandboxState({
        ...baseOptions(deps, session),
        resume: true,
        sandboxName: "my-assistant",
      }),
    ).rejects.toThrow("exit 1");

    expect(gatewayLockEntered).toBe(true);
    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(calls.recordSkip).not.toHaveBeenCalled();
  });

  it("replays a stale web-search provider receipt before creating the missing sandbox (#7022)", async () => {
    const binding = {
      name: "my-assistant-brave-search",
      type: "brave",
      credentialEnv: "BRAVE_API_KEY",
    };
    let bindingLive = false;
    const stageSandboxCredentialProviders = vi.fn(async () => {
      bindingLive = true;
      return [binding];
    });
    const providerMatchesGatewayCredential = vi.fn(
      (name, type, credentialEnv) =>
        bindingLive &&
        name === binding.name &&
        type === binding.type &&
        credentialEnv === binding.credentialEnv,
    );
    const session = sessionWithCheckpoint(
      crashedCheckpoint({
        webSearch: decisionSelected({ fetchEnabled: true, provider: "brave" }),
        effectGroups: {
          sandbox_create: {
            completedAt: "2026-01-01T00:00:00.000Z",
            fingerprint: defaultCreateFingerprint(),
          },
          web_search_provider: {
            completedAt: "2026-01-01T00:00:00.000Z",
            fingerprint: binding.name,
          },
        },
        bindings: {
          credentialEnvs: [binding.credentialEnv],
          registeredProviders: [binding],
        },
      }),
    );
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "missing",
      stageSandboxCredentialProviders,
      providerMatchesGatewayCredential,
    });

    await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "my-assistant",
      webSearchConfig: { fetchEnabled: true, provider: "brave" },
    });

    expect(stageSandboxCredentialProviders).toHaveBeenCalledTimes(1);
    expect(calls.createSandbox).toHaveBeenCalledTimes(1);
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
      getSandboxReuseState: () => "ready",
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

  it.each(["interactive", "non-interactive"] as const)(
    "replays %s web-search provider registration without duplicating the external effect after receipt loss (#7022)",
    async (mode) => {
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
    },
  );

  it.each(["interactive", "non-interactive"] as const)(
    "recovers the %s messaging provider receipt without duplicating the external effect after receipt loss (#7022)",
    async (mode) => {
      const { stageSandboxCredentialProviders, providerMatchesGatewayCredential, runOpenshell } =
        realStageSandboxCredentialProviders(
          [
            {
              name: "my-assistant-discord-bridge",
              envKey: "DISCORD_BOT_TOKEN",
              token: "discord-secret",
              providerType: "nemoclaw-mcp-v1",
            },
          ],
          true,
        );
      const session = createSession({ sessionId: "sess-1", agent: "openclaw", mode });
      const messagingPlan = discordMessagingPlan();
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
        {
          name: "my-assistant-discord-bridge",
          type: "nemoclaw-mcp-v1",
          credentialEnv: "DISCORD_BOT_TOKEN",
        },
      ]);
    },
  );

  it("rejects receipt recovery when a required messaging provider did not survive", async () => {
    const messagingPlan = discordMessagingPlan();
    const stageSandboxCredentialProviders = vi
      .fn()
      .mockRejectedValueOnce(new Error("gateway connection dropped mid-registration"))
      .mockResolvedValueOnce([]);
    const providerMatchesGatewayCredential = vi.fn(() => false);
    const session = createSession({ sessionId: "sess-1", agent: "openclaw" });
    const { deps, calls, getSession } = createDeps(
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
    await expect(
      handleSandboxState({
        ...baseOptions(deps, crashedSession),
        resume: true,
        sandboxName: "my-assistant",
      }),
    ).rejects.toThrow("exit 1");

    expect(stageSandboxCredentialProviders).toHaveBeenCalledTimes(2);
    expect(providerMatchesGatewayCredential).toHaveBeenCalledWith(
      "my-assistant-discord-bridge",
      "nemoclaw-mcp-v1",
      "DISCORD_BOT_TOKEN",
    );
    expect(getSession().checkpoint?.effectGroups.messaging_providers).toBeUndefined();
    expect(calls.createSandbox).not.toHaveBeenCalled();
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

  it("does not let checkpoint replay override an explicit fresh recreation (#8847)", async () => {
    const session = sessionWithCheckpoint(crashedCheckpoint());
    const { deps, calls } = createDeps({ getSandboxReuseState: () => "ready" });

    await handleSandboxState({
      ...baseOptions(deps, session),
      fresh: true,
      recreateSandbox: () => true,
      sandboxName: "my-assistant",
    });

    expect(calls.skipped).not.toHaveBeenCalledWith("sandbox", "my-assistant");
    expect(calls.createSandbox).toHaveBeenCalledTimes(1);
    expect(calls.createSandbox.mock.calls[0]?.at(-2)).toMatchObject({ recreate: true });
  });

  it.each([["build", defaultCreateFingerprint("v0.0.108")]] as const)(
    "recreates after %s drift when explicitly requested (#9297)",
    async (_drift, fingerprint) => {
      const session = sessionWithCheckpoint(
        crashedCheckpoint({
          effectGroups: {
            sandbox_create: { completedAt: "2026-01-01T00:00:00.000Z", fingerprint },
          },
        }),
      );
      session.machine.state = "openclaw";
      const { deps, calls } = createDeps({ getSandboxReuseState: () => "ready" }, session);

      await handleSandboxState({
        ...baseOptions(deps, session),
        resume: true,
        sandboxName: "my-assistant",
        recreateSandbox: () => true,
      });

      expect(calls.createSandbox).toHaveBeenCalledOnce();
      expect(calls.createSandbox.mock.calls[0]?.at(-2)).toEqual(
        expect.objectContaining({ recreate: true }),
      );
      expect(calls.error).not.toHaveBeenCalled();
    },
  );

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

  it("rejects reasoning capability drift before replaying a recorded sandbox create (#7570)", async () => {
    const session = createSession({ sessionId: "sess-1", agent: "openclaw" });
    const updateSession = vi.fn((mutator: (value: typeof session) => void) => {
      mutator(session);
      return session;
    });
    const firstRun = createDeps({ getSandboxReuseState: () => "missing", updateSession });

    await handleSandboxState({
      ...baseOptions(firstRun.deps, session),
      compatibleEndpointReasoning: "true",
      resume: false,
      sandboxName: "my-assistant",
    });

    const resumedRun = createDeps({ getSandboxReuseState: () => "missing", updateSession });
    await expect(
      handleSandboxState({
        ...baseOptions(resumedRun.deps, session),
        compatibleEndpointReasoning: "false",
        resume: true,
        sandboxName: "my-assistant",
      }),
    ).rejects.toThrow("exit 1");

    expect(resumedRun.calls.createSandbox).not.toHaveBeenCalled();
    expect(resumedRun.calls.error.mock.calls.flat().join("\n")).toContain("--recreate-sandbox");
  });

  it("rejects provider removal after replay validation and before sandbox creation (#7022)", async () => {
    let liveCheckCount = 0;
    const providerMatchesGatewayCredential = vi.fn(() => {
      liveCheckCount += 1;
      return liveCheckCount === 1;
    });
    const session = sessionWithCheckpoint(
      crashedCheckpoint({
        webSearch: decisionSelected({ fetchEnabled: true, provider: "brave" }),
        effectGroups: {
          web_search_provider: {
            completedAt: "2026-01-01T00:00:00.000Z",
            fingerprint: "my-assistant-brave-search",
          },
        },
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

  it("creates the missing sandbox when its exact registered provider binding remains live (#7022)", async () => {
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

  it.each(["interactive", "non-interactive"] as const)(
    "resumes a %s onboarding attempt that crashed after create succeeded but before its completion receipt (#7022)",
    async (mode) => {
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
    },
  );

  it.each(["interactive", "non-interactive"] as const)(
    "backfills effect receipts after a %s crash following sandbox registration (#7022)",
    async (mode) => {
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
        getSandboxRegistryEntry: () => ({
          name: "my-assistant",
          agent: null,
          provider: "provider",
          model: "model",
          endpointUrl: null,
          preferredInferenceApi: "openai-completions",
          gatewayName: "nemoclaw",
          gatewayPort: 8080,
          pendingRouteReservation: true,
          reservationSessionId: persistedSession.sessionId,
        }),
      });

      await handleSandboxState({
        ...baseOptions(resumedRun.deps, persistedSession),
        resume: true,
        sandboxName: "my-assistant",
        authoritativeResumeConfig: true,
      });

      expect(resumedRun.calls.createSandbox).not.toHaveBeenCalled();
      expect(recordStateSkipped).toHaveBeenCalledTimes(1);
      expect(resumedRun.calls.finalizeRouteReservation).toHaveBeenCalledExactlyOnceWith(
        "my-assistant",
        persistedSession.sessionId,
      );
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
    },
  );
});
