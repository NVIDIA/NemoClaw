// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { OpenShellSandboxObserver } from "../../adapters/openshell/sandbox-observer";
import {
  createDockerRuntimeProviderBundle,
  type DockerRuntimeProviderDependencies,
} from "../../onboard/runtime-provider/docker";
import { createRuntimeProviderBundleRegistry } from "../../onboard/runtime-provider/registry";
import type { SandboxEntry } from "../../state/registry";
import { type SandboxStartDeps, startSandbox } from "./start";

function sandbox(values: Partial<SandboxEntry> = {}): SandboxEntry {
  return { name: "my-sandbox", ...values };
}

function harness(overrides: Partial<SandboxStartDeps> = {}) {
  let storedSandbox = sandbox({ stopped: true });
  const order: string[] = [];
  const getSandbox = vi.fn<NonNullable<SandboxStartDeps["getSandbox"]>>(() => storedSandbox);
  const updateSandbox = vi.fn<NonNullable<SandboxStartDeps["updateSandbox"]>>((_name, updates) => {
    storedSandbox = { ...storedSandbox, ...updates };
    return true;
  });
  const captureSandboxLifecycle = vi.fn<
    DockerRuntimeProviderDependencies["captureSandboxLifecycle"]
  >(() => {
    order.push("openshell-start");
    return { status: 0, output: "started" };
  });
  const findLabeledSandboxContainers = vi.fn<
    DockerRuntimeProviderDependencies["findLabeledSandboxContainers"]
  >(() => [
    {
      name: "openshell-my-sandbox",
      status: "Exited (0) 2 hours ago",
      running: false,
    },
  ]);
  const hasPortableLifecycleReceipt = vi.fn<
    DockerRuntimeProviderDependencies["hasPortableLifecycleReceipt"]
  >(() => false);
  const recoverPortableSandbox = vi.fn<DockerRuntimeProviderDependencies["recoverPortableSandbox"]>(
    async () => ({ kind: "not-installed" }),
  );
  const recoverDockerDriverSandbox = vi.fn<DockerRuntimeProviderDependencies["recoverSandbox"]>(
    () => {
      order.push("openshell-start");
      return {
        recovered: true,
        via: "started-stopped-original",
        containerName: "openshell-my-sandbox",
      };
    },
  );
  const observer: OpenShellSandboxObserver = {
    listSandboxes: vi.fn(async () => {
      order.push("openshell-ready");
      return {
        ok: true as const,
        value: {
          sandboxes: [{ name: "my-sandbox", phase: "Ready", readiness: "ready" as const }],
        },
      };
    }),
  };
  const verifyGateway = vi.fn<NonNullable<SandboxStartDeps["verifyGateway"]>>(async () => {
    order.push("native-health");
  });
  const probeGatewayProcess = vi.fn<NonNullable<SandboxStartDeps["probeGatewayProcess"]>>(
    async () => true,
  );
  const log = vi.fn<(message: string) => void>();
  const runtimeProviders = createRuntimeProviderBundleRegistry([
    [
      "docker",
      createDockerRuntimeProviderBundle({
        captureSandboxLifecycle,
        findLabeledSandboxContainers,
        hasPortableLifecycleReceipt,
        isRuntimeDown: () => false,
        printRuntimeDownGuidance: () => {},
        recoverSandbox: recoverDockerDriverSandbox,
        recoverPortableSandbox,
        unpauseContainer: () => ({ status: 0 }),
      }),
    ],
  ]);
  const deps: SandboxStartDeps = {
    getSandbox,
    updateSandbox,
    runtimeProviders,
    observer,
    verifyGateway,
    probeGatewayProcess,
    log,
    withLifecycleLock: async (_sandboxName, operation) => operation(),
    ...overrides,
  };
  return {
    deps,
    findLabeledSandboxContainers,
    getSandbox,
    hasPortableLifecycleReceipt,
    log,
    observer,
    order,
    probeGatewayProcess,
    recoverDockerDriverSandbox,
    recoverPortableSandbox,
    updateSandbox,
    verifyGateway,
  };
}

