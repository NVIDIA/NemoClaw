// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Bridge-provider lifecycle on the DIRECT `channels add` path (#6120): a
// bridge-backed channel (googlechat) declares no manifest credentials, so the
// add path must (1) create + refresh-configure the gateway bridge provider
// itself, (2) exit with an error when the pasted secret is missing, and (3)
// detach and delete the newly created provider when gateway registration fails.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import {
  addSandboxChannel,
  removeSandboxChannel,
  startSandboxChannel,
  stopSandboxChannel,
} from "../../src/lib/actions/sandbox/policy-channel";
import { policyChannelDependencies } from "../../src/lib/actions/sandbox/policy-channel-dependencies";
import * as processRecovery from "../../src/lib/actions/sandbox/process-recovery";
import * as runtime from "../../src/lib/adapters/openshell/runtime";
import * as store from "../../src/lib/credentials/store";
import * as gatewayRuntime from "../../src/lib/gateway-runtime-action";
import { MESSAGING_BRIDGE_PENDING_VALUE } from "../../src/lib/onboard/messaging-bridge-provider";
import * as policies from "../../src/lib/policy";
import * as onboardSession from "../../src/lib/state/onboard-session";
import type { SandboxEntry } from "../../src/lib/state/registry";
import * as registry from "../../src/lib/state/registry";

class ExitError extends Error {
  constructor(public readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

const SA_JSON = JSON.stringify({
  client_email: "bot@p.iam.gserviceaccount.com",
  private_key: "fake-test-private-key-material",
});

const GOOGLECHAT_ENV = {
  GOOGLECHAT_SERVICE_ACCOUNT: SA_JSON,
  GOOGLECHAT_AUDIENCE: "https://bot.example.com/googlechat",
  GOOGLECHAT_APP_PRINCIPAL: "123456789012345678901",
};
// Deliberately independent of the checked-in YAML read by production. If that
// contract changes without the simulated gateway export changing too, the real
// adapter comparison in this lifecycle test must fail.
const GOOGLECHAT_PROFILE_DOC: Record<string, unknown> = {
  id: "google-chat-bridge",
  credentials: [
    {
      name: "access_token",
      env_vars: ["GOOGLE_CHAT_ACCESS_TOKEN"],
      required: true,
      auth_style: "bearer",
      header_name: "Authorization",
      query_param: "",
      refresh: {
        strategy: "google-service-account-jwt",
        scopes: ["https://www.googleapis.com/auth/chat.bot"],
        material: [
          {
            name: "client_email",
            description: "Service-account client email (JWT issuer)",
            required: true,
          },
          {
            name: "private_key",
            description: "Service-account RSA private key (PEM); signs the JWT assertion",
            required: true,
            secret: true,
          },
          {
            name: "scope",
            description: "OAuth scope(s) to mint the token for",
          },
        ],
      },
    },
  ],
  endpoints: [
    {
      host: "chat.googleapis.com",
      port: 443,
      protocol: "rest",
      access: "read-write",
      enforcement: "enforce",
    },
  ],
  binaries: ["/usr/local/bin/node", "/usr/bin/node"],
  inference_capable: false,
};
const LIVE_IDENTITY_FINGERPRINT = "a".repeat(64);

// Why this mock exists: the real googlechat tunnel/audience gate needs a human
// operator (Google Cloud Console steps), so on a non-interactive test run it
// throws and the whole channel is skipped — the add path under test would
// never execute.
//
// What it does: keep the module intact except the gate's registration, whose
// handler is replaced with one that succeeds immediately — as if the operator
// had already finished enrollment. Everything else in the add path runs real.
type GateModule =
  typeof import("../../src/lib/messaging/channels/googlechat/hooks/tunnel-audience-gate");

vi.mock(
  "../../src/lib/messaging/channels/googlechat/hooks/tunnel-audience-gate",
  async (importOriginal) => {
    const actual = await importOriginal<GateModule>();
    return {
      ...actual,
      createGooglechatTunnelAudienceGateHookRegistration: () => ({
        id: actual.GOOGLECHAT_TUNNEL_AUDIENCE_GATE_HOOK_ID,
        handler: async () => ({}),
      }),
    };
  },
);

const originalProcessEnv = { ...process.env };

let errorSpy: MockInstance;
let logSpy: MockInstance;
let exitSpy: MockInstance;
let providerSpy: MockInstance;
let runOpenshellSpy: MockInstance;
let stopGooglechatWebhookTunnelSpy: MockInstance;
let testHome: string;
let registryEntry: SandboxEntry;
let appliedPresets: string[];
let session: onboardSession.Session;
let stdinIsTty: PropertyDescriptor | undefined;
let gatewayCallCount: number;
let bridgeRefreshWasSecure: boolean;
let bridgeProfileRegistered: boolean;
let bridgeProfileWasImported: boolean;
let detachedProviders: Set<string>;
let deletedProviders: Set<string>;
let registeredProviders: Set<string>;
let bridgeRefreshError: string | null;
let bridgeRefreshStatusError: string | null;
let providerDeleteError: string | null;

function printedText(): string {
  return [...logSpy.mock.calls, ...errorSpy.mock.calls]
    .map((call) => call.map(String).join(" "))
    .join("\n");
}

function withoutGateway(args: readonly string[]): string[] {
  const index = args[2] === "-g" ? 2 : args[3] === "-g" ? 3 : -1;
  return index < 0 ? [...args] : [...args.slice(0, index), ...args.slice(index + 2)];
}

function resetGatewayObservations(): void {
  gatewayCallCount = 0;
  bridgeRefreshWasSecure = false;
  bridgeProfileWasImported = false;
  detachedProviders.clear();
  deletedProviders.clear();
}

beforeEach(() => {
  stdinIsTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-add-bridge-"));
  process.env.HOME = testHome;
  process.env.NEMOCLAW_NON_INTERACTIVE = "1";
  Object.assign(process.env, GOOGLECHAT_ENV);

  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitError(code);
  }) as never);

