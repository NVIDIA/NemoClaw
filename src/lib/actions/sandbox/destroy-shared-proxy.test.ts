// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import {
  createDestroyHarness,
  resetDestroyModuleCache,
} from "../../../../test/helpers/destroy-flow-test-harness";

import { OLLAMA_LOCAL_CREDENTIAL_ENV } from "../../inference/ollama/contract";
import type { SandboxEntry } from "../../state/registry";
import { stopDestroyedSandboxProxy } from "./destroy-preflight";

describe("destroy shared Ollama proxy cleanup", () => {
  it("keeps the proxy while another sandbox owns its credential route", () => {
    const target = { name: "alpha", provider: "ollama-local" } as SandboxEntry;
    const peer = {
      name: "beta",
      provider: "compatible-endpoint",
      endpointUrl: "http://localhost:11434/v1",
      credentialEnv: "NEMOCLAW_OLLAMA_PROXY_TOKEN",
    } as SandboxEntry;
    const killStaleProxyIfUnused = vi.fn((hasRemainingOwner: () => boolean) => {
      return !hasRemainingOwner();
    });

    stopDestroyedSandboxProxy(
      "alpha",
      target,
      () => ({
        sandboxes: [target, peer],
        defaultSandbox: "alpha",
      }),
      { killStaleProxyIfUnused },
    );

    expect(killStaleProxyIfUnused).toHaveBeenCalledOnce();
    expect(killStaleProxyIfUnused.mock.calls[0]?.[0]()).toBe(true);
  });

  it.each(["compatible-endpoint", "compatible-anthropic-endpoint"])(
    "stops the shared proxy after its final %s owner is removed",
    (provider) => {
      const ollama = { name: "alpha", provider: "ollama-local" } as SandboxEntry;
      const compatible = {
        name: "beta",
        provider,
        credentialEnv: OLLAMA_LOCAL_CREDENTIAL_ENV,
      } as SandboxEntry;
      let sandboxes = [ollama, compatible];
      let proxyRunning = true;
      const killStaleProxyIfUnused = vi.fn((hasRemainingOwner: () => boolean) => {
        proxyRunning = hasRemainingOwner();
        return !proxyRunning;
      });
      const listSandboxes = () => ({ sandboxes, defaultSandbox: "beta" });

      stopDestroyedSandboxProxy("beta", compatible, listSandboxes, { killStaleProxyIfUnused });
      expect(proxyRunning).toBe(true);
      stopDestroyedSandboxProxy("alpha", ollama, listSandboxes, { killStaleProxyIfUnused });
      expect(proxyRunning).toBe(true);
      sandboxes = [compatible];
      stopDestroyedSandboxProxy("beta", compatible, listSandboxes, { killStaleProxyIfUnused });
      expect(proxyRunning).toBe(false);
      expect(killStaleProxyIfUnused).toHaveBeenCalledTimes(3);
    },
  );

  it("does not clean up the proxy for an authenticated compatible endpoint", () => {
    const target = {
      name: "authenticated",
      provider: "compatible-endpoint",
      credentialEnv: "COMPATIBLE_API_KEY",
    } as SandboxEntry;
    const killStaleProxyIfUnused = vi.fn();

    stopDestroyedSandboxProxy(
      target.name,
      target,
      () => ({ sandboxes: [target], defaultSandbox: target.name }),
      { killStaleProxyIfUnused },
    );

    expect(killStaleProxyIfUnused).not.toHaveBeenCalled();
  });
});

describe("confirmed destroy proxy cleanup", () => {
  let testHome: string;
  let exitSpy: MockInstance;

  beforeEach(() => {
    testHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-destroy-proxy-"));
    vi.stubEnv("HOME", testHome);
    vi.stubEnv("OPENSHELL_GATEWAY", process.env.OPENSHELL_GATEWAY);
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetDestroyModuleCache();
    fs.rmSync(testHome, { force: true, recursive: true });
  });

  it.each(["ollama-local", "compatible-endpoint", "compatible-anthropic-endpoint"])(
    "keeps the %s proxy when sandbox deletion fails",
    async (provider) => {
      const harness = createDestroyHarness({
        provider,
        registryEntryOverrides: { credentialEnv: "NEMOCLAW_OLLAMA_PROXY_TOKEN" },
        registeredSandboxCount: 1,
        deleteStatus: 7,
        deleteOutput: "delete failed",
      });

      await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow(
        "process.exit(7)",
      );

      expect(harness.events).toContain("delete");
      expect(harness.killStaleProxySpy).not.toHaveBeenCalled();
      expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])(
    "stops the compatible proxy only after confirmed absence (initially present=%s)",
    async (sandboxPresent) => {
      const harness = createDestroyHarness({
        provider: "compatible-endpoint",
        registryEntryOverrides: { credentialEnv: "NEMOCLAW_OLLAMA_PROXY_TOKEN" },
        registeredSandboxCount: 1,
        sandboxPresent,
      });
      harness.killStaleProxySpy.mockImplementation(() => {
        expect(harness.finalizeMcpBridgesAfterSandboxDeleteSpy).toHaveBeenCalledOnce();
        expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
      });

      await harness.destroySandbox("alpha", { yes: true, cleanupGateway: false });

      expect(harness.killStaleProxySpy).toHaveBeenCalledOnce();
      expect(harness.removeSandboxSpy).toHaveBeenCalledWith("alpha");
    },
  );

  it("retains the registry when proxy cleanup fails and retries after confirmed absence", async () => {
    const harness = createDestroyHarness({
      provider: "compatible-endpoint",
      registryEntryOverrides: { credentialEnv: "NEMOCLAW_OLLAMA_PROXY_TOKEN" },
      registeredSandboxCount: 1,
    });
    harness.killStaleProxySpy.mockImplementationOnce(() => {
      throw new Error("proxy cleanup failed");
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow(
      "proxy cleanup failed",
    );
    expect(harness.removeSandboxSpy).not.toHaveBeenCalled();

    await harness.destroySandbox("alpha", { yes: true });
    expect(harness.killStaleProxySpy).toHaveBeenCalledTimes(2);
    expect(harness.events.filter((event) => event === "delete")).toHaveLength(1);
    expect(harness.removeSandboxSpy).toHaveBeenCalledWith("alpha");
  });

  it.each(["ollama-local", "compatible-endpoint", "compatible-anthropic-endpoint"])(
    "keeps shared host services after forced local cleanup of the final %s sandbox (#6046)",
    async (provider) => {
      // Gateway-unreachable delete failure + --force triggers forcedLocalCleanup:
      // the local record is removed but the gateway-side delete was never
      // confirmed, so the sandbox may still exist. Even as the only registered
      // sandbox, that must not tear down shared host services (CodeRabbit #6050).
      const harness = createDestroyHarness({
        deleteStatus: 1,
        deleteOutput: "error trying to connect: connection refused",
        registeredSandboxCount: 1,
        provider,
        registryEntryOverrides: { credentialEnv: "NEMOCLAW_OLLAMA_PROXY_TOKEN" },
      });

      await expect(harness.destroySandbox("alpha", { force: true })).resolves.toBeUndefined();

      // Local cleanup still proceeds...
      expect(harness.removeSandboxSpy).toHaveBeenCalledWith("alpha");
      // ...but shared host services are preserved on the unconfirmed delete.
      expect(harness.stopAllSpy).not.toHaveBeenCalled();
      expect(harness.cleanupGatewaySpy).not.toHaveBeenCalled();
      expect(harness.revokeHttpsPinRuntimeAdapterRouteSpy).not.toHaveBeenCalled();
      expect(harness.killStaleProxySpy).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
    },
  );
});
