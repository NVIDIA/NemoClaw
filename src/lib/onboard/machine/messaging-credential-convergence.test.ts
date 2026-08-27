// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

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
  initialObservation: "absent" | "canonical" | typeof CURRENT,
  initialConfig = CANONICAL,
  behavior: {
    readonly providerId?: string;
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
    restartManagedGateway: scope.restartManagedGateway,
    ...overrides,
  };
}

describe("managed messaging credential convergence", () => {
  it("keeps an endpointless credential out of process env and retains its canonical config alias", async () => {
    const durablePlan = plan();
    const scope = harness("absent");

    expect(
      await convergeManagedMessagingCredentials(
        {
          sandboxName: "alpha",
          gatewayName: "nemoclaw",
          openshellDriver: "podman",
          plan: durablePlan,
          expectedProviderIds: new Map([[PROVIDER, PROVIDER_ID]]),
        },
        convergenceDeps(scope),
      ),
    ).toEqual({
      kind: "converged",
      updatedProviders: [],
      projectedTargets: [],
      restartRequired: false,
    });
    expect(JSON.parse(scope.getConfig()).channels.telegram.accounts.default.botToken).toBe(
      CANONICAL,
    );
    expect(durablePlan.credentialBindings[0]?.placeholder).toBe(CANONICAL);
    expect(scope.calls.some(({ args }) => args[1] === "provider")).toBe(false);
    expect(scope.restartManagedGateway).not.toHaveBeenCalled();
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

  it("accepts OpenShell's canonical current-credential alias without republishing", async () => {
    const scope = harness("canonical", CANONICAL);

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
    ).resolves.toEqual({
      kind: "converged",
      updatedProviders: [],
      projectedTargets: [],
      restartRequired: false,
    });
    expect(scope.calls.some(({ args }) => args[0] === "provider" && args[1] === "update")).toBe(
      false,
    );
    expect(scope.calls.some(({ args }) => args[1] === "provider")).toBe(false);
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

  it("rejects a same-shaped replacement provider before refreshing its credential", async () => {
    const scope = harness("absent", CANONICAL, { providerId: "replacement-456" });

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
    ).rejects.toThrow("immutable registration authority");
    expect(scope.calls.some(({ args }) => args[0] === "provider" && args[1] === "update")).toBe(
      false,
    );
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
