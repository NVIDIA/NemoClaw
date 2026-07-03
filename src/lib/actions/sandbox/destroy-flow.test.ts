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
  events: string[];
  killTimerSpy: MockInstance;
  killStaleProxySpy: MockInstance;
  logSpy: MockInstance;
  removeSandboxSpy: MockInstance;
  runOpenshellSpy: MockInstance;
  selectGatewaySpy: MockInstance;
  stopAllSpy: MockInstance;
  stopNimByNameSpy: MockInstance;
  unloadOllamaModelsSpy: MockInstance;
  shieldsUpSpy: MockInstance;
};

type DestroyHarnessOptions = {
  activeTimer?: boolean;
  deleteStatus?: number;
  deleteOutput?: string;
  registeredSandboxCount?: number;
  shieldsUpError?: Error;
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
  const events: string[] = [];

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
  const shields = requireDist("../../shields/index.js");
  const timerControl = requireDist("../../shields/timer-control.js");

  vi.spyOn(resolve, "resolveOpenshell").mockReturnValue("/usr/bin/openshell");
  vi.spyOn(sandboxSession, "getActiveSandboxSessions").mockReturnValue({
    detected: true,
    sessions: [{ pid: 1 }],
  });
  vi.spyOn(registry, "getSandbox").mockReturnValue(sandboxEntry);
  vi.spyOn(registry, "listSandboxes").mockReturnValue({
    sandboxes: Array.from({ length: options.registeredSandboxCount ?? 0 }, (_, i) => ({
      name: `sb-${i}`,
    })),
  });
  const removeSandboxSpy = vi.spyOn(registry, "removeSandbox").mockReturnValue(true);
  vi.spyOn(onboardSession, "loadSession").mockReturnValue({ sandboxName: "alpha" });
  vi.spyOn(onboardSession, "updateSession").mockImplementation((mutator: unknown) => {
    const session = { sandboxName: "alpha" };
    typeof mutator === "function" && (mutator as (value: typeof session) => void)(session);
    return session;
  });
  const runOpenshellSpy = vi.spyOn(runtime, "runOpenshell").mockImplementation((args: unknown) => {
    const argv = Array.isArray(args) ? args : [];
    switch (`${String(argv[0])} ${String(argv[1])}`) {
      case "sandbox exec":
        events.push("wipe");
        break;
      case "sandbox delete":
        events.push("delete");
        return {
          status: options.deleteStatus ?? 0,
          stdout: options.deleteOutput ?? "",
          stderr: "",
        };
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
  vi.spyOn(sandboxProviderCleanup, "runSandboxProviderPreDeleteCleanup").mockImplementation(() => {
    events.push("detach");
    return { failures: [] };
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
  const stopAllSpy = vi.spyOn(tunnelServices, "stopAll").mockImplementation(() => undefined);
  vi.spyOn(timerControl, "readTimerMarker").mockReturnValue(
    options.activeTimer
      ? {
          pid: 4242,
          sandboxName: "alpha",
          snapshotPath: "/tmp/policy.yaml",
          restoreAt: "2026-06-27T06:00:00.000Z",
          processToken: "a".repeat(32),
        }
      : null,
  );
  const shieldsUpSpy = vi.spyOn(shields, "shieldsUp").mockImplementation(() => {
    events.push("harden");
    const shieldsUpError = options.shieldsUpError;
    switch (shieldsUpError) {
      case undefined:
        break;
      default:
        throw shieldsUpError;
    }
  });
  const killTimerSpy = vi.spyOn(timerControl, "killTimer").mockImplementation(() => {
    events.push("timer-cleanup");
    return { warnings: [] };
  });

  logSpy.mockClear();

  return {
    cleanupGatewaySpy,
    destroySandbox: requireDist(destroyModulePath).destroySandbox,
    events,
    killTimerSpy,
    killStaleProxySpy,
    logSpy,
    removeSandboxSpy,
    runOpenshellSpy,
    selectGatewaySpy,
    stopAllSpy,
    stopNimByNameSpy,
    unloadOllamaModelsSpy,
    shieldsUpSpy,
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

  it("does not stop shared host services when --force cleans up the last sandbox with the gateway down (#6046)", async () => {
    // Gateway-unreachable delete failure + --force triggers forcedLocalCleanup:
    // the local record is removed but the gateway-side delete was never
    // confirmed, so the sandbox may still exist. Even as the only registered
    // sandbox, that must not tear down shared host services (CodeRabbit #6050).
    const harness = createDestroyHarness({
      deleteStatus: 1,
      deleteOutput: "error trying to connect: connection refused",
      registeredSandboxCount: 1,
    });

    await expect(harness.destroySandbox("alpha", { force: true })).resolves.toBeUndefined();

    // Local cleanup still proceeds...
    expect(harness.removeSandboxSpy).toHaveBeenCalledWith("alpha");
    // ...but shared host services are preserved on the unconfirmed delete.
    expect(harness.stopAllSpy).not.toHaveBeenCalled();
    expect(harness.cleanupGatewaySpy).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("wipes while mutable, hardens an active timer window, then deletes and clears it", async () => {
    const harness = createDestroyHarness({ activeTimer: true });

    await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();

    expect(harness.events).toEqual(
      expect.arrayContaining(["wipe", "harden", "detach", "delete", "timer-cleanup"]),
    );
    expect(harness.events.indexOf("wipe")).toBeLessThan(harness.events.indexOf("harden"));
    expect(harness.events.indexOf("harden")).toBeLessThan(harness.events.indexOf("delete"));
    expect(harness.events.indexOf("delete")).toBeLessThan(harness.events.indexOf("timer-cleanup"));
  });

  it("does not delete when active-window hardening fails after the wipe", async () => {
    const harness = createDestroyHarness({
      activeTimer: true,
      shieldsUpError: new Error("injected hardening failure"),
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow(
      "injected hardening failure",
    );

    expect(harness.events).toContain("wipe");
    expect(harness.events).toContain("harden");
    expect(harness.events).not.toContain("delete");
    expect(harness.killTimerSpy).not.toHaveBeenCalled();
  });
});
