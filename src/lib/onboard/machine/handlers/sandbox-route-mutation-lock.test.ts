// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testTimeoutOptions } from "../../../../../test/helpers/timeouts";
import { handleSandboxState } from "./sandbox";
import { baseOptions, createDeps } from "./sandbox-test-fixtures";

describe("sandbox registration route transaction", () => {
  beforeEach(() => {
    vi.stubEnv("HOME", fs.mkdtempSync(path.join(os.tmpdir() ?? "/tmp", "nemoclaw-sandbox-route-")));
  });

  afterEach(() => {
    fs.rmSync(process.env.HOME!, { force: true, recursive: true });
    vi.unstubAllEnvs();
  });

  it("allows valid peer-route drift after waiting for the gateway lock", async () => {
    let releaseGateway!: () => void;
    const gatewayReleased = new Promise<void>((resolve) => {
      releaseGateway = resolve;
    });
    let reportGatewayEntered!: () => void;
    const gatewayEntered = new Promise<void>((resolve) => {
      reportGatewayEntered = resolve;
    });
    const checkGatewayRouteCompatibility = vi.fn(() => ({
      ok: false as const,
      gatewayName: "nemoclaw",
      sandboxName: "my-assistant",
      route: { provider: "provider", model: "model" },
      conflicts: [{ sandboxName: "peer", reason: "provider-model" as const }],
    }));
    const { calls, deps } = createDeps({
      checkGatewayRouteCompatibility,
      withSandboxMutationLock: async (_sandboxName, operation) => await operation(),
      withGatewayRouteMutationLock: async (_gatewayName, operation) => {
        reportGatewayEntered();
        await gatewayReleased;
        return await operation();
      },
    });

    const onboard = handleSandboxState(baseOptions(deps));
    await gatewayEntered;
    expect(checkGatewayRouteCompatibility).not.toHaveBeenCalled();
    releaseGateway();

    await expect(onboard).resolves.toMatchObject({ sandboxName: "my-assistant" });
    expect(checkGatewayRouteCompatibility).toHaveBeenCalledWith(
      expect.objectContaining({ gatewayName: "nemoclaw", sandboxName: null }),
    );
    expect(calls.createSandbox).toHaveBeenCalledOnce();
    expect(calls.updateSandbox).toHaveBeenCalled();
    expect(calls.removeSandbox).not.toHaveBeenCalled();
    expect(calls.startStep).toHaveBeenCalled();
    expect(calls.updateSession).toHaveBeenCalled();
    expect(calls.error).not.toHaveBeenCalled();
  });

  it("stages credentials, then holds sandbox, host dashboard, and gateway locks through creation", async () => {
    const events: string[] = [];
    let releaseProviderPlan!: () => void;
    const providerPlanReleased = new Promise<void>((resolve) => {
      releaseProviderPlan = resolve;
    });
    let reportProviderPlanEntered!: () => void;
    const providerPlanEntered = new Promise<void>((resolve) => {
      reportProviderPlanEntered = resolve;
    });
    const createSandbox = vi.fn(async () => {
      events.push("create");
      expect(fs.existsSync(path.join(process.env.HOME!, ".nemoclaw-portable-host.lock"))).toBe(
        true,
      );
      return "my-assistant";
    });
    const { deps } = createDeps({
      configureWebSearch: vi.fn(async () => ({
        fetchEnabled: true as const,
        provider: "brave" as const,
      })),
      checkGatewayRouteCompatibility: () => {
        events.push("guard");
        return { ok: true };
      },
      withSandboxMutationLock: async (_sandboxName, operation) => {
        events.push("sandbox-lock");
        return await operation();
      },
      withDashboardPortReservationLock: async (operation) => {
        events.push("dashboard-lock");
        return await operation();
      },
      withGatewayRouteMutationLock: async (_gatewayName, operation) => {
        events.push("gateway-lock");
        return await operation();
      },
      planRegisteredExtraProviders: async () => {
        events.push("provider-plan");
        reportProviderPlanEntered();
        await providerPlanReleased;
        return { extraProviders: [], staleExtraProviders: [] };
      },
      stageSandboxCredentialProviders: async () => {
        events.push("stage");
        return [];
      },
      createSandbox,
      finalizeSandboxRouteReservation: () => {
        events.push("publish");
        return true;
      },
      updateSandboxRegistry: () => {
        events.push("registry");
        expect(fs.existsSync(path.join(process.env.HOME!, ".nemoclaw-portable-host.lock"))).toBe(
          true,
        );
      },
    });

    const onboard = handleSandboxState(baseOptions(deps));
    await providerPlanEntered;
    expect(events).toEqual([
      "gateway-lock",
      "stage",
      "sandbox-lock",
      "dashboard-lock",
      "gateway-lock",
      "provider-plan",
    ]);
    expect(createSandbox).not.toHaveBeenCalled();
    releaseProviderPlan();

    await expect(onboard).resolves.toMatchObject({
      sandboxName: "my-assistant",
    });
    expect(events).toEqual([
      "gateway-lock",
      "stage",
      "sandbox-lock",
      "dashboard-lock",
      "gateway-lock",
      "provider-plan",
      "guard",
      "create",
      "registry",
    ]);
  });

  it(
    "rejects host-fence contention before sandbox registration side effects",
    testTimeoutOptions(30_000),
    async () => {
      const home = process.env.HOME!;
      const readyFile = path.join(home, "host-fence-ready");
      const releaseFile = path.join(home, "host-fence-release");
      const retirementModule = new URL(
        "../../../state/portable-uninstall-retirement.ts",
        import.meta.url,
      ).href;
      const childScript = String.raw`
        const fs = await import('node:fs');
        const loaded = await import(process.argv[2]);
        const { withPortableHostFence } = loaded.default ?? loaded;
        await withPortableHostFence(process.argv[1], async () => {
          fs.writeFileSync(process.argv[3], 'ready');
          while (!fs.existsSync(process.argv[4])) await new Promise(resolve => setTimeout(resolve, 10));
        });
      `;
      const child = spawn(
        process.execPath,
        [
          "--no-warnings",
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          childScript,
          home,
          retirementModule,
          readyFile,
          releaseFile,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let childOutput = "";
      child.stdout?.on("data", (chunk: Buffer) => (childOutput += chunk.toString()));
      child.stderr?.on("data", (chunk: Buffer) => (childOutput += chunk.toString()));
      const exited = once(child, "exit");
      try {
        await vi.waitFor(
          () => expect(fs.existsSync(readyFile)).toBe(true),
          testTimeoutOptions(30_000),
        );
        const { calls, deps } = createDeps();

        await expect(handleSandboxState(baseOptions(deps))).rejects.toThrow(
          /Host maintenance is in progress/,
        );

        expect(calls.createSandbox).not.toHaveBeenCalled();
        expect(calls.updateSandbox).not.toHaveBeenCalled();
        expect(calls.finalizeRouteReservation).not.toHaveBeenCalled();
        expect(calls.complete).not.toHaveBeenCalled();
      } finally {
        fs.writeFileSync(releaseFile, "release");
        const [code] = await exited;
        expect(code, childOutput).toBe(0);
      }
    },
  );

  it("fails when a competing same-name registration changed routes", async () => {
    const checkGatewayRouteCompatibility = vi.fn((request) =>
      request.sandboxName === null
        ? {
            ok: false as const,
            gatewayName: "nemoclaw",
            sandboxName: null,
            route: { provider: "provider", model: "model" },
            conflicts: [{ sandboxName: "my-assistant", reason: "provider-model" as const }],
          }
        : { ok: true as const },
    );
    const { calls, deps } = createDeps({
      checkGatewayRouteCompatibility,
      getSandboxRegistryEntry: () => ({
        name: "my-assistant",
        provider: "other-provider",
        model: "other-model",
      }),
    });

    await expect(handleSandboxState(baseOptions(deps))).rejects.toThrow("exit 1");

    expect(checkGatewayRouteCompatibility).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxName: null }),
    );
    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(calls.updateSandbox).not.toHaveBeenCalled();
    expect(calls.startStep).not.toHaveBeenCalled();
  });

  it("fails when the route reservation disappears before creation", async () => {
    const { calls, deps } = createDeps({ getSandboxRegistryEntry: () => null });

    await expect(handleSandboxState(baseOptions(deps))).rejects.toThrow("exit 1");

    expect(calls.error).toHaveBeenCalledWith(expect.stringContaining("disappeared"));
    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(calls.updateSandbox).not.toHaveBeenCalled();
    expect(calls.startStep).not.toHaveBeenCalled();
  });
});
