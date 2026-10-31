// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import { registeredInferenceFixture } from "../../../test/helpers/registered-inference";
import {
  isSandboxGatewayHttpReachableForStatus,
  waitForStartedNativeGatewayProcess,
} from "../actions/sandbox/process-recovery";
import {
  verifyRegisteredInferenceProviderAttachment,
  registeredInferenceProviderRevision,
} from "../inference/native-provider/registered";

import * as sandboxRecreateProbe from "./sandbox-recreate-probe";
import type { SandboxEntry } from "../state/registry/types";

const configMocks = vi.hoisted(() => ({
  readSandboxConfig: vi.fn(),
  restartSandboxAgentAfterConfigSet: vi.fn(),
  resolveAgentConfig: vi.fn(),
  setOpenClawConfigValue: vi.fn(),
}));

vi.mock("../sandbox/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sandbox/config")>()),
  readSandboxConfig: configMocks.readSandboxConfig,
  restartSandboxAgentAfterConfigSet: configMocks.restartSandboxAgentAfterConfigSet,
  resolveAgentConfig: configMocks.resolveAgentConfig,
  setOpenClawConfigValue: configMocks.setOpenClawConfigValue,
}));
import {
  createConfigureOpenclawSandbox,
  createOpenclawSetup,
  isOpenclawGatewayReady,
} from "./openclaw-setup";
import {
  type InitializeOpenclawInferenceRoute,
  refreshRestoredRegisteredOpenclawInferenceRoute,
  createInitialOpenclawInferenceRoute,
  createOpenclawInferenceRouteWriter,
} from "./openclaw/initial-inference-route";

import {
  patchOpenClawInferenceConfig,
  writeOpenClawInferenceConfigNatively,
} from "../actions/inference-set";

