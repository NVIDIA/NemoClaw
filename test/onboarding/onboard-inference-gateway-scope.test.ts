// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OllamaModelHolder } from "../../src/lib/inference/ollama/model-ownership.js";
import type { SetupInference, SetupInferenceDeps } from "../../src/lib/onboard/setup-inference.js";
import {
  createDirectCommandRouter,
  createDirectSetupInferenceHarnessFactory,
  withProcessEnv,
  runProductionSetupInferenceCredentialBoundary,
} from "../support/setup-inference-test-harness.js";

const testHome = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-scope-"));
  vi.stubEnv("HOME", directory);
  return directory;
});
const { default: onboard } = (await import("../../src/lib/onboard")) as unknown as {
  default: { createSetupInference: (overrides?: Partial<SetupInferenceDeps>) => SetupInference };
};
afterAll(() => fs.rmSync(testHome, { recursive: true, force: true }));
beforeEach(() => vi.stubEnv("HOME", testHome));

const createHarness = createDirectSetupInferenceHarnessFactory(onboard.createSetupInference);
const GATEWAY = "nemoclaw-9090";

function expectCommandsTargetOnly(commands: Array<{ command: string }>): void {
  expect(commands.some(({ command }) => command.startsWith("gateway select"))).toBe(false);
  const gatewayStateCommands = commands.filter(
    ({ command }) => /^(provider|inference) /.test(command) || /^sandbox provider /.test(command),
  );
  for (const { command } of gatewayStateCommands) {
    expect(command.match(/(?:^| )-g nemoclaw-9090(?: |$)/g)).toHaveLength(1);
  }
}

