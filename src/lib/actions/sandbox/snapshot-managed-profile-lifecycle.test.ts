// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SandboxMessagingPlan } from "../../messaging/manifest";
import { decodeManagedStartupProfile } from "../../onboard/managed-startup/profile";
import { buildManagedStartupProfile } from "../../onboard/managed-startup/profile-builder";
import { SANDBOX_CREATE_MAX_ARGUMENT_BYTES } from "../../onboard/sandbox-create/transport";
import { withSandboxMutationLock } from "../../state/mcp-lifecycle-lock";
import * as f from "./snapshot-restore-test-fixture";

const tempHomes: string[] = [];
const PROXY_ENV_NAMES = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const;

function managedMessagingPlan(
  agent: "openclaw" | "hermes",
  sandboxName: string,
  allowedId: string,
  credentialHash?: string,
): SandboxMessagingPlan {
  return {
    schemaVersion: 1,
    sandboxName,
    agent,
    workflow: "onboard",
    channels: [
      {
        channelId: "telegram",
        configured: true,
        active: true,
        disabled: false,
        inputs: [
          { inputId: "botToken", credentialAvailable: true },
          { inputId: "allowedIds", value: [allowedId] },
        ],
      },
    ],
    disabledChannels: [],
    credentialBindings: credentialHash
      ? [
          {
            channelId: "telegram",
            providerEnvKey: "TELEGRAM_BOT_TOKEN",
            credentialAvailable: true,
            credentialHash,
          },
        ]
      : [],
    networkPolicy: { presets: [], entries: [] },
    agentRender: [],
    buildSteps: [],
    runtimeSetup: { nodePreloads: [], envAliases: [], secretScans: [] },
    stateUpdates: [],
    healthChecks: [],
  } as unknown as SandboxMessagingPlan;
}

function providerMetadata(name: string, type: string, credentialEnv: string): string {
  return [
    `Name: ${name}`,
    `Type: ${type}`,
    `Credential keys: ${credentialEnv}`,
    "Config keys: <none>",
    "",
  ].join("\n");
}

function managedOpenClawProfile() {
  return buildManagedStartupProfile({
    agent: "openclaw",
    inference: {
      routeProvider: "inference",
      upstreamProvider: "openai-api",
      model: "gpt-5.4",
      routedBaseUrl: "https://inference.local/v1",
      upstreamEndpointUrl: null,
      api: "openai-responses",
      primaryModelRef: "inference/gpt-5.4",
      compatibility: {},
    },
    dashboard: {
      agent: "openclaw",
      mode: "loopback",
      url: "http://127.0.0.1:18789",
      port: 18_789,
      bindAddress: "127.0.0.1",
      wslExposure: false,
    },
    webSearch: null,
    toolDisclosure: "progressive",
    hermesToolGateways: [],
    messagingPlan: null,
    dcodeAutoApprovalMode: null,
    observabilityEnabled: null,
    environment: {},
    corporateCa: null,
  });
}

