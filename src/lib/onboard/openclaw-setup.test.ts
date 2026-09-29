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
      restartNativeGateway,
      shouldRestartNativeGateway: (provider) => provider === "nvidia-router",
    });

    await setup("spark-box", "model", "compatible-endpoint");

    expect(restartNativeGateway).not.toHaveBeenCalled();
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