describe("onboarding inference gateway scope", () => {
  it.each([
    { hostname: "localhost", deferred: false },
    { hostname: "host.openshell.internal", deferred: false },
    { hostname: "localhost", deferred: true },
  ])(
    "records native DCode at $hostname with deferred shared-route mode=$deferred (#13197)",
    async ({ hostname, deferred }) => {
      const resolveEndpointHost = vi.fn(async () => [{ address: "127.0.0.1", family: 4 }]);
      const harness = createHarness({
        overrides: {
          resolveEndpointHost,
          ...(deferred
            ? {
                getSandbox: () => ({
                  name: "alpha",
                  agent: "langchain-deepagents-code",
                  provider: "openai-api",
                  model: "old-model",
                  gatewayName: GATEWAY,
                  createdAt: "2026-10-01T00:00:00Z",
                }),
              }
            : {}),
        },
      });
      await withProcessEnv({ COMPATIBLE_API_KEY: "sk-local-TEST-NOT-A-REAL-VALUE" }, async () => {
        const result = await harness.setupInference(
          "alpha",
          "local-model",
          "compatible-endpoint",
          `http://${hostname}:8000/v1`,
          "COMPATIBLE_API_KEY",
          null,
          [],
          {
            agentName: "langchain-deepagents-code",
            gatewayName: GATEWAY,
            deferPublishedRouteReservation: deferred,
          },
        );
        expect(result).toEqual({ ok: true });
        expect(harness.updateSandbox).toHaveBeenCalledWith(
          "alpha",
          expect.objectContaining({
            nativeLocalProviderAttachment: expect.objectContaining({
              provider: "compatible-endpoint",
              sandboxName: "alpha",
              gatewayName: GATEWAY,
              endpointUrl: "http://host.openshell.internal:8000/v1",
            }),
          }),
        );
      });
      expect(resolveEndpointHost).not.toHaveBeenCalled();
      expect(harness.native.adapter.createProvider).toHaveBeenCalledOnce();
      expect(harness.commands.some(({ command }) => command.startsWith("inference set"))).toBe(
        false,
      );
    },
  );

  it("creates native hosted access only on the selected non-default gateway (#12589)", () => {
    const { commands, credentialEvidence } = runProductionSetupInferenceCredentialBoundary({
      credentialEnv: "OPENAI_API_KEY",
      credentialValue: "sk-TEST-NOT-A-REAL-VALUE",
      endpointUrl: "https://api.openai.com/v1",
      model: "gpt-test",
      provider: "openai-api",
      gatewayName: GATEWAY,
    });
    expect(credentialEvidence.providerCommand.argv.join(" ")).toContain(
      "provider create -g " + GATEWAY,
    );
    expect(credentialEvidence.argvContainingSecret).toEqual([]);
    expect(commands.some(({ argv }) => argv[0] === "inference" && argv[1] === "set")).toBe(false);
    expectCommandsTargetOnly(commands.map(({ argv }) => ({ command: argv.join(" ") })));
  });

  it("registers loopback compatible endpoints through the gateway alias but keeps host smoke local (#5744)", async () => {
    await withProcessEnv(
      { COMPATIBLE_API_KEY: "sk-compatible-TEST-NOT-A-REAL-VALUE" },
      async () => {
        const harness = createHarness({
          runOpenshell: (args) =>
            args.slice(0, 2).join(" ") === "provider get" ? { status: 1 } : undefined,
        });
        const endpointUrl = "http://localhost:8000/v1?tenant=local#models";
        const model = "deepseek-ai/DeepSeek-V4-Flash";

        await expect(
          harness.setupInference(
            "dcode-vllm-local",
            model,
            "compatible-endpoint",
            endpointUrl,
            "COMPATIBLE_API_KEY",
            null,
            [],
            { gatewayName: GATEWAY },
          ),
        ).resolves.toEqual({ ok: true });

        expect(harness.commands.map(({ command }) => command)).toEqual([
          `provider get -g ${GATEWAY} compatible-endpoint`,
          `provider create -g ${GATEWAY} --name compatible-endpoint --type openai --credential COMPATIBLE_API_KEY --config OPENAI_BASE_URL=http://host.openshell.internal:8000/v1?tenant=local#models`,
          `inference set -g ${GATEWAY} --no-verify --provider compatible-endpoint --model ${model} --timeout 180`,
        ]);
        expect(harness.verifyOnboardInferenceSmoke).toHaveBeenCalledWith({
          provider: "compatible-endpoint",
          model,
          endpointUrl,
          credentialEnv: "COMPATIBLE_API_KEY",
          pinnedAddresses: [],
          trustedPrivateCapability: undefined,
          capabilityCache: undefined,
        });
        expect(harness.updateSandbox).toHaveBeenCalledWith("dcode-vllm-local", {
          provider: "compatible-endpoint",
          model,
          endpointUrl,
          endpointSource: "onboard",
          credentialEnv: "COMPATIBLE_API_KEY",
          preferredInferenceApi: null,
          gatewayName: GATEWAY,
          reservationSessionId: undefined,
          hostLocalInferenceReceipt: null,
        });
        expectCommandsTargetOnly(harness.commands);
      },
    );
  });

  it("updates a recovered loopback route without re-exporting its gateway credential (#5744)", async () => {
    await withProcessEnv({ COMPATIBLE_API_KEY: undefined }, async () => {
      const harness = createHarness({
        runOpenshell: (args) =>
          args.slice(0, 2).join(" ") === "provider get"
            ? {
                status: 0,
                stdout:
                  "Name: compatible-endpoint\nType: openai\nCredential keys: COMPATIBLE_API_KEY\nConfig keys: OPENAI_BASE_URL\n",
              }
            : undefined,
      });
      const model = "deepseek-ai/DeepSeek-V4-Flash";

      await expect(
        harness.setupInference(
          "dcode-vllm-local",
          model,
          "compatible-endpoint",
          "http://localhost:8000/v1",
          "COMPATIBLE_API_KEY",
          null,
          [],
          {
            gatewayName: GATEWAY,
            reuseGatewayCredentialWithoutLocalKey: true,
            skipHostInferenceSmoke: true,
          },
        ),
      ).resolves.toEqual({ ok: true });

      expect(harness.commands.map(({ command }) => command)).toEqual([
        `provider get -g ${GATEWAY} compatible-endpoint`,
        `provider get -g ${GATEWAY} compatible-endpoint`,
        `provider update -g ${GATEWAY} compatible-endpoint --config OPENAI_BASE_URL=http://host.openshell.internal:8000/v1`,
        `inference set -g ${GATEWAY} --no-verify --provider compatible-endpoint --model ${model} --timeout 180`,
      ]);
      const providerUpdate = harness.commands.find(({ command }) =>
        command.startsWith("provider update "),
      );
      expect(providerUpdate?.env).toBeUndefined();
      expect(harness.commands.every(({ env }) => env?.COMPATIBLE_API_KEY === undefined)).toBe(true);
      expect(harness.verifyOnboardInferenceSmoke).not.toHaveBeenCalled();
      expect(harness.verifyInferenceRoute).toHaveBeenCalledWith(
        GATEWAY,
        "compatible-endpoint",
        model,
      );
      expectCommandsTargetOnly(harness.commands);
    });
  });

  it("keeps compatible-endpoint replacement and detach recovery on the target gateway", async () => {
    await withProcessEnv(
      { COMPATIBLE_ANTHROPIC_API_KEY: "sk-ant-TEST-NOT-A-REAL-VALUE" },
      async () => {
        const commandRouter = createDirectCommandRouter([
          {
            name: "provider-get",
            matches: (command) => command.startsWith(`provider get -g ${GATEWAY}`),
            results: [
              {
                status: 0,
                stdout: [
                  "Name: compatible-anthropic-endpoint",
                  "Type: anthropic",
                  "Credential keys: COMPATIBLE_ANTHROPIC_API_KEY",
                  "Config keys: ANTHROPIC_BASE_URL",
                ].join("\n"),
              },
              { status: 1 },
            ],
          },
          {
            name: "provider-delete",
            matches: (command) => command.startsWith(`provider delete -g ${GATEWAY}`),
            results: [
              {
                status: 1,
                stderr:
                  "provider 'compatible-anthropic-endpoint' is attached to sandbox(es): test-box",
              },
              { status: 0 },
            ],
          },
        ]);
        const harness = createHarness({
          legacyCustomRoute: true,
          runOpenshell: commandRouter.runOpenshell,
          overrides: {
            probeOpenAiLikeEndpoint: vi.fn(() => ({ ok: true })),
          },
        });

        const result = await harness.setupInference(
          "test-box",
          "claude-test",
          "compatible-anthropic-endpoint",
          "https://example.test",
          "COMPATIBLE_ANTHROPIC_API_KEY",
          null,
          [],
          { gatewayName: GATEWAY, preferredInferenceApi: "openai-completions" },
        );
        expect(
          result,
          JSON.stringify({ commands: harness.commands, errors: harness.errors }, null, 2),
        ).toEqual({ ok: true });

        expect(commandRouter.callCount("provider-delete")).toBe(2);
        expect(harness.commands.map(({ command }) => command)).toContain(
          `sandbox provider detach -g ${GATEWAY} test-box compatible-anthropic-endpoint`,
        );
        expectCommandsTargetOnly(harness.commands);
      },
    );
  });

  it("serializes cross-gateway compatible Ollama peer publication before cleanup (#12677)", async () => {
    await withProcessEnv({ COMPATIBLE_API_KEY: "test-compatible-api-key" }, async () => {
      const events: string[] = [];
      const registry = new Map<string, OllamaModelHolder>([
        [
          "alpha",
          {
            name: "alpha",
            provider: "ollama-local",
            model: "qwen2.5:1.5b",
            endpointUrl: "http://127.0.0.1:11434/v1",
            gatewayName: "gateway-alpha",
          },
        ],
        [
          "beta",
          {
            name: "beta",
            provider: "compatible-endpoint",
            model: "previous-model",
            endpointUrl: "https://previous.example/v1",
            gatewayName: "gateway-beta",
          },
        ],
      ]);
      let signalBetaRouteStarted!: () => void;
      let releaseBetaRoute!: () => void;
      let signalAlphaQueued!: () => void;
      const betaRouteStarted = new Promise<void>((resolve) => {
        signalBetaRouteStarted = resolve;
      });
      const allowBetaRouteToFinish = new Promise<void>((resolve) => {
        releaseBetaRoute = resolve;
      });
      const alphaQueuedForTransaction = new Promise<void>((resolve) => {
        signalAlphaQueued = resolve;
      });
      let transactionTail = Promise.resolve();
      let transactionCalls = 0;
      const withOwnershipTransaction: NonNullable<
        SetupInferenceDeps["withOllamaModelOwnershipTransaction"]
      > = async <T>(operation: () => Promise<T> | T): Promise<T> => {
        transactionCalls += 1;
        [() => undefined, signalAlphaQueued][transactionCalls - 1]?.();
        const previous = transactionTail;
        let release!: () => void;
        transactionTail = new Promise<void>((resolve) => {
          release = resolve;
        });
        await previous;
        try {
          return await operation();
        } finally {
          release();
        }
      };
      const waitBeforeRouteMutation: Record<string, () => Promise<void>> = {
        "gateway-beta": async () => {
          signalBetaRouteStarted();
          await allowBetaRouteToFinish;
        },
      };
      const inferenceRouteMutator: SetupInferenceDeps["inferenceRouteMutator"] = {
        setInferenceRoute: async (request) => {
          const gateway = request.target.gatewayName;
          events.push(`route-start:${gateway}`);
          await (waitBeforeRouteMutation[gateway] ?? (() => Promise.resolve()))();
          events.push(`route-finished:${gateway}`);
          return { ok: true };
        },
      };
      const updateSandbox: SetupInferenceDeps["updateSandbox"] = (name, route) => {
        const previous = registry.get(name);
        registry.set(name, { ...previous, ...route, name } as OllamaModelHolder);
        events.push(`registry-published:${name}`);
        return true;
      };
      const unloadOllamaModels = vi.fn(() => ({
        ok: true as const,
        outcome: "released" as const,
        endpoint: "http://127.0.0.1:11434",
        selectedModels: ["qwen2.5:1.5b"],
        discoveries: [],
        requests: [],
      }));
      const overrides: Partial<SetupInferenceDeps> = {
        inferenceRouteMutator,
        updateSandbox,
        getSandbox: (name) => registry.get(name) ?? null,
        listOllamaModelOwnershipPeers: () => [...registry.values()],
        discoverActiveOllamaSandboxNames: (owners) => ({
          ok: true,
          activeSandboxNames: new Set(owners.map((owner) => owner.name)),
          gatewayChecks: [],
        }),
        localInference: {
          loadPersistedOllamaHost: () => "127.0.0.1",
          loadPendingOllamaModelCleanup: () => [],
          persistPendingOllamaModelCleanup: vi.fn(),
          clearPendingOllamaModelCleanup: vi.fn(),
          clearPersistedOllamaHostIfUnused: vi.fn(),
        } as unknown as SetupInferenceDeps["localInference"],
        unloadOllamaModels,
        withOllamaModelOwnershipLock: (operation) => operation(),
        withOllamaModelOwnershipTransaction: withOwnershipTransaction,
      };
      const makeHarness = () =>
        createHarness({
          runOpenshell: (args) =>
            args.slice(0, 2).join(" ") === "provider get" ? { status: 1 } : undefined,
          overrides,
        });
      const alpha = makeHarness();
      const beta = makeHarness();
      const betaSwitch = beta.setupInference(
        "beta",
        "qwen2.5:1.5b",
        "compatible-endpoint",
        "http://127.0.0.1:11434/v1",
        "COMPATIBLE_API_KEY",
        null,
        [],
        {
          gatewayName: "gateway-beta",
          endpointPinnedAddresses: ["127.0.0.1"],
          skipHostInferenceSmoke: true,
        },
      );

      await betaRouteStarted;
      const alphaSwitch = alpha.setupInference(
        "alpha",
        "other-model",
        "compatible-endpoint",
        "https://api.example.test/v1",
        "COMPATIBLE_API_KEY",
        null,
        [],
        { gatewayName: "gateway-alpha", skipHostInferenceSmoke: true },
      );
      await alphaQueuedForTransaction;
      expect(events).not.toContain("route-start:gateway-alpha");

      releaseBetaRoute();
      await expect(Promise.all([alphaSwitch, betaSwitch])).resolves.toEqual([
        { ok: true },
        { ok: true },
      ]);

      expect(events.indexOf("registry-published:beta")).toBeLessThan(
        events.indexOf("route-start:gateway-alpha"),
      );
      expect(unloadOllamaModels).not.toHaveBeenCalled();
    });
  }, 20_000);
});