  registryEntry = {
    name: "test-sb",
    agent: "openclaw",
    gatewayName: "nemoclaw",
    lifecycleGeneration: "generation-1",
    lifecycleLiveIdentityFingerprint: LIVE_IDENTITY_FINGERPRINT,
  } as SandboxEntry;
  vi.spyOn(registry, "getSandbox").mockImplementation(() => registryEntry);
  vi.spyOn(registry, "listSandboxes").mockImplementation(() => ({
    sandboxes: [registryEntry],
    defaultSandbox: "test-sb",
  }));
  vi.spyOn(registry, "updateSandbox").mockImplementation((_name, update) => {
    registryEntry = { ...registryEntry, ...update } as SandboxEntry;
    return true;
  });
  vi.spyOn(registry, "getDisabledChannels").mockImplementation(() => [
    ...(registryEntry.messaging?.plan.disabledChannels ?? []),
  ]);

  appliedPresets = [];
  vi.spyOn(policies, "loadPresetForSandbox").mockReturnValue(
    "network_policies:\n  stub:\n    egress:\n      - host: example.com\n",
  );
  vi.spyOn(policies, "applyPreset").mockImplementation((_sandboxName, preset) => {
    appliedPresets = [...new Set([...appliedPresets, preset])];
    return true;
  });
  vi.spyOn(policies, "removePreset").mockImplementation((_sandboxName, preset) => {
    appliedPresets = appliedPresets.filter((name) => name !== preset);
    return true;
  });
  vi.spyOn(policies, "getAppliedPresets").mockImplementation(() => [...appliedPresets]);

  vi.spyOn(store, "getCredential").mockImplementation((key) => process.env[key] || null);
  vi.spyOn(store, "saveCredential").mockImplementation(() => undefined);
  vi.spyOn(store, "prompt").mockResolvedValue("y");

  session = {
    sandboxName: "test-sb",
  } as unknown as onboardSession.Session;
  vi.spyOn(onboardSession, "loadSession").mockReturnValue(session);
  vi.spyOn(onboardSession, "updateSession").mockImplementation((update) => {
    session = update(session) ?? session;
    return session;
  });

  // Keep the real provider orchestration on the success path so this test
  // crosses the direct channel action, generic provider upsert, and OpenShell
  // refresh boundary. Individual failure tests override the spy below.
  providerSpy = vi.spyOn(policyChannelDependencies, "upsertMessagingProviders");
  vi.spyOn(policyChannelDependencies, "revalidateChannelProviderPolicy").mockImplementation(
    () => undefined,
  );
  vi.spyOn(policyChannelDependencies, "inspectMessagingProviderAttachmentTarget").mockReturnValue(
    LIVE_IDENTITY_FINGERPRINT,
  );
  vi.spyOn(policyChannelDependencies, "rebuildSandbox").mockImplementation(async () => undefined);
  stopGooglechatWebhookTunnelSpy = vi
    .spyOn(policyChannelDependencies, "stopGooglechatWebhookTunnel")
    .mockImplementation(() => undefined);