describe("OpenClaw sandbox setup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([200, 401])("accepts OpenClaw gateway HTTP %i as ready", async (httpCode) => {
    const runBuffered = vi.fn(async () => ({
      outcome: { kind: "completed" as const, exitCode: 0 },
      stdout: String(httpCode),
      stderr: "",
    }));

    await expect(
      isOpenclawGatewayReady("spark-box", 18_789, { runBuffered } as never),
    ).resolves.toBe(true);
    expect(runBuffered).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxName: "spark-box",
        command: expect.arrayContaining(["http://127.0.0.1:18789/health"]),
      }),
    );
  });

  it("keeps OpenClaw startup pending until the health endpoint responds", async () => {
    const runBuffered = vi.fn(async () => ({
      outcome: { kind: "completed" as const, exitCode: 0 },
      stdout: "000",
      stderr: "",
    }));

    await expect(
      isOpenclawGatewayReady("spark-box", 18_789, { runBuffered } as never),
    ).resolves.toBe(false);
  });

  it("bounds the gateway probe by the caller's remaining startup deadline", async () => {
    const runBuffered = vi.fn(async () => ({
      outcome: { kind: "completed" as const, exitCode: 0 },
      stdout: "000",
      stderr: "",
    }));

    await expect(
      isOpenclawGatewayReady("spark-box", 18_789, { runBuffered } as never, 750),
    ).resolves.toBe(false);

    expect(runBuffered).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.arrayContaining(["--max-time", "0.75"]),
      }),
    );
  });

  it("waits for onboarding metadata sync before completing setup", async () => {
    let finishConfigSync!: () => void;
    const configSync = new Promise<void>((resolve) => {
      finishConfigSync = resolve;
    });
    const syncNemoClawConfigInSandbox = vi.fn(() => configSync);
    const completed = vi.fn();
    const revalidateSandboxIdentity = vi.fn();
    const configureOpenclawSandbox = createConfigureOpenclawSandbox({
      syncNemoClawConfigInSandbox,
    });

    const configuring = configureOpenclawSandbox(
      "spark-box",
      "model",
      "provider",
      revalidateSandboxIdentity,
    );

    expect(syncNemoClawConfigInSandbox).toHaveBeenCalledExactlyOnceWith(
      "spark-box",
      "provider",
      "model",
      revalidateSandboxIdentity,
      false,
    );
    void configuring.then(completed);
    expect(completed).not.toHaveBeenCalled();

    finishConfigSync();
    await configuring;

    expect(completed).toHaveBeenCalledOnce();
  });

  it("propagates onboarding metadata sync failure", async () => {
    const syncNemoClawConfigInSandbox = vi.fn(async () => {
      throw new Error("config sync failed");
    });
    const configureOpenclawSandbox = createConfigureOpenclawSandbox({
      syncNemoClawConfigInSandbox,
    });

    await expect(configureOpenclawSandbox("spark-box", "model", "provider")).rejects.toThrow(
      "config sync failed",
    );
  });

  it("delegates fresh setup to shared OpenClaw configuration", async () => {
    const configureOpenclawSandbox = vi.fn(async () => undefined);
    const restartNativeGateway = vi.fn(async () => ({ ok: true as const }));
    const revalidateSandboxIdentity = vi.fn();
    const setup = createOpenclawSetup({
      step: vi.fn(),
      agentProductName: () => "OpenClaw",
      configureOpenclawSandbox,
      initializeOpenclawInferenceRoute: vi.fn(async () => undefined),
      restartNativeGateway,
      waitForGatewayStartup: vi.fn(async () => true),
      shouldRestartNativeGateway: (provider) => provider === "nvidia-router",
    });

    await setup(
      "spark-box",
      "model",
      "nvidia-router",
      revalidateSandboxIdentity,
      null,
      false,
      "nemoclaw-19090",
    );

    expect(configureOpenclawSandbox).toHaveBeenCalledExactlyOnceWith(
      "spark-box",
      "model",
      "nvidia-router",
      revalidateSandboxIdentity,
    );
    expect(restartNativeGateway).toHaveBeenCalledExactlyOnceWith("spark-box", "nemoclaw-19090");
    expect(configureOpenclawSandbox).toHaveBeenCalledBefore(restartNativeGateway);
  });

  it("waits through connection refusal before restarting the routed gateway (#13465)", async () => {
    let now = 0;
    const runBuffered = vi
      .fn()
      .mockResolvedValueOnce({
        outcome: { kind: "completed", exitCode: 0 },
        stdout: "__NEMOCLAW_SANDBOX_EXEC_STARTED__\nSTOPPED",
        stderr: "",
      })
      .mockResolvedValueOnce({
        outcome: { kind: "completed", exitCode: 0 },
        stdout: "__NEMOCLAW_SANDBOX_EXEC_STARTED__\nRUNNING",
        stderr: "",
      });
    const probe = vi.fn((name, gateway, options) =>
      isSandboxGatewayHttpReachableForStatus(name, gateway, {
        ...options,
        commandExecutor: { runBuffered } as never,
        getHealthProbeUrl: () => "http://127.0.0.1:18790/health",
      }),
    );
    const waitForStartedOpenclawGatewayProcess = vi.fn((name: string, gateway: string) =>
      waitForStartedNativeGatewayProcess(name, "openclaw", gateway, {
        probe,
        now: () => now,
        delay: async (ms) => {
          now += ms;
        },
        environment: {},
      }),
    );
    const restartNativeGateway = vi.fn(async () => ({ ok: true as const }));
    const configureOpenclawSandbox = vi.fn(async () => undefined);
    const setup = createOpenclawSetup({
      step: vi.fn(),
      agentProductName: () => "OpenClaw",
      configureOpenclawSandbox,
      restartNativeGateway,
      shouldRestartNativeGateway: () => true,
      waitForGatewayStartup: waitForStartedOpenclawGatewayProcess,
    });

    await setup("spark-box", "model", "nvidia-router", vi.fn(), null, false, "nemoclaw-19090");

    expect(probe).toHaveBeenCalledTimes(2);
    expect(runBuffered).toHaveBeenLastCalledWith(
      expect.objectContaining({
        target: { kind: "named", gatewayName: "nemoclaw-19090" },
        command: expect.arrayContaining([expect.stringContaining("http://127.0.0.1:18790/health")]),
      }),
    );
    expect(probe).toHaveBeenLastCalledWith("spark-box", "nemoclaw-19090", {
      startup: { timeoutMs: expect.any(Number) },
    });
    expect(configureOpenclawSandbox).toHaveBeenCalledBefore(waitForStartedOpenclawGatewayProcess);
    expect(waitForStartedOpenclawGatewayProcess).toHaveBeenCalledBefore(restartNativeGateway);
    expect(restartNativeGateway).toHaveBeenCalledExactlyOnceWith("spark-box", "nemoclaw-19090");
  });

  it.each([
    { name: "deadline exhaustion", observation: false, elapsed: 0 },
    { name: "inconclusive transport", observation: null, elapsed: 0 },
    { name: "readiness after the deadline", observation: true, elapsed: 30_000 },
  ])("withholds routed restart and success on $name (#13465)", async ({ observation, elapsed }) => {
    let now = 0;
    const probe = vi.fn(async () => {
      now += elapsed;
      return observation;
    });
    const restartNativeGateway = vi.fn(async () => ({ ok: true as const }));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const setup = createOpenclawSetup({
        step: vi.fn(),
        agentProductName: () => "OpenClaw",
        configureOpenclawSandbox: vi.fn(async () => undefined),
        shouldRestartNativeGateway: () => true,
        restartNativeGateway,
        waitForGatewayStartup: (name, gateway) =>
          waitForStartedNativeGatewayProcess(name, "openclaw", gateway, {
            probe,
            now: () => now,
            delay: async (ms) => {
              now += ms;
            },
            environment: {},
          }),
      });
      await expect(
        setup("spark-box", "model", "nvidia-router", vi.fn(), null, false, "nemoclaw-19090"),
      ).rejects.toThrow("startup did not settle before routed gateway restart");
      expect(now).toBeLessThanOrEqual(30_000);
      expect(probe).toHaveBeenCalled();
      expect(restartNativeGateway).not.toHaveBeenCalled();
      expect(log.mock.calls.flat().join("\n")).not.toContain("gateway launched");
    } finally {
      log.mockRestore();
    }
  });

  it("refuses routed restart when identity changes during startup settlement (#13465)", async () => {
    const revalidateSandboxIdentity = vi
      .fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("sandbox identity changed");
      });
    const restartNativeGateway = vi.fn();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const setup = createOpenclawSetup({
        step: vi.fn(),
        agentProductName: () => "OpenClaw",
        configureOpenclawSandbox: vi.fn(async () => undefined),
        shouldRestartNativeGateway: () => true,
        restartNativeGateway,
        waitForGatewayStartup: vi.fn(async () => true),
      });
      await expect(
        setup(
          "spark-box",
          "model",
          "nvidia-router",
          revalidateSandboxIdentity,
          null,
          false,
          "nemoclaw-19090",
        ),
      ).rejects.toThrow("sandbox identity changed");
      expect(restartNativeGateway).not.toHaveBeenCalled();
      expect(log.mock.calls.flat().join("\n")).not.toContain("gateway launched");
    } finally {
      log.mockRestore();
    }
  });

  it("leaves ordinary providers on their initial native gateway", async () => {
    const restartNativeGateway = vi.fn(async () => ({ ok: true as const }));
    const setup = createOpenclawSetup({
      step: vi.fn(),
      agentProductName: () => "OpenClaw",
      configureOpenclawSandbox: vi.fn(async () => undefined),
      initializeOpenclawInferenceRoute: vi.fn(async () => undefined),
      restartNativeGateway,
      waitForGatewayStartup: vi.fn(async () => true),
      shouldRestartNativeGateway: (provider) => provider === "nvidia-router",
    });

    await setup("spark-box", "model", "compatible-endpoint");

    expect(restartNativeGateway).not.toHaveBeenCalled();
  });

  it("initializes a fresh custom-image route before reporting setup success (#12033)", async () => {
    const order: string[] = [];
    const initializeOpenclawInferenceRoute = vi.fn(async () => {
      order.push("initialize");
    });
    const settleOpenclawPairingBeforeRestart = vi.fn(async () => {
      order.push("pair");
      return true;
    });
    const setup = createOpenclawSetup({
      step: vi.fn(),
      agentProductName: () => "OpenClaw",
      configureOpenclawSandbox: vi.fn(async () => {
        order.push("configure");
      }),
      initializeOpenclawInferenceRoute,
      restartNativeGateway: vi.fn(async () => ({ ok: true as const })),
      waitForGatewayStartup: vi.fn(async () => true),
      shouldRestartNativeGateway: () => false,
    });

    await setup(
      "spark-box",
      "selected/model",
      "compatible-endpoint",
      undefined,
      "openai-completions",
      true,
      "nemoclaw-19090",
      settleOpenclawPairingBeforeRestart,
    );

    expect(order).toEqual(["configure", "pair", "initialize"]);
    expect(initializeOpenclawInferenceRoute).toHaveBeenCalledExactlyOnceWith(
      "spark-box",
      "selected/model",
      "compatible-endpoint",
      "openai-completions",
      "nemoclaw-19090",
      undefined,
    );
  });

  it("withholds the custom-image restart when post-config pairing does not settle (#11932)", async () => {
    const initializeOpenclawInferenceRoute = vi.fn(async () => undefined);
    const setup = createOpenclawSetup({
      step: vi.fn(),
      agentProductName: () => "OpenClaw",
      configureOpenclawSandbox: vi.fn(async () => undefined),
      initializeOpenclawInferenceRoute,
      restartNativeGateway: vi.fn(async () => ({ ok: true as const })),
      waitForGatewayStartup: vi.fn(async () => true),
      shouldRestartNativeGateway: () => false,
    });

    await expect(
      setup(
        "spark-box",
        "selected/model",
        "compatible-endpoint",
        undefined,
        "openai-completions",
        true,
        "nemoclaw-19090",
        async () => false,
      ),
    ).rejects.toThrow(/pairing did not settle after configuration/u);

    expect(initializeOpenclawInferenceRoute).not.toHaveBeenCalled();
  });

  it("withholds setup success when sandbox identity changes during config sync (#9833)", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const setup = createOpenclawSetup({
        step: vi.fn(),
        agentProductName: () => "OpenClaw",
        configureOpenclawSandbox: async () => {
          throw new Error("sandbox identity changed");
        },
        initializeOpenclawInferenceRoute: vi.fn(async () => undefined),
        restartNativeGateway: vi.fn(),
        waitForGatewayStartup: vi.fn(async () => true),
        shouldRestartNativeGateway: () => false,
      });

      await expect(setup("spark-box", "model", "provider")).rejects.toThrow(
        "sandbox identity changed",
      );

      expect(log.mock.calls.flat().join("\n")).not.toContain("gateway launched");
    } finally {
      log.mockRestore();
    }
  });

  it("withholds setup success when the native gateway restart fails", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const setup = createOpenclawSetup({
        step: vi.fn(),
        agentProductName: () => "OpenClaw",
        configureOpenclawSandbox: vi.fn(async () => undefined),
        initializeOpenclawInferenceRoute: vi.fn(async () => undefined),
        restartNativeGateway: vi.fn(async () => ({
          ok: false as const,
          failureLayer: "native agent command",
          detail: "restart rejected",
        })),
        waitForGatewayStartup: vi.fn(async () => true),
        shouldRestartNativeGateway: () => true,
      });

      await expect(
        setup("spark-box", "model", "nvidia-router", undefined, null, false, "nemoclaw-19090"),
      ).rejects.toThrow(/native gateway restart failed.*restart rejected/);
      expect(log.mock.calls.flat().join("\n")).not.toContain("gateway launched");
    } finally {
      log.mockRestore();
    }
  });
});

