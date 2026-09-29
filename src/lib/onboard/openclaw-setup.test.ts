// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

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
import { createInitialOpenclawInferenceRoute } from "./openclaw/initial-inference-route";

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
      shouldRestartNativeGateway: (provider) => provider === "nvidia-router",
    });

    await setup("spark-box", "model", "nvidia-router", revalidateSandboxIdentity);

    expect(configureOpenclawSandbox).toHaveBeenCalledExactlyOnceWith(
      "spark-box",
      "model",
      "nvidia-router",
      revalidateSandboxIdentity,
    );
    expect(restartNativeGateway).toHaveBeenCalledExactlyOnceWith("spark-box");
    expect(configureOpenclawSandbox).toHaveBeenCalledBefore(restartNativeGateway);
  });

  it("leaves ordinary providers on their initial native gateway", async () => {
    const restartNativeGateway = vi.fn(async () => ({ ok: true as const }));
    const setup = createOpenclawSetup({
      step: vi.fn(),
      agentProductName: () => "OpenClaw",
      configureOpenclawSandbox: vi.fn(async () => undefined),
      initializeOpenclawInferenceRoute: vi.fn(async () => undefined),
      restartNativeGateway,
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
    const setup = createOpenclawSetup({
      step: vi.fn(),
      agentProductName: () => "OpenClaw",
      configureOpenclawSandbox: vi.fn(async () => {
        order.push("configure");
      }),
      initializeOpenclawInferenceRoute,
      restartNativeGateway: vi.fn(async () => ({ ok: true as const })),
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
    );

    expect(order).toEqual(["configure", "initialize"]);
    expect(initializeOpenclawInferenceRoute).toHaveBeenCalledExactlyOnceWith(
      "spark-box",
      "selected/model",
      "compatible-endpoint",
      "openai-completions",
      "nemoclaw-19090",
      undefined,
    );
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
        shouldRestartNativeGateway: () => true,
      });

      await expect(setup("spark-box", "model", "nvidia-router")).rejects.toThrow(
        /native gateway restart failed.*restart rejected/,
      );
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
