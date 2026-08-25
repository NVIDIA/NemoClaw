// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import type { SandboxMessagingPlan } from "../../messaging";
import { MessagingSetupApplier } from "../../messaging";
import { convergeManagedMessagingCredentials } from "./messaging-credential-convergence";

const CANONICAL = "openshell:resolve:env:TELEGRAM_BOT_TOKEN";
const CURRENT = "openshell:resolve:env:v12_TELEGRAM_BOT_TOKEN";
const PROVIDER = "alpha-telegram-bridge";
const PROVIDER_ID = "provider-owned-123";

function plan(): SandboxMessagingPlan {
  return {
    schemaVersion: 1,
    sandboxName: "alpha",
    agent: "openclaw",
    workflow: "onboard",
    channels: [
      {
        channelId: "telegram",
        displayName: "Telegram",
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
    credentialBindings: [
      {
        channelId: "telegram",
        credentialId: "telegramBotToken",
        sourceInput: "botToken",
        providerName: PROVIDER,
        providerEnvKey: "TELEGRAM_BOT_TOKEN",
        placeholder: CANONICAL,
        credentialAvailable: true,
      },
    ],
    networkPolicy: { presets: [], entries: [] },
    agentRender: [
      {
        channelId: "telegram",
        kind: "json-fragment",
        agent: "openclaw",
        target: "openclaw.json",
        path: "channels.telegram.accounts.default.botToken",
        value: CANONICAL,
        templateRefs: [],
      },
    ],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
  };
}

function exactProviderOutput(id: string, resourceVersion: number): string {
  return [
    `Id: ${id}`,
    `Name: ${PROVIDER}`,
    "Type: nemoclaw-mcp-v1",
    `Resource version: ${resourceVersion}`,
    "Credential keys: TELEGRAM_BOT_TOKEN",
    "Config keys: <none>",
    "",
  ].join("\n");
}

function harness(
  initialObservation: "absent" | typeof CURRENT,
  initialConfig = CANONICAL,
  behavior: {
    readonly advanceVersion?: boolean;
    readonly providerId?: string;
    readonly publishObservation?: boolean;
    readonly replacementIdOnRestart?: string;
  } = {},
) {
  let observation: string = initialObservation;
  let providerId = behavior.providerId ?? PROVIDER_ID;
  let resourceVersion = 7;
  let config = JSON.stringify({
    channels: { telegram: { accounts: { default: { botToken: initialConfig } } } },
  });
  const calls: Array<{ args: string[]; options: Record<string, unknown> }> = [];
  const runOpenshell = vi.fn((args: string[], runOptions: Record<string, unknown> = {}) => {
    calls.push({ args: [...args], options: runOptions });
    switch (`${args[0]}:${args[1]}`) {
      case "provider:get":
        return {
          status: 0,
          stdout: exactProviderOutput(providerId, resourceVersion),
          stderr: "",
        };
      case "provider:update":
        resourceVersion += behavior.advanceVersion === false ? 0 : 1;
        observation = behavior.publishObservation === false ? observation : CURRENT;
        return { status: 0, stdout: "", stderr: "" };
      default:
        switch (true) {
          case args[0] === "sandbox" && args.includes("cat"):
            return { status: 0, stdout: config, stderr: "" };
          case args[0] === "sandbox" && runOptions.input !== undefined:
            config = String(runOptions.input);
            return { status: 0, stdout: "", stderr: "" };
          case args[0] === "sandbox" && args.includes("-lc"):
            return { status: 0, stdout: `${observation}\n`, stderr: "" };
          default:
            return { status: 1, stdout: "", stderr: "unexpected" };
        }
    }
  });
  const restartManagedGateway = vi.fn(() => {
    providerId = behavior.replacementIdOnRestart ?? providerId;
    return { ok: true as const };
  });
  return { calls, getConfig: () => config, restartManagedGateway, runOpenshell };
}

function convergenceDeps(
  scope: ReturnType<typeof harness>,
  overrides: Partial<Parameters<typeof convergeManagedMessagingCredentials>[1]> = {},
) {
  return {
    runOpenshell: scope.runOpenshell as never,
    getCredential: () => null,
    normalizeCredentialValue: (value: unknown) => (typeof value === "string" ? value.trim() : ""),
    restartManagedGateway: scope.restartManagedGateway,
    ...overrides,
  };
}

describe("managed messaging credential convergence", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("republishes an absent credential and projects its exact revision", async () => {
    const durablePlan = plan();
    const scope = harness("absent");

    expect(
      await convergeManagedMessagingCredentials(
        {
          sandboxName: "alpha",
          gatewayName: "nemoclaw",
          openshellDriver: "podman",
          plan: durablePlan,
          environment: { TELEGRAM_BOT_TOKEN: "raw-token" },
          expectedProviderIds: new Map([[PROVIDER, PROVIDER_ID]]),
        },
        convergenceDeps(scope),
      ),
    ).toEqual({
      kind: "converged",
      updatedProviders: [PROVIDER],
      projectedTargets: ["/sandbox/.openclaw/openclaw.json"],
      restartRequired: true,
    });

    const update = scope.calls.find(({ args }) => args[0] === "provider" && args[1] === "update");
    expect(update?.args).toEqual([
      "provider",
      "update",
      "-g",
      "nemoclaw",
      PROVIDER,
      "--credential",
      "TELEGRAM_BOT_TOKEN",
    ]);
    expect(update?.options.env).toEqual({ TELEGRAM_BOT_TOKEN: "raw-token" });
    expect(update?.args.join(" ")).not.toContain("raw-token");
    expect(JSON.parse(scope.getConfig()).channels.telegram.accounts.default.botToken).toBe(CURRENT);
    expect(durablePlan.credentialBindings[0]?.placeholder).toBe(CANONICAL);
    expect(scope.restartManagedGateway).toHaveBeenCalledExactlyOnceWith("alpha");
  });

  it("does not republish an already-current unchanged projection", async () => {
    const scope = harness(CURRENT, CURRENT);

    const run = () =>
      convergeManagedMessagingCredentials(
        {
          sandboxName: "alpha",
          gatewayName: "nemoclaw",
          openshellDriver: "docker",
          plan: plan(),
          environment: {},
          expectedProviderIds: new Map([[PROVIDER, PROVIDER_ID]]),
        },
        convergenceDeps(scope),
      );

    expect(await run()).toEqual({
      kind: "converged",
      updatedProviders: [],
      projectedTargets: ["/sandbox/.openclaw/openclaw.json"],
      restartRequired: true,
    });
    expect(scope.restartManagedGateway).toHaveBeenCalledOnce();
    scope.calls.splice(0);
    scope.restartManagedGateway.mockClear();

    expect(await run()).toEqual({
      kind: "converged",
      updatedProviders: [],
      projectedTargets: [],
      restartRequired: false,
    });
    expect(scope.calls.some(({ args }) => args[0] === "provider" && args[1] === "update")).toBe(
      false,
    );
    expect(scope.restartManagedGateway).not.toHaveBeenCalled();
  });

  it("fails closed when an absent revision cannot be republished from trusted host custody", async () => {
    const scope = harness("absent");

    await expect(
      convergeManagedMessagingCredentials(
        {
          sandboxName: "alpha",
          gatewayName: "nemoclaw",
          openshellDriver: "podman",
          plan: plan(),
          environment: {},
          expectedProviderIds: new Map([[PROVIDER, PROVIDER_ID]]),
        },
        convergenceDeps(scope),
      ),
    ).rejects.toThrow("is unavailable for final provider convergence");
    expect(scope.calls.some(({ args }) => args[0] === "provider" && args[1] === "update")).toBe(
      false,
    );
    expect(scope.restartManagedGateway).not.toHaveBeenCalled();
  });

  it("rejects duplicate provider or env ownership before observing sandbox state", async () => {
    const scope = harness("absent");
    const base = plan();
    const duplicate: SandboxMessagingPlan = {
      ...base,
      credentialBindings: [
        ...base.credentialBindings,
        {
          ...base.credentialBindings[0]!,
          credentialId: "telegramBotTokenDuplicate",
          providerName: "alpha-telegram-duplicate",
        },
      ],
    };

    await expect(
      convergeManagedMessagingCredentials(
        {
          sandboxName: "alpha",
          gatewayName: "nemoclaw",
          openshellDriver: "podman",
          plan: duplicate,
          expectedProviderIds: new Map([[PROVIDER, PROVIDER_ID]]),
        },
        convergenceDeps(scope),
      ),
    ).rejects.toThrow("bindings are ambiguous");
    expect(scope.runOpenshell).not.toHaveBeenCalled();
  });

  it("leaves the portable profile path untouched", async () => {
    const scope = harness("absent");

    expect(
      await convergeManagedMessagingCredentials(
        {
          sandboxName: "alpha",
          gatewayName: "nemoclaw",
          openshellDriver: "portable",
          plan: plan(),
          expectedProviderIds: new Map(),
        },
        convergenceDeps(scope),
      ),
    ).toEqual({ kind: "skipped" });
    expect(scope.runOpenshell).not.toHaveBeenCalled();
    expect(scope.restartManagedGateway).not.toHaveBeenCalled();
  });

  it("rejects a same-shaped replacement provider before exposing the raw credential", async () => {
    const scope = harness("absent", CANONICAL, { providerId: "replacement-456" });

    await expect(
      convergeManagedMessagingCredentials(
        {
          sandboxName: "alpha",
          gatewayName: "nemoclaw",
          openshellDriver: "podman",
          plan: plan(),
          environment: { TELEGRAM_BOT_TOKEN: "raw-token" },
          expectedProviderIds: new Map([[PROVIDER, PROVIDER_ID]]),
        },
        convergenceDeps(scope),
      ),
    ).rejects.toThrow("immutable registration authority");
    expect(scope.calls.some(({ args }) => args[0] === "provider" && args[1] === "update")).toBe(
      false,
    );
  });

  it("requires one exact provider resource-version increment", async () => {
    const scope = harness("absent", CANONICAL, { advanceVersion: false });

    await expect(
      convergeManagedMessagingCredentials(
        {
          sandboxName: "alpha",
          gatewayName: "nemoclaw",
          openshellDriver: "podman",
          plan: plan(),
          environment: { TELEGRAM_BOT_TOKEN: "raw-token" },
          expectedProviderIds: new Map([[PROVIDER, PROVIDER_ID]]),
        },
        convergenceDeps(scope),
      ),
    ).rejects.toThrow("expected messaging provider generation");
    expect(scope.restartManagedGateway).not.toHaveBeenCalled();
  });

  it("rejects provider replacement during the managed gateway restart", async () => {
    const scope = harness(CURRENT, CANONICAL, {
      replacementIdOnRestart: "replacement-after-restart",
    });

    await expect(
      convergeManagedMessagingCredentials(
        {
          sandboxName: "alpha",
          gatewayName: "nemoclaw",
          openshellDriver: "podman",
          plan: plan(),
          expectedProviderIds: new Map([[PROVIDER, PROVIDER_ID]]),
        },
        convergenceDeps(scope),
      ),
    ).rejects.toThrow("changed during final credential activation");
  });

  it("bounds the provider synchronization wait to five minutes", async () => {
    const scope = harness("absent", CANONICAL, { publishObservation: false });
    let now = 0;
    const sleep = vi.fn(async (milliseconds: number) => {
      now += milliseconds;
    });

    await expect(
      convergeManagedMessagingCredentials(
        {
          sandboxName: "alpha",
          gatewayName: "nemoclaw",
          openshellDriver: "podman",
          plan: plan(),
          environment: { TELEGRAM_BOT_TOKEN: "raw-token" },
          expectedProviderIds: new Map([[PROVIDER, PROVIDER_ID]]),
        },
        convergenceDeps(scope, { now: () => now, sleep }),
      ),
    ).rejects.toThrow("did not synchronize");
    expect(sleep).toHaveBeenCalledTimes(300);
    expect(now).toBe(300_000);
  });

  it("projects prefix-overlapping env names only at exact placeholder boundaries", () => {
    const short = "openshell:resolve:env:TOKEN";
    const long = "openshell:resolve:env:TOKEN_A";
    const base = plan();
    const overlapPlan: SandboxMessagingPlan = {
      ...base,
      credentialBindings: [
        { ...base.credentialBindings[0]!, providerEnvKey: "TOKEN", placeholder: short },
        {
          ...base.credentialBindings[0]!,
          credentialId: "longToken",
          providerEnvKey: "TOKEN_A",
          providerName: "alpha-long-token",
          placeholder: long,
        },
      ],
      agentRender: [
        {
          channelId: "telegram",
          kind: "json-fragment",
          agent: "openclaw",
          target: "openclaw.json",
          path: "credentials",
          value: { short, long },
          templateRefs: [],
        },
      ],
    };
    let config = JSON.stringify({ credentials: { short, long } });
    const runOpenshell = vi.fn((args: readonly string[], options: { input?: string } = {}) => {
      switch (true) {
        case args.includes("cat"):
          return { status: 0, stdout: config };
        case options.input !== undefined:
          config = options.input;
          return { status: 0 };
        default:
          return { status: 1 };
      }
    });

    MessagingSetupApplier.applyCredentialProjectionAtOpenShell(
      overlapPlan,
      new Map([
        ["TOKEN", "openshell:resolve:env:v1_TOKEN"],
        ["TOKEN_A", "openshell:resolve:env:v2_TOKEN_A"],
      ]),
      { runOpenshell },
    );

    expect(JSON.parse(config).credentials).toEqual({
      short: "openshell:resolve:env:v1_TOKEN",
      long: "openshell:resolve:env:v2_TOKEN_A",
    });
  });
});