describe("initial OpenClaw inference route", () => {
  it("applies the selected route natively before a confirmed gateway restart (#12033)", async () => {
    const order: string[] = [];
    vi.stubEnv("OPENSHELL_GATEWAY", "ambient-gateway");
    const config = { agents: {}, models: {} };
    const route = {
      providerKey: "inference",
      primaryModelRef: "inference/selected/model",
      inferenceBaseUrl: "https://inference.local/v1",
      inferenceApi: "openai-completions",
      inferenceCompat: null,
    };
    const patchOpenclawInferenceConfig = vi.fn(() => ({ route }));
    const initialize = createInitialOpenclawInferenceRoute({
      readOpenclawConfig: vi.fn((_sandbox, gatewayName) => {
        expect(gatewayName).toBe("nemoclaw-19090");
        return config;
      }),
      patchOpenclawInferenceConfig,
      writeOpenclawInferenceConfigNatively: vi.fn((_sandbox, _config, _route, gatewayName) => {
        expect(gatewayName).toBe("nemoclaw-19090");
        order.push("write");
      }),
      restartNativeGateway: vi.fn(async (_sandbox, gatewayName) => {
        expect(gatewayName).toBe("nemoclaw-19090");
        order.push("restart");
        return { ok: true as const };
      }),
    });

    await initialize("spark-box", "selected/model", "compatible-endpoint", null, "nemoclaw-19090");

    expect(order).toEqual(["write", "restart"]);
    expect(patchOpenclawInferenceConfig).toHaveBeenCalledExactlyOnceWith(
      config,
      "compatible-endpoint",
      "selected/model",
      null,
      undefined,
      "compatible-endpoint",
      { effort: null, explicit: false },
      false,
      undefined,
      true,
      undefined,
      undefined,
    );
  });

  it("fails initialization when the gateway restart is not confirmed (#12033)", async () => {
    const initialize = createInitialOpenclawInferenceRoute({
      readOpenclawConfig: vi.fn(() => ({ agents: {}, models: {} })),
      patchOpenclawInferenceConfig: vi.fn(() => ({
        route: {
          providerKey: "inference",
          primaryModelRef: "inference/selected/model",
          inferenceBaseUrl: "https://inference.local/v1",
          inferenceApi: "openai-completions",
          inferenceCompat: null,
        },
      })),
      writeOpenclawInferenceConfigNatively: vi.fn(),
      restartNativeGateway: vi.fn(async () => ({
        ok: false as const,
        failureLayer: "native agent command",
        detail: "restart rejected",
      })),
    });

    await expect(
      initialize("spark-box", "selected/model", "compatible-endpoint", null, "nemoclaw-19090"),
    ).rejects.toThrow(/restart failed after initial inference configuration.*restart rejected/u);
  });
});