beforeEach(() => {
  f.resetSnapshotRestoreMocks();
});
afterEach(() => {
  f.cleanupSnapshotRestoreMocks();
  for (const tempHome of tempHomes.splice(0)) {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});
describe("runSandboxSnapshot restore: lifecycle and destination safety", () => {
  it("refuses provider replacement when an unrelated sandbox is attached", async () => {
    const commands: Array<{ args: string[]; options?: Record<string, unknown> }> = [];
    const runner = vi.fn((args: string[], options?: Record<string, unknown>) => {
      commands.push({ args, options });
      if (args.join(" ") === "provider get beta-telegram-bridge") {
        return {
          status: 0,
          stdout: providerMetadata("beta-telegram-bridge", "generic", "TELEGRAM_BOT_TOKEN"),
        };
      }
      if (args.join(" ") === "provider delete beta-telegram-bridge") {
        return {
          status: 1,
          stderr: "provider 'beta-telegram-bridge' is attached to sandbox(es): beta, gamma",
        };
      }
      return { status: 0 };
    });
    const { provisionManagedCloneProviders } = await import("./snapshot/managed-clone-providers");

    expect(() =>
      provisionManagedCloneProviders(
        [
          {
            providerName: "beta-telegram-bridge",
            providerType: "generic",
            providerEnvKey: "TELEGRAM_BOT_TOKEN",
            source: "messaging",
            replaceExistingCredential: true,
          },
        ],
        {
          environment: { TELEGRAM_BOT_TOKEN: "replacement-secret" },
          runOpenshell: runner,
          rollbackSandboxName: "beta",
        },
      ),
    ).toThrow("is still attached outside destination 'beta'");
    expect(commands.some(({ args }) => args[0] === "sandbox")).toBe(false);
    expect(commands.some(({ args }) => ["create", "update"].includes(args[1] ?? ""))).toBe(false);
    expect(commands.every(({ options }) => options?.env === undefined)).toBe(true);
  });

  it("starts and registers a managed DCode clone with its receipt-bound profile transport", async () => {
    const built = buildManagedStartupProfile({
      agent: "langchain-deepagents-code",
      inference: {
        routeProvider: "inference",
        upstreamProvider: "openrouter",
        model: "openai/gpt-5.4",
        routedBaseUrl: "https://inference.local/v1",
        upstreamEndpointUrl: "https://openrouter.ai/api/v1",
        api: "openai-completions",
        primaryModelRef: null,
        compatibility: null,
      },
      dashboard: { agent: "langchain-deepagents-code", mode: "disabled" },
      webSearch: null,
      toolDisclosure: "progressive",
      hermesToolGateways: [],
      messagingPlan: null,
      dcodeAutoApprovalMode: "disabled",
      observabilityEnabled: false,
      environment: {},
      corporateCa: null,
    });
    const reference = `ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox@sha256:${"a".repeat(
      64,
    )}`;
    const source = {
      name: "alpha",
      agent: "langchain-deepagents-code",
      imageTag: reference,
      openshellDriver: "docker",
      provider: "openrouter",
      model: "openai/gpt-5.4",
      endpointUrl: "https://openrouter.ai/api/v1",
      preferredInferenceApi: "openai-completions",
      toolDisclosure: "progressive",
      dcodeAutoApprovalMode: "disabled",
      observabilityEnabled: false,
      workload: {
        schemaVersion: 1,
        kind: "managed-image",
        reference,
        release: "v0.0.99",
        sourceRevision: "b".repeat(40),
        sourceCohort: "ghrun-123456-1",
        capabilityContractVersion: 1,
        startupProfileContractVersion: 1,
        encodedProfile: built.encodedProfile,
        startupProfileSha256: built.startupProfileSha256,
        credentialProxyReplayRequired: false,
        shared: true,
      },
    } as const;
    let registeredClone: f.SandboxRecord | null = null;
    f.registerSandboxMock.mockImplementation(
      (entry) => (registeredClone = entry as f.SandboxRecord),
    );
    f.getSandboxMock.mockImplementation((name) =>
      name === "alpha" ? (source as never) : registeredClone,
    );
    f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha"]));
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("idle") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
    f.restoreSandboxStateMock.mockReturnValue({
      success: true,
      restoredDirs: ["workspace"],
      restoredFiles: [],
      failedDirs: [],
      failedFiles: [],
    });
    vi.stubEnv("NEMOCLAW_STARTUP_PROFILE_B64", "ambient-profile");
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "restore", to: "beta" });

    const createCall = f.streamSandboxCreateMock.mock.calls[0] ?? [];
    const createExecutable = createCall[0] as string;
    const createArgs = createCall[1] as readonly string[];
    const createEnv = createCall[2] as NodeJS.ProcessEnv | undefined;
    expect(
      [createExecutable, ...createArgs].every(
        (argument) => Buffer.byteLength(argument, "utf8") + 1 <= SANDBOX_CREATE_MAX_ARGUMENT_BYTES,
      ),
    ).toBe(true);
    expect(createArgs.slice(createArgs.lastIndexOf("--") + 1)).toEqual([
      "env",
      `NEMOCLAW_STARTUP_PROFILE_B64=${built.encodedProfile}`,
      "nemoclaw-start",
    ]);
    expect(createEnv?.NEMOCLAW_STARTUP_PROFILE_B64).toBeUndefined();
    expect(f.registerSandboxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "beta",
        workload: source.workload,
        messaging: undefined,
      }),
    );
  });

  it("reconciles a stale OpenClaw receipt to current inference and messaging before clone launch", async () => {
    const oldMessaging = managedMessagingPlan("openclaw", "alpha", "111111");
    const staleSourceCredentialHash = "f".repeat(64);
    const currentMessaging = managedMessagingPlan(
      "openclaw",
      "alpha",
      "222222",
      staleSourceCredentialHash,
    );
    const built = buildManagedStartupProfile({
      agent: "openclaw",
      inference: {
        routeProvider: "openai",
        upstreamProvider: "openai-api",
        model: "gpt-5.4",
        routedBaseUrl: "https://inference.local/v1",
        upstreamEndpointUrl: null,
        api: "openai-responses",
        primaryModelRef: "openai/gpt-5.4",
        compatibility: {},
      },
      dashboard: {
        agent: "openclaw",
        mode: "loopback",
        url: "http://127.0.0.1:18789",
        port: 18_789,
        bindAddress: "127.0.0.1",
        wslExposure: false,
      },
      webSearch: { fetchEnabled: false, provider: "brave" },
      toolDisclosure: "progressive",
      hermesToolGateways: [],
      messagingPlan: oldMessaging,
      dcodeAutoApprovalMode: null,
      observabilityEnabled: null,
      environment: { NEMOCLAW_CONTEXT_WINDOW: "65536" },
      corporateCa: null,
    });
    const reference = `ghcr.io/nvidia/nemoclaw/openclaw-sandbox@sha256:${"a".repeat(64)}`;
    const source = {
      name: "alpha",
      agent: "openclaw",
      dashboardPort: 18_789,
      dashboardRemoteBindPrepared: false,
      imageTag: reference,
      openshellDriver: "docker",
      provider: "openai-api",
      model: "gpt-5.5",
      endpointUrl: null,
      preferredInferenceApi: "openai-responses",
      compatibleEndpointReasoning: null,
      toolDisclosure: "direct",
      webSearchEnabled: true,
      webSearchProvider: "brave",
      messaging: { schemaVersion: 1, plan: currentMessaging },
      workload: {
        schemaVersion: 1,
        kind: "managed-image",
        reference,
        release: "v0.0.99",
        sourceRevision: "b".repeat(40),
        sourceCohort: "ghrun-123456-1",
        capabilityContractVersion: 1,
        startupProfileContractVersion: 1,
        encodedProfile: built.encodedProfile,
        startupProfileSha256: built.startupProfileSha256,
        credentialProxyReplayRequired: false,
        shared: true,
      },
    } as const;
    let registeredClone: f.SandboxRecord | null = null;
    f.registerSandboxMock.mockImplementation(
      (entry) => (registeredClone = entry as f.SandboxRecord),
    );
    f.getSandboxMock.mockImplementation((name) =>
      name === "alpha" ? (source as never) : registeredClone,
    );
    f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha"]));
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "forward list": {
          status: 0,
          output: "alpha 127.0.0.1 18789 23189 running\n",
        },
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "clone-only-token");
    vi.stubEnv("BRAVE_API_KEY", "clone-only-brave-key");
    const createdProviders = new Set<string>();
    f.runOpenshellMock.mockImplementation((args) => {
      if (args[0] === "provider" && args[1] === "get") {
        const providerName = args[2] ?? "";
        const binding =
          providerName === "beta-telegram-bridge"
            ? { type: "generic", credential: "TELEGRAM_BOT_TOKEN" }
            : providerName === "beta-brave-search"
              ? { type: "brave", credential: "BRAVE_API_KEY" }
              : null;
        return binding && createdProviders.has(providerName)
          ? {
              status: 0,
              stdout: providerMetadata(providerName, binding.type, binding.credential),
              stderr: "",
              output: "",
            }
          : { status: 1, stdout: "", stderr: "", output: "" };
      }
      if (args[0] === "provider" && args[1] === "create") {
        createdProviders.add(args[3] ?? "");
        return { status: 0, stdout: "", stderr: "", output: "" };
      }
      return { status: 0, output: "" };
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "restore", to: "beta" });

    const createArgs = f.streamSandboxCreateMock.mock.calls[0]?.[1] as readonly string[];
    expect(createArgs).toContain("beta-telegram-bridge");
    expect(
      createArgs.some(
        (argument, index) =>
          argument === "--provider" && createArgs[index + 1] === "beta-telegram-bridge",
      ),
    ).toBe(true);
    expect(
      createArgs.some(
        (argument, index) =>
          argument === "--provider" && createArgs[index + 1] === "beta-brave-search",
      ),
    ).toBe(true);
    expect(f.runOpenshellMock).toHaveBeenCalledWith(
      [
        "provider",
        "create",
        "--name",
        "beta-telegram-bridge",
        "--type",
        "generic",
        "--credential",
        "TELEGRAM_BOT_TOKEN",
      ],
      expect.objectContaining({
        env: { TELEGRAM_BOT_TOKEN: "clone-only-token" },
      }),
    );
    expect(f.runOpenshellMock).toHaveBeenCalledWith(
      [
        "provider",
        "create",
        "--name",
        "beta-brave-search",
        "--type",
        "brave",
        "--credential",
        "BRAVE_API_KEY",
      ],
      expect.objectContaining({
        env: { BRAVE_API_KEY: "clone-only-brave-key" },
      }),
    );
    const encodedProfile =
      createArgs
        .find((argument) => argument.startsWith("NEMOCLAW_STARTUP_PROFILE_B64="))
        ?.slice("NEMOCLAW_STARTUP_PROFILE_B64=".length) ?? "";
    expect(encodedProfile).not.toBe(built.encodedProfile);
    const profile = decodeManagedStartupProfile(encodedProfile);
    expect(profile.inference).toMatchObject({
      upstreamProvider: "openai-api",
      model: "gpt-5.5",
      api: "openai-responses",
      primaryModelRef: "openai/gpt-5.5",
    });
    expect(profile.tuning.contextWindow).toBe(131_072);
    expect(profile.tools.disclosure).toBe("direct");
    expect(profile.agentConfig).toMatchObject({
      agent: "openclaw",
      webSearch: { enabled: true, provider: "brave" },
    });
    const plan = profile.messaging.plan as unknown as SandboxMessagingPlan;
    expect(plan.sandboxName).toBe("beta");
    expect(plan.channels[0]?.inputs).toContainEqual(
      expect.objectContaining({
        inputId: "allowedIds",
        value: ["222222"],
      }),
    );
    expect(JSON.stringify(plan)).not.toContain("111111");
    expect(JSON.stringify(plan)).not.toContain(staleSourceCredentialHash);
    expect(plan.credentialBindings[0]).not.toHaveProperty("credentialHash");
    expect(encodedProfile).not.toContain("clone-only-token");
    expect(f.registerSandboxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "beta",
        provider: "openai-api",
        model: "gpt-5.5",
        preferredInferenceApi: "openai-responses",
        toolDisclosure: "direct",
        webSearchEnabled: true,
        webSearchProvider: "brave",
        workload: expect.objectContaining({ encodedProfile }),
        messaging: expect.objectContaining({
          schemaVersion: 1,
          plan: expect.objectContaining({ sandboxName: "beta" }),
        }),
      }),
    );
  });

  it("reconciles a stale Hermes receipt to current route, tools, dashboard, and messaging", async () => {
    const oldMessaging = managedMessagingPlan("hermes", "alpha", "111111");
    const currentMessaging = managedMessagingPlan("hermes", "alpha", "333333");
    const built = buildManagedStartupProfile({
      agent: "hermes",
      inference: {
        routeProvider: "inference",
        upstreamProvider: "compatible-anthropic-endpoint",
        model: "old-model",
        routedBaseUrl: "https://inference.local/v1",
        upstreamEndpointUrl: null,
        api: "openai-completions",
        primaryModelRef: null,
        compatibility: null,
      },
      dashboard: {
        agent: "hermes",
        mode: "loopback-forwarded",
        url: "http://127.0.0.1:19189",
        publicPort: 19_189,
        internalPort: 29_000,
        tuiEnabled: true,
      },
      webSearch: { fetchEnabled: false, provider: "tavily" },
      toolDisclosure: "progressive",
      hermesToolGateways: [],
      messagingPlan: oldMessaging,
      dcodeAutoApprovalMode: null,
      observabilityEnabled: null,
      environment: {},
      corporateCa: null,
    });
    const reference = `ghcr.io/nvidia/nemoclaw/hermes-sandbox@sha256:${"a".repeat(64)}`;
    const source = {
      name: "alpha",
      agent: "hermes",
      dashboardPort: 19_189,
      hermesDashboardEnabled: true,
      hermesDashboardPort: 19_189,
      hermesDashboardInternalPort: 29_189,
      hermesDashboardTui: false,
      imageTag: reference,
      openshellDriver: "docker",
      provider: "hermes-provider",
      model: "new-model",
      endpointUrl: null,
      preferredInferenceApi: "openai-completions",
      toolDisclosure: "direct",
      webSearchEnabled: true,
      webSearchProvider: "tavily",
      hermesToolGateways: [],
      messaging: { schemaVersion: 1, plan: currentMessaging },
      workload: {
        schemaVersion: 1,
        kind: "managed-image",
        reference,
        release: "v0.0.99",
        sourceRevision: "b".repeat(40),
        sourceCohort: "ghrun-123456-1",
        capabilityContractVersion: 1,
        startupProfileContractVersion: 1,
        encodedProfile: built.encodedProfile,
        startupProfileSha256: built.startupProfileSha256,
        credentialProxyReplayRequired: false,
        shared: true,
      },
    } as const;
    let registeredClone: f.SandboxRecord | null = null;
    f.registerSandboxMock.mockImplementation(
      (entry) => (registeredClone = entry as f.SandboxRecord),
    );
    f.getSandboxMock.mockImplementation((name) =>
      name === "alpha" ? (source as never) : registeredClone,
    );
    f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha"]));
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "forward list": {
          status: 0,
          output: "alpha 127.0.0.1 19189 23189 running\n",
        },
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "clone-only-hermes-token");
    vi.stubEnv("TAVILY_API_KEY", "clone-only-tavily-key");
    const createdProviders = new Set<string>();
    f.runOpenshellMock.mockImplementation((args) => {
      if (args[0] === "provider" && args[1] === "get") {
        const providerName = args[2] ?? "";
        const binding =
          providerName === "beta-telegram-bridge"
            ? { type: "generic", credential: "TELEGRAM_BOT_TOKEN" }
            : providerName === "beta-tavily-search"
              ? { type: "tavily-hermes-v1", credential: "TAVILY_API_KEY" }
              : null;
        return binding && createdProviders.has(providerName)
          ? {
              status: 0,
              stdout: providerMetadata(providerName, binding.type, binding.credential),
              stderr: "",
              output: "",
            }
          : { status: 1, stdout: "", stderr: "", output: "" };
      }
      if (args[0] === "provider" && args[1] === "create") {
        createdProviders.add(args[3] ?? "");
        return { status: 0, stdout: "", stderr: "", output: "" };
      }
      return { status: 0, output: "" };
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "restore", to: "beta" });

    const createArgs = f.streamSandboxCreateMock.mock.calls[0]?.[1] as readonly string[];
    const encodedProfile =
      createArgs
        .find((argument) => argument.startsWith("NEMOCLAW_STARTUP_PROFILE_B64="))
        ?.slice("NEMOCLAW_STARTUP_PROFILE_B64=".length) ?? "";
    const profile = decodeManagedStartupProfile(encodedProfile);
    expect(profile.inference).toMatchObject({
      upstreamProvider: "hermes-provider",
      model: "new-model",
      api: "openai-completions",
    });
    expect(profile.tools).toEqual({
      disclosure: "direct",
      enabledGateways: [],
    });
    expect(profile.agentConfig).toMatchObject({
      agent: "hermes",
      webSearch: { enabled: true, provider: "tavily" },
    });
    expect(profile.dashboard).toMatchObject({
      agent: "hermes",
      mode: "loopback-forwarded",
      internalPort: 29_189,
      tuiEnabled: false,
    });
    const plan = profile.messaging.plan as unknown as SandboxMessagingPlan;
    expect(plan.sandboxName).toBe("beta");
    expect(plan.channels[0]?.inputs).toContainEqual(
      expect.objectContaining({
        inputId: "allowedIds",
        value: ["333333"],
      }),
    );
    expect(JSON.stringify(plan)).not.toContain("111111");
    expect(
      createArgs.some(
        (argument, index) =>
          argument === "--provider" && createArgs[index + 1] === "beta-tavily-search",
      ),
    ).toBe(true);
    expect(f.runOpenshellMock).toHaveBeenCalledWith(
      [
        "provider",
        "create",
        "--name",
        "beta-tavily-search",
        "--type",
        "tavily-hermes-v1",
        "--credential",
        "TAVILY_API_KEY",
      ],
      expect.objectContaining({
        env: { TAVILY_API_KEY: "clone-only-tavily-key" },
      }),
    );
    expect(f.registerSandboxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "beta",
        provider: "hermes-provider",
        model: "new-model",
        preferredInferenceApi: "openai-completions",
        toolDisclosure: "direct",
        webSearchEnabled: true,
        webSearchProvider: "tavily",
        hermesToolGateways: undefined,
        hermesDashboardInternalPort: 29_189,
        hermesDashboardTui: undefined,
        workload: expect.objectContaining({ encodedProfile }),
      }),
    );
  });

  it("replays launch-only authenticated proxies when cloning a managed OpenClaw sandbox", async () => {
    const built = managedOpenClawProfile();
    const reference = `ghcr.io/nvidia/nemoclaw/openclaw-sandbox@sha256:${"a".repeat(64)}`;
    const source = {
      name: "alpha",
      agent: "openclaw",
      dashboardPort: 18_789,
      imageTag: reference,
      openshellDriver: "docker",
      provider: "openai-api",
      model: "gpt-5.4",
      workload: {
        schemaVersion: 1,
        kind: "managed-image",
        reference,
        release: "v0.0.99",
        sourceRevision: "b".repeat(40),
        sourceCohort: "ghrun-123456-1",
        capabilityContractVersion: 1,
        startupProfileContractVersion: 1,
        encodedProfile: built.encodedProfile,
        startupProfileSha256: built.startupProfileSha256,
        credentialProxyReplayRequired: true,
        shared: true,
      },
    } as const;
    let registeredClone: f.SandboxRecord | null = null;
    f.registerSandboxMock.mockImplementation(
      (entry) => (registeredClone = entry as f.SandboxRecord),
    );
    f.getSandboxMock.mockImplementation((name) =>
      name === "alpha" ? (source as never) : registeredClone,
    );
    f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha"]));
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "forward list": {
          status: 0,
          output: "alpha 127.0.0.1 18789 23189 running\n",
        },
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
    f.restoreSandboxStateMock.mockReturnValue({
      success: true,
      restoredDirs: ["workspace"],
      restoredFiles: [],
      failedDirs: [],
      failedFiles: [],
    });
    const credentialProxyEnvironment = {
      HTTP_PROXY: "http://upper-http:upper-pass@upper-http.example.test:18080",
      HTTPS_PROXY: "http://upper-https:upper-pass@upper-https.example.test:18443",
      NO_PROXY: "upper.internal",
      http_proxy: "http://lower-http:lower-pass@lower-http.example.test:28080",
      https_proxy: "http://lower-https:lower-pass@lower-https.example.test:28443",
      no_proxy: "lower.internal",
    } as const;
    for (const [name, value] of Object.entries(credentialProxyEnvironment)) {
      vi.stubEnv(name, value);
    }
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "restore", to: "beta" });

    const createCall = f.streamSandboxCreateMock.mock.calls[0] ?? [];
    const createArgs = createCall[1] as readonly string[];
    const startupArgs = createArgs.slice(createArgs.lastIndexOf("--") + 1);
    expect(startupArgs).toEqual([
      "env",
      "HTTP_PROXY=http://upper-http:upper-pass@upper-http.example.test:18080",
      "HTTPS_PROXY=http://upper-https:upper-pass@upper-https.example.test:18443",
      expect.stringMatching(/^NO_PROXY=upper\.internal,localhost,/u),
      "http_proxy=http://lower-http:lower-pass@lower-http.example.test:28080",
      "https_proxy=http://lower-https:lower-pass@lower-https.example.test:28443",
      expect.stringMatching(/^no_proxy=lower\.internal,localhost,/u),
      expect.stringMatching(/^NEMOCLAW_STARTUP_PROFILE_B64=/u),
      "nemoclaw-start",
    ]);
    const encodedProfile =
      startupArgs
        .find((argument) => argument.startsWith("NEMOCLAW_STARTUP_PROFILE_B64="))
        ?.slice("NEMOCLAW_STARTUP_PROFILE_B64=".length) ?? "";
    const reboundDashboard = decodeManagedStartupProfile(encodedProfile).dashboard;
    expect(reboundDashboard).toMatchObject({ agent: "openclaw" });
    if (reboundDashboard.agent !== "openclaw") throw new Error("fixture mismatch");
    expect(reboundDashboard.port).not.toBe(18_789);
    expect(new URL(reboundDashboard.url).port).toBe(String(reboundDashboard.port));
    const registration = f.registerSandboxMock.mock.calls[0]?.[0] as
      | { workload?: { credentialProxyReplayRequired?: boolean; encodedProfile?: string } }
      | undefined;
    expect(registration?.workload?.credentialProxyReplayRequired).toBe(true);
    expect(registration?.workload?.encodedProfile).toBe(encodedProfile);
    const durableReceipt = JSON.stringify(registration?.workload);
    expect(durableReceipt).not.toContain("upper-pass");
    expect(durableReceipt).not.toContain("lower-pass");
  });
});