describe("startSandbox native lifecycle", () => {
  it("waits for OpenShell readiness before observing native gateway health", async () => {
    const h = harness();

    await expect(startSandbox("my-sandbox", h.deps)).resolves.toEqual({
      exitCode: 0,
    });

    expect(h.order).toEqual(["openshell-start", "openshell-ready", "native-health"]);
    expect(h.updateSandbox).toHaveBeenCalledWith("my-sandbox", {
      stopped: false,
    });
  });

  it("reports the OpenShell-owned sandbox start", async () => {
    const h = harness();

    await startSandbox("my-sandbox", h.deps);

    expect(h.log.mock.calls.map(([line]) => line).join("\n")).toContain(
      "Sandbox 'my-sandbox' started through OpenShell",
    );
  });

  it("uses recorded portable authority without ambient container discovery", async () => {
    const h = harness();
    h.getSandbox.mockReturnValue(
      sandbox({
        agent: "hermes",
        gatewayName: "nemoclaw",
        lifecycleGeneration: "generation-alpha",
        lifecycleLiveIdentityFingerprint: "identity-alpha",
        openshellDriver: "docker",
      }),
    );
    h.hasPortableLifecycleReceipt.mockReturnValue(true);
    h.recoverPortableSandbox.mockImplementation(async () => {
      h.order.push("portable-start");
      return { kind: "recovered" };
    });

    await expect(startSandbox("my-sandbox", h.deps)).resolves.toEqual({
      exitCode: 0,
    });

    expect(h.recoverPortableSandbox).toHaveBeenCalledOnce();
    expect(h.findLabeledSandboxContainers).not.toHaveBeenCalled();
    expect(h.recoverDockerDriverSandbox).not.toHaveBeenCalled();
    expect(h.verifyGateway).toHaveBeenCalledWith("my-sandbox");
  });

  it("propagates native gateway health failure", async () => {
    const h = harness();
    h.verifyGateway.mockRejectedValue(new Error("native gateway unavailable"));

    await expect(startSandbox("my-sandbox", h.deps)).rejects.toThrow("native gateway unavailable");
  });

  it("pins the inference probe to the registered gateway after health", async () => {
    const probeInferenceInvocation = vi.fn(async () => ({ ok: true }) as const);
    const h = harness({ probeInferenceInvocation });
    h.getSandbox.mockReturnValue(
      sandbox({
        agent: "hermes",
        gatewayName: "nemoclaw-19080",
        provider: "ollama-local",
        model: "nemotron-3-nano:30b",
        preferredInferenceApi: "openai-completions",
      }),
    );

    await expect(startSandbox("my-sandbox", h.deps)).resolves.toEqual({
      exitCode: 0,
    });

    expect(probeInferenceInvocation).toHaveBeenCalledWith(
      {
        sandboxName: "my-sandbox",
        gatewayName: "nemoclaw-19080",
        provider: "ollama-local",
        model: "nemotron-3-nano:30b",
        preferredInferenceApi: "openai-completions",
      },
      {},
      95_000,
    );
    expect(probeInferenceInvocation.mock.invocationCallOrder[0]).toBeGreaterThan(
      h.verifyGateway.mock.invocationCallOrder[0],
    );
    expect(h.probeGatewayProcess).not.toHaveBeenCalled();
  });

  it("waits for the Hermes gateway process to settle before checking gateway health", async () => {
    const probeGatewayProcess = vi
      .fn<NonNullable<SandboxStartDeps["probeGatewayProcess"]>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const delayGatewayProcessProbe = vi.fn(async () => {});
    const h = harness({ probeGatewayProcess, delayGatewayProcessProbe });
    h.getSandbox.mockReturnValue(
      sandbox({ agent: "hermes", gatewayName: "nemoclaw-19080", stopped: true }),
    );

    await expect(startSandbox("my-sandbox", h.deps)).resolves.toEqual({
      exitCode: 0,
    });

    expect(probeGatewayProcess).toHaveBeenCalledTimes(3);
    expect(probeGatewayProcess).toHaveBeenCalledWith("my-sandbox", "nemoclaw-19080");
    expect(delayGatewayProcessProbe.mock.calls).toEqual([[2_000], [2_000]]);
    expect(h.verifyGateway.mock.invocationCallOrder[0]).toBeGreaterThan(
      probeGatewayProcess.mock.invocationCallOrder[2],
    );
  });

  it("returns nonzero when the Hermes gateway stays stopped", async () => {
    const probeGatewayProcess = vi.fn(async () => false);
    const delayGatewayProcessProbe = vi.fn(async () => {});
    const probeInferenceInvocation = vi.fn(async () => ({ ok: true }) as const);
    const h = harness({
      probeGatewayProcess,
      delayGatewayProcessProbe,
      probeInferenceInvocation,
    });
    h.getSandbox.mockReturnValue(
      sandbox({
        agent: "hermes",
        provider: "ollama-local",
        model: "nemotron-3-nano:30b",
        stopped: true,
      }),
    );

    await expect(startSandbox("my-sandbox", h.deps)).resolves.toEqual({
      exitCode: 1,
    });

    expect(probeGatewayProcess).toHaveBeenCalledTimes(3);
    expect(delayGatewayProcessProbe.mock.calls).toEqual([[2_000], [2_000]]);
    expect(h.verifyGateway).not.toHaveBeenCalled();
    expect(probeInferenceInvocation).not.toHaveBeenCalled();
  });

  it("passes an unavailable Hermes process observation to gateway verification", async () => {
    const probeGatewayProcess = vi.fn(async () => null);
    const delayGatewayProcessProbe = vi.fn(async () => {});
    const h = harness({ probeGatewayProcess, delayGatewayProcessProbe });
    h.getSandbox.mockReturnValue(sandbox({ agent: "hermes", stopped: true }));
    h.verifyGateway.mockRejectedValue(new Error("native gateway route unavailable"));

    await expect(startSandbox("my-sandbox", h.deps)).rejects.toThrow(
      "native gateway route unavailable",
    );

    expect(probeGatewayProcess).toHaveBeenCalledOnce();
    expect(delayGatewayProcessProbe).not.toHaveBeenCalled();
    expect(h.verifyGateway).toHaveBeenCalledOnce();
  });

  it("returns nonzero when the native gateway cannot serve an agent request", async () => {
    const probeInferenceInvocation = vi.fn(
      async () =>
        ({
          ok: false,
          detail: "sandbox inference invocation probe returned HTTP 401",
          httpStatus: 401,
        }) as const,
    );
    const h = harness({ probeInferenceInvocation });
    h.getSandbox.mockReturnValue(
      sandbox({ provider: "ollama-local", model: "nemotron-3-nano:30b" }),
    );

    await expect(startSandbox("my-sandbox", h.deps)).resolves.toEqual({
      exitCode: 1,
    });
    expect(h.log.mock.calls.map(([line]) => line).join("\n")).toContain("HTTP 401");
  });
});