describe("OpenClaw reuse preserves native configuration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([false, true])(
    "preserves native web search with managed profile applied=%s (#11764)",
    async (managedProfileApplied) => {
      const nativeConfig = { tools: { web: { search: { enabled: true } } } };
      configMocks.resolveAgentConfig.mockReturnValue({ agentName: "openclaw" });
      configMocks.readSandboxConfig.mockReturnValue(nativeConfig);
      configMocks.setOpenClawConfigValue.mockImplementation(() => {
        nativeConfig.tools.web.search.enabled = false;
      });
      const syncNemoClawConfigInSandbox = vi.fn(async () => undefined);
      const configure = createConfigureOpenclawSandbox({ syncNemoClawConfigInSandbox });

      await configure("alpha", "model", "provider", undefined, managedProfileApplied);

      expect(nativeConfig.tools.web.search.enabled).toBe(true);
      expect(configMocks.setOpenClawConfigValue).not.toHaveBeenCalled();
      expect(configMocks.restartSandboxAgentAfterConfigSet).not.toHaveBeenCalled();
      expect(syncNemoClawConfigInSandbox).toHaveBeenCalledExactlyOnceWith(
        "alpha",
        "provider",
        "model",
        undefined,
        managedProfileApplied,
      );
    },
  );
});

describe("restored native OpenClaw inference fields", () => {
  it("changes the selected route while preserving unrelated native settings (#12667)", async () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "inference/test-model", fallbacks: ["other/fallback"] },
          workspace: "/sandbox/custom",
        },
      },
      channels: { telegram: { enabled: true } },
      gateway: { port: 18789 },
      models: { providers: { other: { models: [{ id: "fallback" }] } } },
    };
    const writeValues = vi.fn();
    const identity = vi.fn();
    const write = createOpenclawInferenceRouteWriter({
      readInferenceSelection: () => ({ nativeProvider: false }),
      readOpenclawConfig: () => config,
      patchOpenclawInferenceConfig: patchOpenClawInferenceConfig,
      writeOpenclawInferenceConfigNatively: (name, patched, route, gateway) =>
        writeOpenClawInferenceConfigNatively(name, patched, route, writeValues, gateway),
    });
    await write(
      "openclaw",
      "changed-model",
      "compatible-endpoint",
      null,
      "nemoclaw-9090",
      identity,
    );
    expect(config).toMatchObject({
      agents: {
        defaults: {
          model: { primary: "inference/changed-model", fallbacks: ["other/fallback"] },
          workspace: "/sandbox/custom",
        },
      },
      channels: { telegram: { enabled: true } },
      gateway: { port: 18789 },
      models: { providers: { other: { models: [{ id: "fallback" }] } } },
    });
    expect(writeValues).toHaveBeenCalledExactlyOnceWith(
      "openclaw",
      [
        { dotpath: "agents.defaults.model.primary", value: "inference/changed-model" },
        { dotpath: "models.mode", value: "merge" },
        {
          dotpath: "models.providers.inference",
          value: expect.objectContaining({
            models: [expect.objectContaining({ id: "changed-model" })],
          }),
        },
      ],
      "nemoclaw-9090",
    );
    expect(identity).toHaveBeenCalledTimes(2);
  });
});

