// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

type DestroySandbox = typeof import("./destroy")["destroySandbox"];

const requireDist = createRequire(import.meta.url);
const destroyModulePath = "./destroy.js";

type DestroyHarness = {
  cleanupGatewaySpy: MockInstance;
  destroySandbox: DestroySandbox;
  killStaleProxySpy: MockInstance;
  logSpy: MockInstance;
  removeSandboxSpy: MockInstance;
  runOpenshellSpy: MockInstance;
  selectGatewaySpy: MockInstance;
  stopNimByNameSpy: MockInstance;
  unloadOllamaModelsSpy: MockInstance;
};

type DestroyHarnessOptions = {
  deleteStatus?: number;
  deleteOutput?: string;
};

const sandboxEntry = {
  name: "alpha",
  provider: "ollama-local",
  model: "nvidia/nemotron",
  imageTag: null,
  nimContainer: "alpha-nim",
  gatewayName: "nemoclaw-19080",
  gatewayPort: 19080,
};

function createDestroyHarness(options: DestroyHarnessOptions = {}): DestroyHarness {
  delete require.cache[requireDist.resolve(destroyModulePath)];

  const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);

  const resolve = requireDist("../../adapters/openshell/resolve.js");
  const runtime = requireDist("../../adapters/openshell/runtime.js");
  const destroyGateway = requireDist("./destroy-gateway.js");
  const sandboxProviderCleanup = requireDist("../../onboard/sandbox-provider-cleanup.js");
  const nim = requireDist("../../inference/nim.js");
  const ollamaProxy = requireDist("../../inference/ollama/proxy.js");
  const tunnelServices = requireDist("../../tunnel/services.js");
  const onboardSession = requireDist("../../state/onboard-session.js");
  const registry = requireDist("../../state/registry.js");
  const sandboxSession = requireDist("../../state/sandbox-session.js");
  const timerControl = requireDist("../../shields/timer-control.js");

  vi.spyOn(resolve, "resolveOpenshell").mockReturnValue("/usr/bin/openshell");
  vi.spyOn(sandboxSession, "getActiveSandboxSessions").mockReturnValue({
    detected: true,
    sessions: [{ pid: 1 }],
  });
  vi.spyOn(registry, "getSandbox").mockReturnValue(sandboxEntry);
  vi.spyOn(registry, "listSandboxes").mockReturnValue({ sandboxes: [] });
  const removeSandboxSpy = vi.spyOn(registry, "removeSandbox").mockReturnValue(true);
  vi.spyOn(onboardSession, "loadSession").mockReturnValue({ sandboxName: "alpha" });
  vi.spyOn(onboardSession, "updateSession").mockImplementation((mutator: unknown) => {
    const session = { sandboxName: "alpha" };
    if (typeof mutator === "function") (mutator as (value: typeof session) => void)(session);
    return session;
  });
  const runOpenshellSpy = vi.spyOn(runtime, "runOpenshell").mockImplementation((args: unknown) => {
    const argv = Array.isArray(args) ? args : [];
    if (argv[0] === "sandbox" && argv[1] === "delete") {
      return { status: options.deleteStatus ?? 0, stdout: options.deleteOutput ?? "", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  });
  vi.spyOn(runtime, "captureOpenshell").mockReturnValue({ status: 0, output: "" });
  const selectGatewaySpy = vi
    .spyOn(destroyGateway, "selectGatewayForSandboxDestroy")
    .mockImplementation(() => undefined);
  const cleanupGatewaySpy = vi
    .spyOn(destroyGateway, "cleanupGatewayAfterLastSandbox")
    .mockImplementation(() => undefined);
  vi.spyOn(sandboxProviderCleanup, "runSandboxProviderPreDeleteCleanup").mockReturnValue({
    failures: [],
  });
  vi.spyOn(sandboxProviderCleanup, "emitProviderDetachResidualHint").mockImplementation(
    () => undefined,
  );
  const stopNimByNameSpy = vi
    .spyOn(nim, "stopNimContainerByName")
    .mockImplementation(() => undefined);
  vi.spyOn(nim, "stopNimContainer").mockImplementation(() => undefined);
  const killStaleProxySpy = vi
    .spyOn(ollamaProxy, "killStaleProxy")
    .mockImplementation(() => undefined);
  const unloadOllamaModelsSpy = vi
    .spyOn(ollamaProxy, "unloadOllamaModels")
    .mockImplementation(() => undefined);
  vi.spyOn(tunnelServices, "stopAll").mockImplementation(() => undefined);
  vi.spyOn(timerControl, "killTimer").mockReturnValue({ warnings: [] });

  logSpy.mockClear();

  return {
    cleanupGatewaySpy,
    destroySandbox: requireDist(destroyModulePath).destroySandbox,
    killStaleProxySpy,
    logSpy,
    removeSandboxSpy,
    runOpenshellSpy,
    selectGatewaySpy,
    stopNimByNameSpy,
    unloadOllamaModelsSpy,
  };
}

describe("destroySandbox flow", () => {
  let exitSpy: MockInstance;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete require.cache[requireDist.resolve(destroyModulePath)];
  });

  it("selects the sandbox gateway, deletes live resources, cleans host state, and removes registry state", async () => {
    const harness = createDestroyHarness();

    await expect(
      harness.destroySandbox("alpha", { yes: true, cleanupGateway: true }),
    ).resolves.toBeUndefined();

    expect(harness.selectGatewaySpy).toHaveBeenCalledWith(
      "alpha",
      "nemoclaw-19080",
      harness.runOpenshellSpy,
    );
    expect(harness.stopNimByNameSpy).toHaveBeenCalledWith("alpha-nim");
    expect(harness.killStaleProxySpy).toHaveBeenCalledTimes(1);
    expect(harness.runOpenshellSpy).toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.objectContaining({ ignoreError: true }),
    );
    expect(harness.unloadOllamaModelsSpy).toHaveBeenCalledTimes(1);
    expect(harness.removeSandboxSpy).toHaveBeenCalledWith("alpha");
    expect(harness.cleanupGatewaySpy).toHaveBeenCalledWith(
      "nemoclaw-19080",
      harness.runOpenshellSpy,
    );
    expect(harness.logSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "Sandbox 'alpha' destroyed",
    );
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("stops before local cleanup when OpenShell fails to delete the live sandbox", async () => {
    const harness = createDestroyHarness({ deleteStatus: 7, deleteOutput: "delete failed" });

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow("process.exit(7)");

    expect(harness.runOpenshellSpy).toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.objectContaining({ ignoreError: true }),
    );
    expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
    expect(harness.cleanupGatewaySpy).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(7);
  });
});
