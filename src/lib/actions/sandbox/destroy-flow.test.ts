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
  finalizeMcpBridgesAfterSandboxDeleteSpy: MockInstance;
  gatewayPinsAtMcpPrepare: Array<string | undefined>;
  gatewayPinsAtSandboxList: Array<string | undefined>;
  killTimerSpy: MockInstance;
  killStaleProxySpy: MockInstance;
  logSpy: MockInstance;
  prepareMcpBridgesForAbsentSandboxDestroySpy: MockInstance;
  prepareMcpBridgesForDestroySpy: MockInstance;
  removeSandboxSpy: MockInstance;
  restoreMcpBridgesAfterDestroyAbortSpy: MockInstance;
  runOpenshellSpy: MockInstance;
  selectGatewaySpy: MockInstance;
  shieldsDownSpy: MockInstance;
  stopNimByNameSpy: MockInstance;
  unloadOllamaModelsSpy: MockInstance;
};

type DestroyHarnessOptions = {
  activeTimer?: boolean;
  deleteStatus?: number;
  deleteOutput?: string;
  finalizeMcpError?: string;
  agent?: "openclaw" | "hermes";
  mcpAddState?: "prepared";
  mcpServers?: string[];
  restoreMcpError?: string;
  sandboxPresent?: boolean;
  shieldsDown?: boolean;
  shieldsUpError?: Error;
};

const sandboxEntry = {
  name: "alpha",
  agent: "openclaw",
  provider: "ollama-local",
  model: "nvidia/nemotron",
  imageTag: null,
  nimContainer: "alpha-nim",
  gatewayName: "nemoclaw-19080",
  gatewayPort: 19080,
};