describe("initial Hermes provider selection", () => {
  it.each([
    {
      nativeProvider: false,
      endpointUrl: "https://custom.example/v1",
      expected: "https://inference.local/v1",
    },
    {
      nativeProvider: true,
      endpointUrl: "https://authenticated.example/v1",
      expected: "https://authenticated.example/v1",
    },
    {
      nativeProvider: true,
      endpointUrl: "https://inference-api.nousresearch.com/v1",
      expected: "https://inference-api.nousresearch.com/v1",
    },
  ])(
    "preserves $endpointUrl with nativeProvider=$nativeProvider",
    async ({ expected, ...selection }) => {
      const config = {};
      const writeConfig = vi.fn();
      const readInferenceSelection = vi.fn(() => selection);
      const write = createOpenclawInferenceRouteWriter({
        readInferenceSelection,
        readOpenclawConfig: () => config,
        patchOpenclawInferenceConfig: patchOpenClawInferenceConfig,
        writeOpenclawInferenceConfigNatively: writeConfig,
      });
      await write("alpha", "fixture-model", "hermes-provider", null, "selected-gateway");
      expect(readInferenceSelection).toHaveBeenCalledExactlyOnceWith(
        "alpha",
        "selected-gateway",
        "hermes-provider",
      );
      expect(writeConfig).toHaveBeenCalledWith(
        "alpha",
        config,
        expect.objectContaining({ inferenceBaseUrl: expected }),
        "selected-gateway",
      );
      readInferenceSelection.mockClear();
      await write(
        "alpha",
        "fixture-model",
        "hermes-provider",
        null,
        "selected-gateway",
        undefined,
        selection,
      );
      expect(readInferenceSelection).not.toHaveBeenCalled();
      expect(writeConfig).toHaveBeenLastCalledWith(
        "alpha",
        config,
        expect.objectContaining({ inferenceBaseUrl: expected }),
        "selected-gateway",
      );
    },
  );
});

