// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  createConfigureOpenclawSandbox,
  createOpenclawSetup,
  isOpenclawGatewayReady,
  reconcileOpenClawWebSearchForReuse,
} from "./openclaw-setup";

describe("OpenClaw sandbox setup", () => {
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

  it("waits for config sync before web-search reconciliation", async () => {
    let finishConfigSync!: () => void;
    const configSync = new Promise<void>((resolve) => {
      finishConfigSync = resolve;
    });
    const syncNemoClawConfigInSandbox = vi.fn(() => configSync);
    const reconcileWebSearch = vi.fn(async () => undefined);
    const revalidateSandboxIdentity = vi.fn();
    const configureOpenclawSandbox = createConfigureOpenclawSandbox({
      syncNemoClawConfigInSandbox,
      reconcileWebSearch,
    });

    const configuring = configureOpenclawSandbox(
      "spark-box",
      "model",
      "provider",
      null,
      revalidateSandboxIdentity,
    );

    expect(syncNemoClawConfigInSandbox).toHaveBeenCalledExactlyOnceWith(
      "spark-box",
      "provider",
      "model",
      revalidateSandboxIdentity,
      false,
    );
    expect(reconcileWebSearch).not.toHaveBeenCalled();

    finishConfigSync();
    await configuring;

    expect(reconcileWebSearch).toHaveBeenCalledExactlyOnceWith(
      "spark-box",
      null,
      revalidateSandboxIdentity,
    );
  });

  it("propagates config sync failure before web-search reconciliation", async () => {
    const syncNemoClawConfigInSandbox = vi.fn(async () => {
      throw new Error("config sync failed");
    });
    const reconcileWebSearch = vi.fn(async () => undefined);
    const configureOpenclawSandbox = createConfigureOpenclawSandbox({
      syncNemoClawConfigInSandbox,
      reconcileWebSearch,
    });

    await expect(configureOpenclawSandbox("spark-box", "model", "provider", null)).rejects.toThrow(
      "config sync failed",
    );

    expect(reconcileWebSearch).not.toHaveBeenCalled();
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

    await setup("spark-box", "model", "nvidia-router", null, revalidateSandboxIdentity);

    expect(configureOpenclawSandbox).toHaveBeenCalledExactlyOnceWith(
      "spark-box",
      "model",
      "nvidia-router",
      null,
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

    await setup("spark-box", "model", "compatible-endpoint", null);

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

      await expect(setup("spark-box", "model", "provider", null)).rejects.toThrow(
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

      await expect(setup("spark-box", "model", "nvidia-router", null)).rejects.toThrow(
        /native gateway restart failed.*restart rejected/,
      );
      expect(log.mock.calls.flat().join("\n")).not.toContain("gateway launched");
    } finally {
      log.mockRestore();
    }
  });
});

describe("fresh OpenClaw reuse web search reconciliation", () => {
  it("disables stale live web search when fresh re-onboard selects disabled (#10404)", async () => {
    const disable = vi.fn(async () => undefined);

    await reconcileOpenClawWebSearchForReuse("alpha", null, undefined, {
      readEnabled: () => true,
      disable,
    });

    expect(disable).toHaveBeenCalledExactlyOnceWith("alpha");
  });

  it("leaves an already-disabled live config unchanged (#10404)", async () => {
    const disable = vi.fn(async () => undefined);

    await reconcileOpenClawWebSearchForReuse("alpha", null, undefined, {
      readEnabled: () => false,
      disable,
    });

    expect(disable).not.toHaveBeenCalled();
  });

  it("leaves a config without a stale enabled flag unchanged (#10404)", async () => {
    const disable = vi.fn(async () => undefined);

    await reconcileOpenClawWebSearchForReuse("alpha", null, undefined, {
      readEnabled: () => undefined,
      disable,
    });

    expect(disable).not.toHaveBeenCalled();
  });

  it("does not disable the live config when web search remains selected (#10404)", async () => {
    const readEnabled = vi.fn(() => true);
    const disable = vi.fn(async () => undefined);

    await reconcileOpenClawWebSearchForReuse("alpha", { fetchEnabled: true }, undefined, {
      readEnabled,
      disable,
    });

    expect(readEnabled).not.toHaveBeenCalled();
    expect(disable).not.toHaveBeenCalled();
  });

  it("does not mutate when sandbox identity changes after the live-config read (#10404)", async () => {
    const readEnabled = vi.fn(() => true);
    const disable = vi.fn(async () => undefined);
    const revalidateSandboxIdentity = vi.fn(() => {
      throw new Error("sandbox identity changed");
    });

    await expect(
      reconcileOpenClawWebSearchForReuse("alpha", null, revalidateSandboxIdentity, {
        readEnabled,
        disable,
      }),
    ).rejects.toThrow("sandbox identity changed");

    expect(readEnabled).toHaveBeenCalledExactlyOnceWith("alpha");
    expect(revalidateSandboxIdentity).toHaveBeenCalledExactlyOnceWith(
      "disable OpenClaw web search in sandbox 'alpha'",
    );
    expect(disable).not.toHaveBeenCalled();
  });
});
