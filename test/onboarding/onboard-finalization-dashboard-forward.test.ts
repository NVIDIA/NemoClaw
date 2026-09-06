// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createOnboardDashboardHelpers } from "../../src/lib/onboard/dashboard";
import { withDashboardReuseLifecycle } from "../../src/lib/onboard/dashboard/reuse-lifecycle";
import type { ListSandboxesFn } from "../../src/lib/onboard/dashboard-port";
import { fingerprintSandboxLiveIdentity } from "../../src/lib/onboard/sandbox-recreate-transaction";

function harness(options: {
  listSandboxes: ListSandboxesFn;
  isPortBound?: (port: number) => boolean;
  registeredIdentity?: boolean;
  sandboxIdentity?: () => string;
  stopSandbox?: (sandboxName: string) => {
    exitCode: number;
    message?: string;
    stopped?: true;
  };
  startSandbox?: (sandboxName: string) => Promise<{ exitCode: number; message?: string }>;
}) {
  const launch = vi.fn();
  const stopSandbox = vi.fn((sandboxName: string, revalidateAtMutationEdge: () => void) => {
    revalidateAtMutationEdge();
    return (options.stopSandbox ?? (() => ({ exitCode: 0 })))(sandboxName);
  });
  const startSandboxOperation = vi.fn(options.startSandbox ?? (async () => ({ exitCode: 0 })));
  const startSandbox = vi.fn(async (sandboxName: string, revalidateAtMutationEdge: () => void) => {
    revalidateAtMutationEdge();
    return await startSandboxOperation(sandboxName);
  });
  const recordedIdentity = fingerprintSandboxLiveIdentity(
    `Id: ${options.sandboxIdentity?.() ?? "sandbox-id"}`,
  );
  const helpers = createOnboardDashboardHelpers({
    runOpenshell: vi.fn(() => ({ status: 0 })),
    runCaptureOpenshell: vi.fn((args) =>
      args[0] === "sandbox"
        ? `Name: reonboard-test\nId: ${options.sandboxIdentity?.() ?? "sandbox-id"}\nState: Ready\n`
        : "",
    ),
    openshellArgv: (args) => ["/usr/local/bin/openshell", ...args],
    cliName: () => "nemoclaw",
    agentProductName: () => "NemoClaw",
    getProviderLabel: (provider) => provider,
    note: vi.fn(),
    isWsl: () => false,
    redact: String,
    sleep: vi.fn(),
    printAgentDashboardUi: vi.fn(),
    listSandboxes: options.listSandboxes,
    getSandbox: () => ({
      gatewayName: "nemoclaw",
      dashboardPort: 18_790,
      lifecycleGeneration: "generation-1",
      lifecycleLiveIdentityFingerprint:
        options.registeredIdentity === false ? undefined : (recordedIdentity ?? undefined),
    }),
    isPortBoundOnHost: options.isPortBound ?? (() => false),
    stopSandboxForDashboardReuse: stopSandbox,
    startSandboxForDashboardReuse: startSandbox,
    withSandboxLifecycleLock: async (_sandboxName, operation) => await operation(),
    forwardService: {
      executable: () => "/usr/local/bin/openshell",
      launch,
      resolveGatewayName: () => "nemoclaw",
      retireLegacy: vi.fn(() => 0),
    },
  });
  const run = <T>(operation: () => Promise<T>): Promise<T> =>
    withDashboardReuseLifecycle(
      {
        startSandbox,
        stopSandbox,
        withSandboxLifecycleLock: async (_sandboxName, lockedOperation) => await lockedOperation(),
      },
      operation,
    );
  return { helpers, launch, run, startSandbox, startSandboxOperation, stopSandbox };
}