describe("restored registered OpenClaw selection", () => {
  it.each(["attached", "replaced", "detached", "wrong-gateway", "changed-revision"])(
    "refreshes only a verified selection: %s",
    async (state) => {
      const fixture = registeredInferenceFixture(true);
      const overrides: Record<string, Partial<typeof fixture.state>> = {
        attached: {},
        replaced: { id: "replacement" },
        detached: { attached: false },
        "wrong-gateway": {},
        "changed-revision": {},
      };
      Object.assign(fixture.state, overrides[state]);
      const binding = fixture.binding;
      const selectedModel = {
        id: "selected-model",
        contextWindow: 131072,
        maxTokens: 8192,
        compat: { supportsStore: false },
        params: { custom: "retained" },
      };
      const config = {
        agents: { defaults: { model: { primary: "old/old-model" } } },
        models: {
          providers: {
            [binding.providerName]: {
              baseUrl: binding.endpointUrl,
              api: binding.inferenceApi,
              apiKey: "openshell:resolve:env:v1_VENDOR_API_KEY",
              models: [selectedModel],
            },
          },
        },
        channels: { retained: true },
      };
      const writeConfig = vi.fn();
      const readHandle = vi.fn(async () => {
        fixture.state.revision += Number(state === "changed-revision");
        return fixture.handle;
      });
      const readConfig = vi.fn(() => config);
      const writer = createOpenclawInferenceRouteWriter({
        readOpenclawConfig: readConfig,
        patchOpenclawInferenceConfig: patchOpenClawInferenceConfig,
        writeOpenclawInferenceConfigNatively: writeConfig,
        verifyRegisteredAttachment: async (expected) => {
          await verifyRegisteredInferenceProviderAttachment({ adapter: fixture.adapter, expected });
          return registeredInferenceProviderRevision({ adapter: fixture.adapter, expected });
        },
        readRegisteredHandle: readHandle,
      });
      const operation = writer(
        binding.sandboxName,
        "selected-model",
        binding.providerName,
        binding.inferenceApi,
        state === "wrong-gateway" ? "other" : binding.gatewayName,
        undefined,
        {
          nativeProvider: true,
          endpointUrl: binding.endpointUrl,
          registeredInferenceProviderAttachment: binding,
        },
      );
      const outcome = await operation.then(
        () => "written",
        () => "refused",
      );
      expect(outcome).toBe(state === "attached" ? "written" : "refused");
      expect(readHandle.mock.calls).toEqual(
        ["attached", "changed-revision"].includes(state) ? [[binding]] : [],
      );
      expect(readConfig.mock.calls).toEqual(
        state === "attached" ? [[binding.sandboxName, binding.gatewayName]] : [],
      );
      expect(writeConfig.mock.calls).toEqual(
        state === "attached"
          ? [
              [
                binding.sandboxName,
                config,
                expect.objectContaining({
                  providerKey: binding.providerName,
                  inferenceBaseUrl: binding.endpointUrl,
                  inferenceApi: binding.inferenceApi,
                }),
                binding.gatewayName,
              ],
            ]
          : [],
      );
      expect(config.models.providers[binding.providerName]).toMatchObject({
        models: [selectedModel],
        apiKey: state === "attached" ? fixture.handle : "openshell:resolve:env:v1_VENDOR_API_KEY",
      });
      expect(config.channels).toEqual({ retained: true });
    },
  );
});

