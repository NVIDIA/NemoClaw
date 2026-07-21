// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Bridge-provider lifecycle on the DIRECT `channels add` path (#6120): a
// bridge-backed channel (googlechat) declares no manifest credentials, so the
// add path must (1) create + refresh-configure the gateway bridge provider
// itself, (2) fail loudly when the pasted secret is missing, and (3) tear the
// just-created provider back down when gateway registration fails midway.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import {
  addSandboxChannel,
  removeSandboxChannel,
  startSandboxChannel,
  stopSandboxChannel,
} from "../src/lib/actions/sandbox/policy-channel";
import { policyChannelDependencies } from "../src/lib/actions/sandbox/policy-channel-dependencies";
import * as processRecovery from "../src/lib/actions/sandbox/process-recovery";
import * as runtime from "../src/lib/adapters/openshell/runtime";
import * as store from "../src/lib/credentials/store";
import * as gatewayRuntime from "../src/lib/gateway-runtime-action";
import { MESSAGING_BRIDGE_PENDING_VALUE } from "../src/lib/onboard/messaging-bridge-provider";
import * as policies from "../src/lib/policy";
import * as onboardSession from "../src/lib/state/onboard-session";
import type { SandboxEntry } from "../src/lib/state/registry";
import * as registry from "../src/lib/state/registry";

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

// Why this mock exists: the real googlechat tunnel/audience gate needs a human
// operator (Google Cloud Console steps), so on a non-interactive test run it
// throws and the whole channel is skipped — the add path under test would
// never execute.
//
// What it does: keep the module intact except the gate's registration, whose
// handler is replaced with one that succeeds immediately — as if the operator
// had already finished enrollment. Everything else in the add path runs real.
type GateModule =
  typeof import("../src/lib/messaging/channels/googlechat/hooks/tunnel-audience-gate");

vi.mock(
  "../src/lib/messaging/channels/googlechat/hooks/tunnel-audience-gate",
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

function printedText(): string {
  return [...logSpy.mock.calls, ...errorSpy.mock.calls]
    .map((call) => call.map(String).join(" "))
    .join("\n");
}

function openshellCalls(): string[][] {
  return runOpenshellSpy.mock.calls.map((call) => call[0] as string[]);
}

beforeEach(() => {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-add-bridge-"));
  process.env.HOME = testHome;
  process.env.NEMOCLAW_NON_INTERACTIVE = "1";
  Object.assign(process.env, GOOGLECHAT_ENV);

  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitError(code);
  }) as never);

  registryEntry = { name: "test-sb", agent: "openclaw", policies: [] } as SandboxEntry;
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
    policyPresets: [],
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
  vi.spyOn(policyChannelDependencies, "rebuildSandbox").mockImplementation(async () => undefined);
  stopGooglechatWebhookTunnelSpy = vi
    .spyOn(policyChannelDependencies, "stopGooglechatWebhookTunnel")
    .mockImplementation(() => undefined);

  runOpenshellSpy = vi.spyOn(runtime, "runOpenshell").mockImplementation(() => ({
    pid: 0,
    output: [null, "", ""],
    stdout: "",
    stderr: "",
    status: 0,
    signal: null,
  }));

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
      { bestEffort: true },
    );
    const refreshCall = runOpenshellSpy.mock.calls.find(
      (call) =>
        (call[0] as string[])[0] === "provider" &&
        (call[0] as string[])[1] === "refresh" &&
        (call[0] as string[])[2] === "configure",
    );
    expect(refreshCall).toBeDefined();
    const refreshArgs = refreshCall?.[0] as string[];
    expect(refreshArgs).toContain("--secret-material-env");
    expect(refreshArgs).toContain("private_key=MESSAGING_BRIDGE_SECRET_0");
    expect(refreshArgs.join(" ")).not.toContain("fake-test-private-key-material");
    expect(refreshCall?.[1]).toMatchObject({
      env: { MESSAGING_BRIDGE_SECRET_0: "fake-test-private-key-material" },
    });
    expect(JSON.stringify({ registryEntry, session })).not.toContain(
      "fake-test-private-key-material",
    );
    expect(printedText()).toContain("Registered googlechat bridge");
  });

  it("fails loudly at add time when the bridge secret is not resolvable", async () => {
    delete process.env.GOOGLECHAT_SERVICE_ACCOUNT;

    await expect(addSandboxChannel("test-sb", { channel: "googlechat" })).rejects.toMatchObject({
      code: 1,
    });

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(providerSpy).not.toHaveBeenCalled();
    expect(printedText()).toContain("GOOGLECHAT_SERVICE_ACCOUNT");
  });

  it("tears the just-created bridge provider back down when gateway registration fails", async () => {
    providerSpy.mockImplementation(() => {
      throw new Error("simulated gateway failure");
    });

    await expect(addSandboxChannel("test-sb", { channel: "googlechat" })).rejects.toMatchObject({
      code: 1,
    });

    expect(printedText()).toContain("Failed to register 'googlechat' providers");
    expect(openshellCalls()).toEqual(
      expect.arrayContaining([
        ["sandbox", "provider", "detach", "test-sb", "test-sb-googlechat-bridge"],
        ["provider", "delete", "test-sb-googlechat-bridge"],
      ]),
    );
  });

  it("removes the bridge provider, policy, and durable plan through the channel action", async () => {
    await addSandboxChannel("test-sb", { channel: "googlechat" });
    expect(registry.getConfiguredMessagingChannelsFromEntry(registryEntry)).toContain("googlechat");
    expect(appliedPresets).toContain("googlechat");

    runOpenshellSpy.mockClear();
    await removeSandboxChannel("test-sb", { channel: "googlechat" });

    expect(openshellCalls()).toEqual(
      expect.arrayContaining([
        ["sandbox", "provider", "detach", "test-sb", "test-sb-googlechat-bridge"],
        ["provider", "delete", "test-sb-googlechat-bridge"],
      ]),
    );
    expect(registry.getConfiguredMessagingChannelsFromEntry(registryEntry)).not.toContain(
      "googlechat",
    );
    expect(appliedPresets).not.toContain("googlechat");
    expect(session.policyPresets).not.toContain("googlechat");
    expect(stopGooglechatWebhookTunnelSpy).toHaveBeenCalledWith("test-sb");
  });

  it("preserves the bridge and webhook endpoint while stop/start restores the enabled plan", async () => {
    await addSandboxChannel("test-sb", { channel: "googlechat" });
    providerSpy.mockClear();
    runOpenshellSpy.mockClear();
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
    expect(openshellCalls()).toEqual([]);
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
    expect(policies.applyPreset).toHaveBeenCalledWith("test-sb", "googlechat");
    expect(appliedPresets).toContain("googlechat");
    expect(session.policyPresets).toContain("googlechat");
    expect(providerSpy).not.toHaveBeenCalled();
    expect(openshellCalls()).toEqual([]);
    expect(stopGooglechatWebhookTunnelSpy).not.toHaveBeenCalled();
  });
});