  // Onboarding polls `provider refresh status` before creating the sandbox.
  // Status-table columns: PROVIDER, CREDENTIAL_KEY, STRATEGY, STATUS.
  const refreshStatusTable = (args: readonly string[]): string =>
    `${args[3] ?? ""}  ${args[5] ?? ""}  google-service-account-jwt  refreshed\n`;
  const isRefreshStatus = (args: readonly string[]): boolean => {
    const command = withoutGateway(args);
    return command[0] === "provider" && command[1] === "refresh" && command[2] === "status";
  };

  gatewayCallCount = 0;
  bridgeRefreshWasSecure = false;
  bridgeProfileRegistered = false;
  bridgeProfileWasImported = false;
  detachedProviders = new Set();
  deletedProviders = new Set();
  registeredProviders = new Set();
  bridgeRefreshError = null;
  bridgeRefreshStatusError = null;
  providerDeleteError = null;
  runOpenshellSpy = vi.spyOn(runtime, "runOpenshell").mockImplementation((args, options) => {
    gatewayCallCount += 1;
    const command = withoutGateway(args);
    const providerName = command[0] === "provider" && command[1] === "get" ? command[2] : null;
    const providerMissing = Boolean(providerName && !registeredProviders.has(providerName));
    const exportingProfile =
      command[0] === "provider" && command[1] === "profile" && command.includes("export");
    const importingProfile =
      command[0] === "provider" && command[1] === "profile" && command.includes("import");
    const profileMissing = exportingProfile && !bridgeProfileRegistered;
    bridgeProfileRegistered ||= importingProfile;
    bridgeProfileWasImported ||= importingProfile;
    const detachedProvider =
      command[0] === "sandbox" && command[1] === "provider" && command[2] === "detach"
        ? command[4]
        : null;
    const deletedProvider =
      command[0] === "provider" && command[1] === "delete" ? command[2] : null;
    const createdProvider =
      command[0] === "provider" && command[1] === "create"
        ? command[command.indexOf("--name") + 1]
        : null;
    const configuringRefresh =
      command[0] === "provider" && command[1] === "refresh" && command[2] === "configure";
    const readingRefreshStatus = isRefreshStatus(args);
    const refreshFailure = configuringRefresh ? bridgeRefreshError : null;
    const refreshStatusFailure = readingRefreshStatus ? bridgeRefreshStatusError : null;
    const deleteFailure = deletedProvider ? providerDeleteError : null;
    const commandFailure = refreshFailure ?? deleteFailure ?? "";
    detachedProvider ? detachedProviders.add(detachedProvider) : undefined;
    deletedProvider ? deletedProviders.add(deletedProvider) : undefined;
    deletedProvider && !deleteFailure ? registeredProviders.delete(deletedProvider) : undefined;
    createdProvider ? registeredProviders.add(createdProvider) : undefined;
    const runEnv = options?.env as Record<string, string> | undefined;
    bridgeRefreshWasSecure = configuringRefresh
      ? command.includes("--secret-material-env") &&
        command.includes("private_key=MESSAGING_BRIDGE_SECRET_0") &&
        !command.join(" ").includes("fake-test-private-key-material") &&
        runEnv?.MESSAGING_BRIDGE_SECRET_0 === "fake-test-private-key-material"
      : bridgeRefreshWasSecure;
    const invalidRefresh = configuringRefresh && !bridgeRefreshWasSecure;
    refreshStatusFailure
      ? (() => {
          throw new Error(refreshStatusFailure);
        })()
      : undefined;
    return {
      pid: 0,
      output: [null, "", ""],
      stdout: readingRefreshStatus
        ? refreshStatusTable(command)
        : exportingProfile && !profileMissing
          ? JSON.stringify(GOOGLECHAT_PROFILE_DOC)
          : providerName && !providerMissing
            ? `Name: ${providerName}\nType: google-chat-bridge\nCredential keys: GOOGLE_CHAT_ACCESS_TOKEN\nConfig keys: <none>\n`
          : "",
      stderr: invalidRefresh
        ? "invalid secret handoff"
        : commandFailure
          ? commandFailure
        : profileMissing
          ? "provider profile 'google-chat-bridge' not found"
          : providerMissing
            ? `provider '${args[args.length - 1]}' not found`
            : "",
      status:
        invalidRefresh || refreshFailure || deleteFailure || profileMissing || providerMissing
          ? 1
          : 0,
      signal: null,
    };
  });

  const healthyGatewayState = {
    state: "healthy_named",
    status: "",
    gatewayInfo: "",
    activeGateway: "nemoclaw",
  } as const;
  vi.spyOn(gatewayRuntime, "recoverNamedGatewayRuntime").mockResolvedValue({
    recovered: true,
    before: healthyGatewayState,
    after: healthyGatewayState,
    attempted: false,
  });