describe("finalization dashboard ForwardTcp launch", () => {
  it("launches the persisted dashboard port and publishes its URL", async () => {
    vi.stubEnv("CHAT_UI_URL", undefined);
    const { helpers, launch } = harness({
      listSandboxes: () => ({
        sandboxes: [{ name: "reonboard-test", dashboardPort: 18_790 }],
      }),
    });

    await expect(helpers.ensureFinalizationDashboardForward("reonboard-test")).resolves.toBe(
      18_790,
    );
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({
        gatewayName: "nemoclaw",
        sandboxName: "reonboard-test",
        localPort: 18_790,
        targetPort: 18_790,
      }),
    );
    expect(process.env.CHAT_UI_URL).toBe("http://127.0.0.1:18790");
  });

  it("fails closed when a foreign listener occupies the persisted port", async () => {
    vi.stubEnv("CHAT_UI_URL", undefined);
    const { helpers, launch, startSandbox, stopSandbox } = harness({
      listSandboxes: () => ({
        sandboxes: [{ name: "reonboard-test", dashboardPort: 18_790 }],
      }),
      isPortBound: (port) => port === 18_790,
    });

    await expect(helpers.ensureFinalizationDashboardForward("reonboard-test")).rejects.toThrow(
      /cannot be reallocated/u,
    );
    expect(launch).not.toHaveBeenCalled();
    expect(stopSandbox).not.toHaveBeenCalled();
    expect(startSandbox).not.toHaveBeenCalled();
  });

  it("restarts the reused sandbox and retains its registered dashboard port (#11074)", async () => {
    vi.stubEnv("CHAT_UI_URL", undefined);
    let bound = true;
    const { helpers, launch, run, startSandbox, stopSandbox } = harness({
      listSandboxes: () => ({
        sandboxes: [{ name: "reonboard-test", dashboardPort: 18_790 }],
      }),
      isPortBound: (port) => port === 18_790 && bound,
      stopSandbox: () => {
        bound = false;
        return { exitCode: 0 };
      },
      startSandbox: async () => {
        bound = true;
        return { exitCode: 0 };
      },
    });

    await expect(
      run(() => helpers.ensureFinalizationDashboardForward("reonboard-test", undefined, true)),
    ).resolves.toBe(18_790);
    expect(stopSandbox).toHaveBeenCalledWith("reonboard-test", expect.any(Function));
    expect(startSandbox).toHaveBeenCalledWith("reonboard-test", expect.any(Function));
    expect(launch).not.toHaveBeenCalled();
    expect(process.env.CHAT_UI_URL).toBe("http://127.0.0.1:18790");
  });

  it("does not reconcile a reused dashboard forward twice", async () => {
    vi.stubEnv("CHAT_UI_URL", undefined);
    let bound = true;
    const { helpers, run, startSandbox, stopSandbox } = harness({
      listSandboxes: () => ({
        sandboxes: [{ name: "reonboard-test", dashboardPort: 18_790 }],
      }),
      isPortBound: (port) => port === 18_790 && bound,
      stopSandbox: () => {
        bound = false;
        return { exitCode: 0 };
      },
      startSandbox: async () => {
        bound = true;
        return { exitCode: 0 };
      },
    });

    await run(async () => {
      await helpers.reconcileOpenClawDashboardForwardReuse(
        "reonboard-test",
        "http://127.0.0.1:18790",
      );
      await helpers.ensureFinalizationDashboardForward("reonboard-test", undefined, true);
    });

    expect(stopSandbox).toHaveBeenCalledOnce();
    expect(startSandbox).toHaveBeenCalledOnce();
  });

  it("does not trust reconciliation from an earlier onboarding transaction", async () => {
    vi.stubEnv("CHAT_UI_URL", undefined);
    let bound = true;
    let stopEffect = (): void => {
      bound = false;
    };
    const { helpers, run, startSandbox, stopSandbox } = harness({
      listSandboxes: () => ({
        sandboxes: [{ name: "reonboard-test", dashboardPort: 18_790 }],
      }),
      isPortBound: (port) => port === 18_790 && bound,
      stopSandbox: () => {
        stopEffect();
        return { exitCode: 0 };
      },
      startSandbox: async () => {
        bound = true;
        return { exitCode: 0 };
      },
    });

    await run(() =>
      helpers.reconcileOpenClawDashboardForwardReuse("reonboard-test", "http://127.0.0.1:18790"),
    );
    stopEffect = () => undefined;

    await expect(
      run(() => helpers.ensureFinalizationDashboardForward("reonboard-test", undefined, true)),
    ).rejects.toThrow(/remained occupied/u);
    expect(stopSandbox).toHaveBeenCalledTimes(2);
    expect(startSandbox).toHaveBeenCalledOnce();
  });

  it("rejects an ambiguous listener that remains after the reused sandbox stops", async () => {
    vi.stubEnv("CHAT_UI_URL", undefined);
    const { helpers, launch, run, startSandbox, stopSandbox } = harness({
      listSandboxes: () => ({
        sandboxes: [{ name: "reonboard-test", dashboardPort: 18_790 }],
      }),
      isPortBound: (port) => port === 18_790,
    });

    await expect(
      run(() => helpers.ensureFinalizationDashboardForward("reonboard-test", undefined, true)),
    ).rejects.toThrow(/remained occupied.*run 'nemoclaw reonboard-test start'/u);
    expect(stopSandbox).toHaveBeenCalledWith("reonboard-test", expect.any(Function));
    expect(startSandbox).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it("does not start a same-name replacement after the reused sandbox stops", async () => {
    vi.stubEnv("CHAT_UI_URL", undefined);
    let bound = true;
    let identity = "original-id";
    const { helpers, launch, startSandbox, startSandboxOperation, stopSandbox } = harness({
      listSandboxes: () => ({
        sandboxes: [{ name: "reonboard-test", dashboardPort: 18_790 }],
      }),
      isPortBound: (port) => port === 18_790 && bound,
      sandboxIdentity: () => identity,
      stopSandbox: () => {
        bound = false;
        identity = "replacement-id";
        return { exitCode: 0 };
      },
    });

    await expect(
      helpers.ensureFinalizationDashboardForward("reonboard-test", undefined, true),
    ).rejects.toThrow(/identity changed.*may remain stopped/u);
    expect(stopSandbox).toHaveBeenCalledWith("reonboard-test", expect.any(Function));
    expect(startSandbox).toHaveBeenCalledWith("reonboard-test", expect.any(Function));
    expect(startSandboxOperation).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it("does not restart a reused sandbox without a registered live identity", async () => {
    vi.stubEnv("CHAT_UI_URL", undefined);
    const { helpers, launch, run, startSandbox, stopSandbox } = harness({
      listSandboxes: () => ({
        sandboxes: [{ name: "reonboard-test", dashboardPort: 18_790 }],
      }),
      isPortBound: (port) => port === 18_790,
      registeredIdentity: false,
    });

    await expect(
      run(() => helpers.ensureFinalizationDashboardForward("reonboard-test", undefined, true)),
    ).rejects.toThrow(/Could not verify sandbox/u);
    expect(stopSandbox).not.toHaveBeenCalled();
    expect(startSandbox).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it("does not cache a failed sandbox restart as reconciled", async () => {
    vi.stubEnv("CHAT_UI_URL", undefined);
    let bound = true;
    const startOutcomes = [
      async () => ({ exitCode: 1, message: "restart failed" }),
      async () => {
        bound = true;
        return { exitCode: 0 };
      },
    ];
    const { helpers, launch, run, startSandbox, stopSandbox } = harness({
      listSandboxes: () => ({
        sandboxes: [{ name: "reonboard-test", dashboardPort: 18_790 }],
      }),
      isPortBound: (port) => port === 18_790 && bound,
      stopSandbox: () => {
        bound = false;
        return { exitCode: 0 };
      },
      startSandbox: async () => await startOutcomes.shift()!(),
    });

    await expect(
      run(() => helpers.ensureFinalizationDashboardForward("reonboard-test", undefined, true)),
    ).rejects.toThrow(/did not restore dashboard port.*restart failed/u);

    bound = true;
    await expect(
      run(() => helpers.ensureFinalizationDashboardForward("reonboard-test", undefined, true)),
    ).resolves.toBe(18_790);
    expect(stopSandbox).toHaveBeenCalledTimes(2);
    expect(startSandbox).toHaveBeenCalledTimes(2);
    expect(launch).not.toHaveBeenCalled();
  });

  it("restores a sandbox after its stop cleanup fails", async () => {
    vi.stubEnv("CHAT_UI_URL", undefined);
    let bound = true;
    const { helpers, launch, run, startSandbox, stopSandbox } = harness({
      listSandboxes: () => ({
        sandboxes: [{ name: "reonboard-test", dashboardPort: 18_790 }],
      }),
      isPortBound: (port) => port === 18_790 && bound,
      stopSandbox: () => {
        bound = false;
        return { exitCode: 1, message: "Ollama cleanup failed", stopped: true };
      },
      startSandbox: async () => {
        bound = true;
        return { exitCode: 0 };
      },
    });

    await expect(
      run(() => helpers.ensureFinalizationDashboardForward("reonboard-test", undefined, true)),
    ).rejects.toThrow(/was restored.*Ollama cleanup failed/u);
    expect(stopSandbox).toHaveBeenCalledOnce();
    expect(startSandbox).toHaveBeenCalledOnce();
    expect(launch).not.toHaveBeenCalled();
  });

  it("does not reuse a forward when another sandbox registers the same port", async () => {
    vi.stubEnv("CHAT_UI_URL", undefined);
    const { helpers, launch, stopSandbox } = harness({
      listSandboxes: () => ({
        sandboxes: [
          { name: "reonboard-test", dashboardPort: 18_790 },
          { name: "other", dashboardPort: 18_790 },
        ],
      }),
      isPortBound: (port) => port === 18_790,
    });

    await expect(
      helpers.ensureFinalizationDashboardForward("reonboard-test", undefined, true),
    ).rejects.toThrow(/cannot be reallocated/u);
    expect(stopSandbox).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it("enables lifecycle reconciliation only for OpenClaw agents", async () => {
    vi.stubEnv("CHAT_UI_URL", undefined);
    let bound = true;
    const openClaw = harness({
      listSandboxes: () => ({
        sandboxes: [{ name: "reonboard-test", dashboardPort: 18_790 }],
      }),
      isPortBound: (port) => port === 18_790 && bound,
      stopSandbox: () => {
        bound = false;
        return { exitCode: 0 };
      },
      startSandbox: async () => {
        bound = true;
        return { exitCode: 0 };
      },
    });

    await expect(
      openClaw.run(() =>
        openClaw.helpers.ensureFinalizationAgentDashboardForward(
          "reonboard-test",
          { name: "openclaw", forwardPort: 18_790 },
          undefined,
          undefined,
          true,
        ),
      ),
    ).resolves.toBe(18_790);

    const hermes = harness({
      listSandboxes: () => ({
        sandboxes: [{ name: "reonboard-test", dashboardPort: 18_790 }],
      }),
      isPortBound: (port) => port === 18_790,
    });

    await expect(
      hermes.helpers.ensureFinalizationAgentDashboardForward(
        "reonboard-test",
        { name: "hermes", forwardPort: 18_790 },
        undefined,
        undefined,
        true,
      ),
    ).rejects.toThrow(/cannot be reallocated/u);
    expect(hermes.stopSandbox).not.toHaveBeenCalled();
  });

  it("honors an explicit dashboard URL", async () => {
    vi.stubEnv("CHAT_UI_URL", "http://127.0.0.1:19001");
    const { helpers, launch } = harness({
      listSandboxes: () => ({ sandboxes: [] }),
    });

    await expect(helpers.ensureFinalizationDashboardForward("reonboard-test")).resolves.toBe(
      19_001,
    );
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ localPort: 19_001 }));
  });
});