function sandboxListJson(names: string[]): string {
  return JSON.stringify(
    names.map((name) => ({
      id: `sandbox-${name}`,
      name,
      labels: {},
      resource_version: 1,
      created_at: "2026-06-27 00:00:00",
      phase: "Ready",
      current_policy_version: 1,
    })),
  );
}

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
  const mcpBridge = requireDist("./mcp-bridge.js");

  vi.spyOn(resolve, "resolveOpenshell").mockReturnValue("/usr/bin/openshell");
  vi.spyOn(sandboxSession, "getActiveSandboxSessions").mockReturnValue({
    detected: true,
    sessions: [{ pid: 1 }],
  });
  vi.spyOn(registry, "getSandbox").mockReturnValue({
    ...sandboxEntry,
    agent: options.agent ?? sandboxEntry.agent,
    ...(options.mcpServers?.length
      ? {
          mcp: {
            bridges: Object.fromEntries(
              options.mcpServers.map((server) => [
                server,
                {
                  server,
                  ...(options.mcpAddState ? { addState: options.mcpAddState } : {}),
                },
              ]),
            ),
          },
        }
      : {}),
  });
  vi.spyOn(registry, "listSandboxes").mockReturnValue({ sandboxes: [] });
  const removeSandboxSpy = vi.spyOn(registry, "removeSandbox").mockReturnValue(true);
  vi.spyOn(onboardSession, "loadSession").mockReturnValue({
    sandboxName: "alpha",
  });
  vi.spyOn(onboardSession, "updateSession").mockImplementation((mutator: unknown) => {
    const session = { sandboxName: "alpha" };
    expect(typeof mutator).toBe("function");
    (mutator as (value: typeof session) => void)(session);
    return session;
  });
  const gatewayPinsAtSandboxList: Array<string | undefined> = [];
  const runOpenshellSpy = vi.spyOn(runtime, "runOpenshell").mockImplementation((args: unknown) => {
    const argv = Array.isArray(args) ? args : [];
    switch (`${String(argv[0])}:${String(argv[1])}`) {
      case "sandbox:exec":
        events.push("wipe");
        return { status: 0, stdout: "", stderr: "" };
      case "sandbox:list":
        gatewayPinsAtSandboxList.push(process.env.OPENSHELL_GATEWAY);
        return {
          status: 0,
          stdout: sandboxListJson(options.sandboxPresent === false ? [] : ["alpha"]),
          stderr: "",
        };
      case "sandbox:delete":
        events.push("delete");
        return {
          status: options.deleteStatus ?? 0,
          stdout: options.deleteOutput ?? "",
          stderr: "",
        };
      default:
        return { status: 0, stdout: "", stderr: "" };
    }
  });
  vi.spyOn(runtime, "captureOpenshell").mockReturnValue({
    status: 0,
    output: "",
  });
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
  vi.spyOn(tunnelServices, "stopAll").mockImplementation(() => undefined);
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
  vi.spyOn(shields, "shieldsUp").mockImplementation(() => {
    events.push("harden");
    options.shieldsUpError === undefined
      ? undefined
      : (() => {
          throw options.shieldsUpError;
        })();
  });
  vi.spyOn(shields, "isShieldsDown").mockReturnValue(options.shieldsDown ?? true);
  const shieldsDownSpy = vi.spyOn(shields, "shieldsDown").mockImplementation(() => {
    events.push("unlock");
  });
  const killTimerSpy = vi.spyOn(timerControl, "killTimer").mockImplementation(() => {
    events.push("timer-cleanup");
    return { warnings: [] };
  });
  const preparedServers = options.mcpAddState === "prepared" ? [] : (options.mcpServers ?? []);
  const mcpPreparation = {
    entries: preparedServers.map((server) => ({ server })),
    detachedProviderEntries: preparedServers.map((server) => ({
      server,
    })),
    scrubbedAdapterEntries: preparedServers.map((server) => ({
      server,
    })),
    destroyAlreadyPrepared: false,
    destroyAlreadyPending: false,
  };
  const gatewayPinsAtMcpPrepare: Array<string | undefined> = [];
  const prepareMcpBridgesForDestroySpy = vi
    .spyOn(mcpBridge, "prepareMcpBridgesForDestroy")
    .mockImplementation(async () => {
      gatewayPinsAtMcpPrepare.push(process.env.OPENSHELL_GATEWAY);
      return mcpPreparation;
    });
  const prepareMcpBridgesForAbsentSandboxDestroySpy = vi
    .spyOn(mcpBridge, "prepareMcpBridgesForAbsentSandboxDestroy")
    .mockImplementation(async () => {
      gatewayPinsAtMcpPrepare.push(process.env.OPENSHELL_GATEWAY);
      return mcpPreparation;
    });
  const restoreMcpBridgesAfterDestroyAbortSpy = vi
    .spyOn(mcpBridge, "restoreMcpBridgesAfterDestroyAbort")
    .mockImplementation(async () => {
      events.push("mcp-restore");
      return options.restoreMcpError === undefined
        ? undefined
        : Promise.reject(new Error(options.restoreMcpError));
    });
  const finalizeMcpBridgesAfterSandboxDeleteSpy = vi
    .spyOn(mcpBridge, "finalizeMcpBridgesAfterSandboxDelete")
    .mockImplementation(() =>
      options.finalizeMcpError
        ? Promise.reject(new Error(options.finalizeMcpError))
        : Promise.resolve(),
    );

  logSpy.mockClear();

  return {
    cleanupGatewaySpy,
    destroySandbox: requireDist(destroyModulePath).destroySandbox,
    events,
    finalizeMcpBridgesAfterSandboxDeleteSpy,
    gatewayPinsAtMcpPrepare,
    gatewayPinsAtSandboxList,
    killTimerSpy,
    killStaleProxySpy,
    logSpy,
    prepareMcpBridgesForAbsentSandboxDestroySpy,
    prepareMcpBridgesForDestroySpy,
    removeSandboxSpy,
    restoreMcpBridgesAfterDestroyAbortSpy,
    runOpenshellSpy,
    selectGatewaySpy,
    shieldsDownSpy,
    stopNimByNameSpy,
    unloadOllamaModelsSpy,
  };
}

