// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { prepareHostLocalInferenceStartup } from "../runtime-provider/host-local-inference-routing";
import { writeOkOpenshell } from "../../../../test/helpers/onboard-openshell-fixture";
import {
  createHermesPortableInferenceFixture,
  FRESH_PORTABLE_INFERENCE_INPUT as freshPortableInput,
  createHermesPortableTestInput,
  createHermesPortableTransactionFixture,
  HERMES_PORTABLE_TEST_POLICY as POLICY,
} from "../../../../test/helpers/hermes-portable-onboarding-fixture";
import { runHermesPortableOnboardingTransaction } from "./hermes-portable-onboarding";

vi.hoisted(() => {
  vi.stubEnv("NEMOCLAW_GATEWAY_PORT", "18080");
});

let stateDir: string;
let policyPath: string;

function input() {
  return createHermesPortableTestInput(stateDir, policyPath);
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-gateway-port-"));
  policyPath = path.join(stateDir, "create.yaml");
  fs.writeFileSync(policyPath, POLICY, { mode: 0o600 });
});

afterEach(() => fs.rmSync(stateDir, { recursive: true, force: true }));

describe("Hermes portable onboarding gateway-port recovery", () => {
  it("repairs a legacy configuring registry row without gateway port before active publication (#9211)", async () => {
    const fixture = createHermesPortableTransactionFixture(input(), {
      failAfterRegistry: true,
      omitRegistryGatewayPort: true,
    });

    await expect(runHermesPortableOnboardingTransaction(input(), fixture.value)).rejects.toThrow(
      "registry-to-active exit",
    );
    expect(fixture.value.readRegistry()).not.toHaveProperty("gatewayPort");
    fs.writeFileSync(policyPath, POLICY, { mode: 0o600 });

    const resumed = await runHermesPortableOnboardingTransaction(input(), fixture.value);

    expect(resumed.active.receipt.phase).toBe("active");
    expect(fixture.value.readRegistry()).toMatchObject({
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
    });
    expect(fixture.events.filter((event) => event === "registry-update")).toHaveLength(1);
    expect(fixture.events.filter((event) => event === "create")).toHaveLength(1);
    expect(fixture.events.filter((event) => event === "registry")).toHaveLength(1);
  });

  it("does not repair a replacement row after gateway-port qualification (#10056)", async () => {
    const replacementGeneration = "44444444-4444-4444-8444-444444444444";
    const fixture = createHermesPortableTransactionFixture(input(), {
      failAfterRegistry: true,
      omitRegistryGatewayPort: true,
      beforeCompareAndSetRegistryGatewayPort: (current) => ({
        ...current!,
        lifecycleGeneration: replacementGeneration,
      }),
    });

    await expect(runHermesPortableOnboardingTransaction(input(), fixture.value)).rejects.toThrow(
      "registry-to-active exit",
    );
    fs.writeFileSync(policyPath, POLICY, { mode: 0o600 });

    await expect(runHermesPortableOnboardingTransaction(input(), fixture.value)).rejects.toThrow(
      "registry gateway port repair did not complete",
    );
    expect(fixture.value.readRegistry()).toMatchObject({
      lifecycleGeneration: replacementGeneration,
      gatewayName: "nemoclaw",
    });
    expect(fixture.value.readRegistry()).not.toHaveProperty("gatewayPort");
    expect(fixture.events).not.toContain("registry-update");
  });

  it("recovers an interrupted provider through public fresh onboarding on a selected port", async () => {
    const gatewayName = "nemoclaw-18080";
    const fixture = createHermesPortableInferenceFixture(undefined, gatewayName);
    const fakeBin = path.join(fixture.homeDir, "bin");
    fs.mkdirSync(fakeBin);
    writeOkOpenshell(fakeBin, { gatewayPort: 18080 });
    vi.stubEnv("PATH", `${fakeBin}:/usr/bin`);
    vi.stubEnv("NEMOCLAW_GATEWAY_PORT", "18080");
    const { createDirectSetupInferenceHarnessFactory } =
      await import("../../../../test/support/setup-inference-test-harness");
    const selection = fixture.resolve()!;
    const bundle = selection.resolveRuntimeProvider(freshPortableInput.sandboxName)!;
    expect(bundle.hostLocalInference.supported).toBe(true);
    const hostLocalInference = bundle.hostLocalInference as Extract<
      typeof bundle.hostLocalInference,
      { supported: true }
    >;
    prepareHostLocalInferenceStartup(
      hostLocalInference.createOperation({ env: {}, acceleration: "nvidia-gpu" }),
      selection.request,
    ).prepared.validateBeforeCommit();
    const baseUrl = "http://host.openshell.internal:11434/v1";
    const mutation = await selection.prepareGatewayMutation({
      gatewayName,
      sandboxName: freshPortableInput.sandboxName,
      provider: "ollama-local",
      model: freshPortableInput.model,
      providerBaseUrl: baseUrl,
    });
    expect(
      mutation.upsertProvider!(
        freshPortableInput.provider,
        "openai",
        "NEMOCLAW_OLLAMA_PROXY_TOKEN",
        baseUrl,
        { NEMOCLAW_OLLAMA_PROXY_TOKEN: "ollama" },
      ),
    ).toMatchObject({ ok: true });
    await mutation.commit();
    const transactionRoot = path.join(fixture.resolverOptions.stateDir, "portable-inference");
    const directories = fs.readdirSync(transactionRoot);
    expect(directories).toHaveLength(1);
    const transactionDirectory = path.join(transactionRoot, directories[0]!);
    const journalPath = path.join(transactionDirectory, "portable-gateway-provider.json");
    const interruptedJournal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
      intent: { transactionId: string };
    };
    const interruptedTransaction = interruptedJournal.intent.transactionId;
    const sessionApi =
      require("../../state/onboard-session") as typeof import("../../state/onboard-session");
    sessionApi.saveSession(
      sessionApi.createSession({
        sessionId: "portable-session",
        sandboxName: freshPortableInput.sandboxName,
        agent: "hermes",
      }),
    );
    const runtime =
      require("../resume/locked-runtime") as typeof import("../resume/locked-runtime");
    const prepareRuntime = runtime.prepare;
    vi.spyOn(runtime, "prepare").mockImplementation((options, ...args) =>
      prepareRuntime(
        {
          ...options,
          preparePortableHost: () =>
            ({
              authority: fixture.runtime,
              containersConf: path.join(
                fixture.runtime.configHome,
                "nemoclaw/portable/containers.conf",
              ),
            }) as never,
        },
        ...args,
      ),
    );
    const inference =
      require("./hermes-portable-ollama-inference") as typeof import("./hermes-portable-ollama-inference");
    const createResolver = inference.createHermesPortableOllamaInferenceResolver;
    vi.spyOn(inference, "createHermesPortableOllamaInferenceResolver").mockImplementation(
      (options) => {
        expect(options.gatewayName).toBe(gatewayName);
        return createResolver({
          ...options,
          stateDir: fixture.resolverOptions.stateDir,
          captureSocketAuthority: fixture.resolverOptions.captureSocketAuthority,
          captureGpuDevices: fixture.resolverOptions.captureGpuDevices,
          captureCdiDevices: fixture.resolverOptions.captureCdiDevices,
          podmanAuthorityDeps: fixture.resolverOptions.podmanAuthorityDeps,
        });
      },
    );
    const runner = require("../../runner") as typeof import("../../runner");
    vi.spyOn(runner, "run").mockImplementation((command, options) => {
      const args = Array.isArray(command) ? command.map(String) : [String(command)];
      const providerIndex = args.indexOf("provider");
      expect(
        providerIndex,
        `Unexpected onboarding command: ${args.join(" ")}`,
      ).toBeGreaterThanOrEqual(0);
      const providerArgs = args.slice(providerIndex);
      const gatewayIndex = providerArgs.indexOf("-g");
      expect(providerArgs.slice(gatewayIndex, gatewayIndex + 2)).toEqual(["-g", gatewayName]);
      providerArgs.splice(gatewayIndex, 2);
      return fixture.gatewayProvider.run(providerArgs, options as never) as never;
    });
    vi.spyOn(runner, "runCapture").mockImplementation((command) => {
      throw new Error(`Unexpected onboarding capture: ${String(command)}`);
    });
    const initial =
      require("../machine/initial-flow-composition") as typeof import("../machine/initial-flow-composition");
    const { advanceTo } = require("../machine/result") as typeof import("../machine/result");
    vi.spyOn(initial, "createInitialOnboardFlowPhases").mockImplementation(
      () =>
        [
          {
            state: "preflight",
            async run(context) {
              return {
                context: {
                  ...context,
                  gpu: { type: "nvidia" },
                  gpuPassthrough: true,
                  sandboxGpuConfig: { mode: "enable", sandboxGpuEnabled: true },
                },
                result: advanceTo("gateway"),
              };
            },
          },
          {
            state: "gateway",
            async run(context) {
              return { context, result: advanceTo("provider_selection") };
            },
          },
        ] as ReturnType<typeof initial.createInitialOnboardFlowPhases>,
    );
    const setup = require("../setup-inference") as typeof import("../setup-inference");
    const createSetup = setup.createSetupInference;
    vi.spyOn(setup, "createSetupInference").mockImplementation(
      (deps) =>
        createDirectSetupInferenceHarnessFactory((overrides) =>
          createSetup({ ...deps, ...overrides }),
        )({ overrides: { error: deps.error, log: deps.log } }).setupInference,
    );
    const core =
      require("../machine/core-flow-composition") as typeof import("../machine/core-flow-composition");
    const createPhases = core.createCoreOnboardFlowPhases;
    const stop = "observed recovered provider before sandbox creation";
    vi.spyOn(core, "createCoreOnboardFlowPhases").mockImplementation((input) => {
      const phases = createPhases({
        ...input,
        providerInference: {
          ...input.providerInference,
          deps: {
            ...input.providerInference.deps,
            checkGatewayRouteCompatibility: () => ({ ok: true }),
            preflightGatewayRouteDiscovery: () => ({
              ok: true,
              requiredModel: null,
              requiredEndpointUrl: null,
              requiredInferenceApi: null,
            }),
            assessHost: () => ({ cpus: 8 }),
            formatSandboxBuildEstimateNote: () => "",
            formatOnboardConfigSummary: () => "Portable Ollama",
          },
        },
      });
      return {
        ...phases,
        sandbox: {
          state: "sandbox",
          async run() {
            throw new Error(stop);
          },
        },
      };
    });
    const { runOnboardAction } =
      require("../../actions/onboard") as typeof import("../../actions/onboard");
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const outcome = await runOnboardAction({
      agent: "hermes",
      name: freshPortableInput.sandboxName,
      fresh: true,
      "experimental-profile": "portable",
      "yes-i-accept-third-party-software": true,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(outcome, errors.mock.calls.flat().join("\n")).toHaveProperty("message", stop);

    const currentSession = sessionApi.loadSession();
    expect(currentSession?.sessionId).toBeTruthy();
    expect(currentSession?.sessionId).not.toBe("portable-session");
    expect(currentSession?.steps.inference.status).toBe("complete");
    expect(JSON.parse(fs.readFileSync(journalPath, "utf8"))).toMatchObject({
      phase: "committed",
      intent: { gatewayName, transactionId: interruptedTransaction },
    });
    expect(fs.existsSync(path.join(transactionDirectory, "portable-inference.json"))).toBe(true);
    expect(
      fixture.gatewayProvider
        .calls()
        .filter(({ args }) => args[0] === "provider" && args[1] === "create"),
    ).toHaveLength(1);
    expect(
      fixture.gatewayProvider
        .calls()
        .some(({ args }) => args[0] === "provider" && args[1] === "delete"),
    ).toBe(false);
  }, 30_000);
});