  vi.spyOn(processRecovery, "executeSandboxExecCommand").mockReturnValue({
    status: 0,
    stdout: "",
    stderr: "",
  });
  vi.spyOn(processRecovery, "executeSandboxCommand").mockReturnValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
  stdinIsTty
    ? Object.defineProperty(process.stdin, "isTTY", stdinIsTty)
    : Reflect.deleteProperty(process.stdin, "isTTY");
  fs.rmSync(testHome, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, originalProcessEnv);
});

describe("channels add owns the bridge-provider lifecycle (#6120)", () => {
  it("creates the bridge while keeping service-account material outside argv and durable state", async () => {
    await addSandboxChannel("test-sb", { channel: "googlechat" });

    expect(providerSpy).toHaveBeenCalledWith(
      [
        {
          name: "test-sb-googlechat-bridge",
          envKey: "GOOGLE_CHAT_ACCESS_TOKEN",
          token: MESSAGING_BRIDGE_PENDING_VALUE,
          providerType: "google-chat-bridge",
        },
      ],
      "nemoclaw",
      { bestEffort: true, requireExactBindings: true },
    );
    expect(bridgeProfileWasImported).toBe(true);
    expect(bridgeRefreshWasSecure).toBe(true);
    expect(JSON.stringify({ registryEntry, session })).not.toContain(
      "fake-test-private-key-material",
    );
    expect(printedText()).toContain("Registered googlechat bridge");
  });

  it("queues the rebuild instead of prompting when the session has no terminal (#8877)", async () => {
    delete process.env.NEMOCLAW_NON_INTERACTIVE;
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: undefined });
    const promptSpy = vi.spyOn(store, "prompt");

    await addSandboxChannel("test-sb", { channel: "googlechat" });

    expect(promptSpy).not.toHaveBeenCalled();
    expect(policyChannelDependencies.rebuildSandbox).not.toHaveBeenCalled();
    expect(printedText()).toContain("Change queued.");
  });

  it("exits with an error at add time when the bridge secret is not resolvable", async () => {
    delete process.env.GOOGLECHAT_SERVICE_ACCOUNT;

    await expect(addSandboxChannel("test-sb", { channel: "googlechat" })).rejects.toMatchObject({
      code: 1,
    });

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(providerSpy).not.toHaveBeenCalled();
    expect(printedText()).toContain("Missing required inputs for this channel.");
    expect(printedText()).not.toContain("GOOGLECHAT_SERVICE_ACCOUNT");
  });

  it("detaches and deletes the newly created bridge provider when registration fails", async () => {
    providerSpy.mockImplementation(() => {
      throw new Error("simulated gateway failure");
    });

    await expect(addSandboxChannel("test-sb", { channel: "googlechat" })).rejects.toMatchObject({
      code: 1,
    });

    expect(printedText()).toContain("Failed to register channel providers with the gateway.");
    expect(detachedProviders.has("test-sb-googlechat-bridge")).toBe(true);
    expect(deletedProviders.has("test-sb-googlechat-bridge")).toBe(true);
  });

  it("reports scoped recovery when refresh cleanup leaves a bridge provider", async () => {
    bridgeRefreshError = "refresh unavailable";
    providerDeleteError = "gateway unavailable";

    await expect(addSandboxChannel("test-sb", { channel: "googlechat" })).rejects.toMatchObject({
      code: 1,
    });

    const diagnostics = printedText();
    expect(diagnostics).toContain("test-sb-googlechat-bridge");
    expect(diagnostics).toContain("gateway unavailable");
    expect(diagnostics).toContain(
      'openshell provider delete -g "nemoclaw" "test-sb-googlechat-bridge"',
    );
  });

  it("reports an uncertain existing provider when refresh status inspection throws", async () => {
    bridgeProfileRegistered = true;
    registeredProviders.add("test-sb-googlechat-bridge");
    bridgeRefreshStatusError = `status inspection failed: ${SA_JSON}`;

    await expect(addSandboxChannel("test-sb", { channel: "googlechat" })).rejects.toMatchObject({
      code: 1,
    });

    const diagnostics = printedText();
    expect(diagnostics).toContain("test-sb-googlechat-bridge");
    expect(diagnostics).toContain("status inspection failed");
    expect(diagnostics).toContain("inspect the named provider");
    expect(diagnostics).toContain("correct the gateway failure");
    expect(diagnostics).not.toContain(SA_JSON);
    expect(diagnostics).not.toContain("fake-test-private-key-material");
    expect(diagnostics).not.toContain("fake");
    expect(deletedProviders.has("test-sb-googlechat-bridge")).toBe(false);
    expect(registry.getConfiguredMessagingChannelsFromEntry(registryEntry)).not.toContain(
      "googlechat",
    );
    expect(session.messagingPlan).toBeUndefined();
  });

  it("removes the bridge provider, policy, and durable plan through the channel action", async () => {
    await addSandboxChannel("test-sb", { channel: "googlechat" });
    expect(registry.getConfiguredMessagingChannelsFromEntry(registryEntry)).toContain("googlechat");
    expect(appliedPresets).toContain("googlechat");

    runOpenshellSpy.mockClear();
    resetGatewayObservations();
    await removeSandboxChannel("test-sb", { channel: "googlechat" });

    expect(detachedProviders.has("test-sb-googlechat-bridge")).toBe(true);
    expect(deletedProviders.has("test-sb-googlechat-bridge")).toBe(true);
    expect(registry.getConfiguredMessagingChannelsFromEntry(registryEntry)).not.toContain(
      "googlechat",
    );
    expect(appliedPresets).not.toContain("googlechat");
    expect(stopGooglechatWebhookTunnelSpy).toHaveBeenCalledWith("test-sb");
  });

  it("preserves retryable channel state when Google Chat endpoint teardown fails", async () => {
    await addSandboxChannel("test-sb", { channel: "googlechat" });
    expect(registry.getConfiguredMessagingChannelsFromEntry(registryEntry)).toContain("googlechat");
    expect(appliedPresets).toContain("googlechat");

    providerSpy.mockClear();
    runOpenshellSpy.mockClear();
    resetGatewayObservations();
    vi.mocked(policies.removePreset).mockClear();
    vi.mocked(registry.updateSandbox).mockClear();
    vi.mocked(policyChannelDependencies.rebuildSandbox).mockClear();
    stopGooglechatWebhookTunnelSpy.mockImplementation(() => {
      throw new Error("simulated tunnel cleanup failure");
    });

    await expect(removeSandboxChannel("test-sb", { channel: "googlechat" })).rejects.toMatchObject({
      code: 1,
    });

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(printedText()).toContain("Could not stop the Google Chat webhook tunnel");
    expect(printedText()).toContain("No channel configuration or credentials were changed");
    expect(process.env.GOOGLECHAT_SERVICE_ACCOUNT).toBe(SA_JSON);
    expect(registry.getConfiguredMessagingChannelsFromEntry(registryEntry)).toContain("googlechat");
    expect(appliedPresets).toContain("googlechat");
    expect(providerSpy).not.toHaveBeenCalled();
    expect(gatewayCallCount).toBe(0);
    expect(policies.removePreset).not.toHaveBeenCalled();
    expect(registry.updateSandbox).not.toHaveBeenCalled();
    expect(policyChannelDependencies.rebuildSandbox).not.toHaveBeenCalled();
  });

  it("preserves the bridge and webhook endpoint while stop/start restores the enabled plan", async () => {
    await addSandboxChannel("test-sb", { channel: "googlechat" });
    providerSpy.mockClear();
    runOpenshellSpy.mockClear();
    resetGatewayObservations();
    stopGooglechatWebhookTunnelSpy.mockClear();
    vi.mocked(policies.applyPreset).mockClear();

    await stopSandboxChannel("test-sb", { channel: "googlechat" });

    const stoppedPlan = registryEntry.messaging?.plan;
    expect(stoppedPlan?.workflow).toBe("stop-channel");
    expect(stoppedPlan?.disabledChannels).toEqual(["googlechat"]);
    expect(stoppedPlan?.channels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ channelId: "googlechat", active: false, disabled: true }),
      ]),
    );
    expect(providerSpy).not.toHaveBeenCalled();
    expect(gatewayCallCount).toBe(0);
    expect(stopGooglechatWebhookTunnelSpy).not.toHaveBeenCalled();

    await startSandboxChannel("test-sb", { channel: "googlechat" });

    const startedPlan = registryEntry.messaging?.plan;
    expect(startedPlan?.workflow).toBe("start-channel");
    expect(startedPlan?.disabledChannels).toEqual([]);
    expect(startedPlan?.channels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ channelId: "googlechat", active: true, disabled: false }),
      ]),
    );
    expect(startedPlan?.networkPolicy.presets).toContain("googlechat");
    expect(policies.applyPreset).not.toHaveBeenCalled();
    expect(appliedPresets).toContain("googlechat");
    expect(providerSpy).not.toHaveBeenCalled();
    expect(gatewayCallCount).toBe(0);
    expect(stopGooglechatWebhookTunnelSpy).not.toHaveBeenCalled();
  });
});