describe("destroySandbox flow", () => {
  let exitSpy: MockInstance;
  let originalGatewayEnv: string | undefined;

  beforeEach(() => {
    originalGatewayEnv = process.env.OPENSHELL_GATEWAY;
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
  });

  afterEach(() => {
    originalGatewayEnv === undefined
      ? delete process.env.OPENSHELL_GATEWAY
      : (process.env.OPENSHELL_GATEWAY = originalGatewayEnv);
    vi.restoreAllMocks();
    delete require.cache[requireDist.resolve(destroyModulePath)];
  });

  it("trusts absence only from a successful, error-free sandbox list", { timeout: 15_000 }, () => {
    const { classifyDestroySandboxPresence } = requireDist(destroyModulePath) as {
      classifyDestroySandboxPresence: (
        sandboxName: string,
        result: { status: number | null; stdout?: string; stderr?: string },
      ) => string;
    };

    expect(
      classifyDestroySandboxPresence("alpha", {
        status: 0,
        stdout: sandboxListJson(["alpha"]),
      }),
    ).toBe("present");
    expect(
      classifyDestroySandboxPresence("alpha", {
        status: 0,
        stdout: sandboxListJson(["beta"]),
      }),
    ).toBe("absent");
    expect(
      classifyDestroySandboxPresence("alpha", {
        status: 1,
        stderr: "gateway unavailable",
      }),
    ).toBe("unknown");
    expect(
      classifyDestroySandboxPresence("alpha", {
        status: 0,
        stdout: "arbitrary warning text",
      }),
    ).toBe("unknown");
    expect(
      classifyDestroySandboxPresence("alpha", {
        status: 0,
        stdout: JSON.stringify([{ name: "beta" }]),
      }),
    ).toBe("unknown");
    expect(
      classifyDestroySandboxPresence("alpha", {
        status: 0,
        stdout: "",
      }),
    ).toBe("unknown");
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
    expect(harness.gatewayPinsAtSandboxList).toEqual(["nemoclaw-19080"]);
    expect(harness.runOpenshellSpy).toHaveBeenCalledWith(
      ["sandbox", "list", "-o", "json"],
      expect.objectContaining({ ignoreError: true }),
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
    const harness = createDestroyHarness({
      deleteStatus: 7,
      deleteOutput: "delete failed",
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow("process.exit(7)");

    expect(harness.runOpenshellSpy).toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.objectContaining({ ignoreError: true }),
    );
    expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
    expect(harness.cleanupGatewaySpy).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(7);
  });

  it("refuses shields-up Hermes MCP destroy before stopping services or preparing MCP state", async () => {
    const harness = createDestroyHarness({
      agent: "hermes",
      mcpServers: ["github"],
      shieldsDown: false,
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow(
      "has shields up or an unreadable shields posture",
    );

    expect(harness.stopNimByNameSpy).not.toHaveBeenCalled();
    expect(harness.killStaleProxySpy).not.toHaveBeenCalled();
    expect(harness.selectGatewaySpy).toHaveBeenCalledWith(
      "alpha",
      "nemoclaw-19080",
      harness.runOpenshellSpy,
    );
    expect(harness.prepareMcpBridgesForDestroySpy).not.toHaveBeenCalled();
    expect(harness.runOpenshellSpy).toHaveBeenCalledWith(
      ["sandbox", "list", "-o", "json"],
      expect.objectContaining({ ignoreError: true }),
    );
  });

  it("does not require mutable Hermes config for a prepared-only add", async () => {
    const harness = createDestroyHarness({
      agent: "hermes",
      mcpAddState: "prepared",
      mcpServers: ["github"],
      shieldsDown: false,
    });
    await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();
    expect(harness.prepareMcpBridgesForDestroySpy).toHaveBeenCalledWith("alpha");
  });

  it("does not require mutable Hermes config for absent-sandbox cleanup", async () => {
    const harness = createDestroyHarness({
      agent: "hermes",
      mcpServers: ["github"],
      sandboxPresent: false,
      shieldsDown: false,
    });
    await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();
    expect(harness.prepareMcpBridgesForAbsentSandboxDestroySpy).toHaveBeenCalledWith("alpha", {
      force: false,
    });
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

  it("detaches MCP providers before delete and finalizes them only after delete succeeds", async () => {
    const harness = createDestroyHarness({ mcpServers: ["github", "slack"] });

    await harness.destroySandbox("alpha", { yes: true });

    expect(harness.prepareMcpBridgesForDestroySpy).toHaveBeenCalledWith("alpha");
    expect(harness.gatewayPinsAtMcpPrepare).toEqual(["nemoclaw-19080"]);
    const deleteCall = harness.runOpenshellSpy.mock.calls.findIndex(
      (call) => Array.isArray(call[0]) && call[0].join(" ") === "sandbox delete alpha",
    );
    expect(deleteCall).toBeGreaterThanOrEqual(0);
    expect(harness.prepareMcpBridgesForDestroySpy.mock.invocationCallOrder.at(-1)).toBeLessThan(
      harness.runOpenshellSpy.mock.invocationCallOrder[deleteCall],
    );
    expect(
      harness.finalizeMcpBridgesAfterSandboxDeleteSpy.mock.invocationCallOrder.at(-1),
    ).toBeGreaterThan(harness.runOpenshellSpy.mock.invocationCallOrder[deleteCall]);
    expect(harness.finalizeMcpBridgesAfterSandboxDeleteSpy).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({
        entries: [{ server: "github" }, { server: "slack" }],
      }),
      { force: false },
    );
    expect(harness.restoreMcpBridgesAfterDestroyAbortSpy).not.toHaveBeenCalled();
  });

  it("restores MCP runtime state when sandbox delete fails", async () => {
    const harness = createDestroyHarness({
      activeTimer: true,
      deleteStatus: 7,
      deleteOutput: "delete failed",
      mcpServers: ["github"],
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow("process.exit(7)");

    expect(harness.restoreMcpBridgesAfterDestroyAbortSpy).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ entries: [{ server: "github" }] }),
    );
    expect(harness.finalizeMcpBridgesAfterSandboxDeleteSpy).not.toHaveBeenCalled();
    expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
    expect(harness.events.filter((event) => event === "harden")).toHaveLength(2);
    expect(harness.events.indexOf("delete")).toBeLessThan(harness.events.indexOf("unlock"));
    expect(harness.events.indexOf("unlock")).toBeLessThan(harness.events.indexOf("mcp-restore"));
    expect(harness.events.indexOf("mcp-restore")).toBeLessThan(
      harness.events.lastIndexOf("harden"),
    );
    expect(harness.shieldsDownSpy).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({
        timeout: "15m",
        deferAutoRestoreWhileOwnerAlive: true,
        processToken: "a".repeat(32),
        throwOnError: true,
      }),
    );
    expect(harness.shieldsDownSpy.mock.calls[0]?.[1]).not.toHaveProperty("skipTimer");
  });

  it("relocks shields and preserves destroy failure when MCP rollback fails", async () => {
    const harness = createDestroyHarness({
      activeTimer: true,
      deleteStatus: 7,
      deleteOutput: "delete failed",
      mcpServers: ["github"],
      restoreMcpError: "injected MCP restore failure",
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow("process.exit(7)");

    expect(harness.events.filter((event) => event === "harden")).toHaveLength(2);
    expect(harness.events.indexOf("mcp-restore")).toBeLessThan(
      harness.events.lastIndexOf("harden"),
    );
    expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
  });

  it("preserves the registry when post-delete MCP cleanup fails, even with force", async () => {
    const harness = createDestroyHarness({
      finalizeMcpError: "provider delete failed",
      mcpServers: ["github"],
    });

    await expect(harness.destroySandbox("alpha", { yes: true, force: true })).rejects.toThrow(
      "provider delete failed",
    );

    expect(harness.finalizeMcpBridgesAfterSandboxDeleteSpy).toHaveBeenCalledWith(
      "alpha",
      expect.any(Object),
      { force: true },
    );
    expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
    expect(harness.cleanupGatewaySpy).not.toHaveBeenCalled();
  });

  it("finalizes exact MCP providers when the sandbox was already externally removed", async () => {
    const harness = createDestroyHarness({
      deleteStatus: 1,
      deleteOutput: "Error: sandbox alpha not found",
      mcpServers: ["github"],
      sandboxPresent: false,
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();

    expect(harness.prepareMcpBridgesForDestroySpy).not.toHaveBeenCalled();
    expect(harness.prepareMcpBridgesForAbsentSandboxDestroySpy).toHaveBeenCalledWith("alpha", {
      force: false,
    });
    expect(harness.gatewayPinsAtMcpPrepare).toEqual(["nemoclaw-19080"]);
    expect(harness.restoreMcpBridgesAfterDestroyAbortSpy).not.toHaveBeenCalled();
    expect(harness.finalizeMcpBridgesAfterSandboxDeleteSpy).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ entries: [{ server: "github" }] }),
      { force: false },
    );
    expect(harness.removeSandboxSpy).toHaveBeenCalledWith("alpha");
  });
});