it.each([
  "verified",
  "changed-registration",
  "changed-agent",
  "changed-live-id",
  "wrong-runtime",
  "unrelated-update",
])("checks outer restored OpenClaw identity before projection: %s", async (state) => {
  const f = registeredInferenceFixture(true);
  const entry = {
    name: f.binding.sandboxName,
    agent: "openclaw",
    provider: f.binding.providerName,
    model: "selected-model",
    endpointUrl: f.binding.endpointUrl,
    preferredInferenceApi: f.binding.inferenceApi,
    credentialEnv: f.binding.credentialEnv,
    gatewayName: f.binding.gatewayName,
    registeredInferenceProviderAttachment: f.binding,
    lifecycleGeneration: "generation",
    lifecycleLiveIdentityFingerprint: "fingerprint",
  } as SandboxEntry;
  const observe = vi.spyOn(sandboxRecreateProbe, "observeSandboxOnGateway").mockReturnValue({
    state: "not_ready",
    liveIdentityFingerprint: state === "changed-live-id" ? "other" : "fingerprint",
  });
  const read = vi.fn(() =>
    state === "changed-registration"
      ? { ...entry, model: "other-model" }
      : state === "changed-agent"
        ? { ...entry, agent: "hermes" }
        : state === "unrelated-update"
          ? { ...entry, dashboardPort: 9001 }
          : entry,
  );
  const write = vi.fn<InitializeOpenclawInferenceRoute>(
    async (_name, _model, _provider, _api, _gateway, assertCurrent) => {
      assertCurrent?.("write restored config");
    },
  );
  const runtime = {
    gatewayName: state === "wrong-runtime" ? "other" : f.binding.gatewayName,
  } as never;
  const result = await refreshRestoredRegisteredOpenclawInferenceRoute(
    entry,
    runtime,
    read,
    write,
  ).then(
    () => "written",
    () => "refused",
  );
  expect(result).toBe(["verified", "unrelated-update"].includes(state) ? "written" : "refused");
  expect(write.mock.calls).toEqual(
    ["verified", "unrelated-update"].includes(state)
      ? [
          [
            entry.name,
            entry.model,
            entry.provider,
            entry.preferredInferenceApi,
            entry.gatewayName,
            expect.any(Function),
            {
              nativeProvider: true,
              endpointUrl: f.binding.endpointUrl,
              registeredInferenceProviderAttachment: f.binding,
            },
          ],
        ]
      : [],
  );
  expect(
    observe.mock.calls.every(
      ([target, , selected]) => target.gatewayName === entry.gatewayName && selected === runtime,
    ),
  ).toBe(true);
});
