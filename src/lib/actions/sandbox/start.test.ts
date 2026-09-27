// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as sandboxCommandCli from "../../adapters/openshell/sandbox-command-cli";
import type { OpenShellSandboxBufferedCommandRequest } from "../../adapters/openshell/sandbox-command";
import { fingerprintOpenShellSandboxId } from "../../adapters/openshell/sandbox-identity";
import type { OpenShellSandboxObserver } from "../../adapters/openshell/sandbox-observer";
import { createDockerRuntimeProviderBundle } from "../../onboard/runtime-provider/docker";
import { createPodmanRuntimeProviderBundle } from "../../onboard/runtime-provider/podman";
import { createRuntimeProviderBundleRegistry } from "../../onboard/runtime-provider/registry";
import type { SandboxEntry } from "../../state/registry";
import * as registry from "../../state/registry";
import { type SandboxStartDeps, startSandbox } from "./start";

afterEach(() => {
  vi.restoreAllMocks();
});

function sandbox(values: Partial<SandboxEntry> = {}): SandboxEntry {
  return {
    name: "my-sandbox",
    lifecycleLiveIdentityFingerprint: fingerprintOpenShellSandboxId("sandbox-alpha")!,
    ...values,
  };
}

function harness(overrides: Partial<SandboxStartDeps> = {}) {
  let storedSandbox = sandbox({ stopped: true });
  const order: string[] = [];
  const getSandbox = vi.fn<NonNullable<SandboxStartDeps["getSandbox"]>>(() => storedSandbox);
  const updateSandbox = vi.fn<NonNullable<SandboxStartDeps["updateSandbox"]>>((_name, updates) => {
    storedSandbox = { ...storedSandbox, ...updates };
    return true;
  });
  const startOpenShellSandbox = vi.fn(async () => {
    order.push("openshell-start");
    return { kind: "accepted" as const };
  });
  const openShellLifecycle = {
    startSandbox: startOpenShellSandbox,
    stopSandbox: vi.fn(async () => ({ kind: "accepted" as const })),
  };
  const recoverPortableSandbox = vi.fn<NonNullable<SandboxStartDeps["recoverPortableSandbox"]>>(
    async () => ({ kind: "not-installed" }),
  );
  const qualifyLegacyPortableProfile = vi.fn<
    NonNullable<SandboxStartDeps["qualifyLegacyPortableProfile"]>
  >(() => false);
  const requalifyPortableSandbox = vi.fn<NonNullable<SandboxStartDeps["requalifyPortableSandbox"]>>(
    async () => ({ kind: "not-hermes" }),
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
    ["docker", createDockerRuntimeProviderBundle()],
  ]);
  let elapsedMs = 0;
  const delayGatewayProcessProbe = vi.fn(async (ms: number) => {
    elapsedMs += ms;
  });
  const deps: SandboxStartDeps = {
    environment: {},
    now: () => elapsedMs,
    delayGatewayProcessProbe,
    getSandbox,
    openShellLifecycle,
    qualifyLegacyPortableProfile,
    recoverPortableSandbox,
    requalifyPortableSandbox,
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
    getSandbox,
    log,
    observer,
    order,
    probeGatewayProcess,
    qualifyLegacyPortableProfile,
    recoverPortableSandbox,
    startOpenShellSandbox,
    updateSandbox,
    verifyGateway,
  };
}

function providerRegistry(providerId: "docker" | "podman") {
  const engine = (operation: "host-doctor" | "sandbox-lifecycle") => ({
    operation,
    engineId: "podman",
    displayName: "Podman",
    authorityId: "podman:test",
    endpointAuthorityId: "podman:test",
    capture: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
    captureHost: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
  });
  const providers = {
    docker: () =>
      createRuntimeProviderBundleRegistry([["docker", createDockerRuntimeProviderBundle()]]),
    podman: () =>
      createRuntimeProviderBundleRegistry([
        [
          "podman",
          createPodmanRuntimeProviderBundle({
            engines: {
              hostDoctor: engine("host-doctor") as never,
              sandboxLifecycle: engine("sandbox-lifecycle") as never,
            },
          }),
        ],
      ]),
  };
  return providers[providerId]();
}

describe("startSandbox native lifecycle", () => {
  it("starts a sandbox from its sibling gateway registry and clears stop intent there", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-start-cross-root-"));
    const registryDir = path.join(home, ".nemoclaw", "gateways", "8245");
    const registryFile = path.join(registryDir, "sandboxes.json");
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      registryFile,
      JSON.stringify({
        defaultSandbox: "my-sandbox",
        defaultSelectionRevision: 1,
        sandboxes: {
          "my-sandbox": {
            name: "my-sandbox",
            gatewayName: "nemoclaw-8245",
            gatewayPort: 8245,
            lifecycleLiveIdentityFingerprint: fingerprintOpenShellSandboxId("sandbox-alpha"),
            openshellDriver: "docker",
            stopped: true,
          },
        },
      }),
    );
    vi.stubEnv("HOME", home);
    try {
      const h = harness();
      const { getSandbox: _getSandbox, updateSandbox: _updateSandbox, ...deps } = h.deps;

      await expect(startSandbox("my-sandbox", deps)).resolves.toEqual({ exitCode: 0 });

      expect(
        JSON.parse(fs.readFileSync(registryFile, "utf8")).sandboxes["my-sandbox"],
      ).toMatchObject({ gatewayPort: 8245, stopped: false });
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.each(["docker", "podman"] as const)(
    "dispatches standard %s lifecycle through the shared OpenShell adapter",
    async (providerId) => {
      const h = harness({ runtimeProviders: providerRegistry(providerId) });
      h.getSandbox.mockReturnValue(sandbox({ openshellDriver: providerId }));

      await expect(startSandbox("my-sandbox", h.deps)).resolves.toEqual({ exitCode: 0 });

      expect(h.startOpenShellSandbox).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          sandboxName: "my-sandbox",
          sandboxIdentityFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
        }),
      );
    },
  );

  it("derives the canonical gateway name from a persisted non-default port", async () => {
    const h = harness();
    h.getSandbox.mockReturnValue(
      sandbox({ gatewayName: undefined, gatewayPort: 18080, openshellDriver: "docker" }),
    );

    await expect(startSandbox("my-sandbox", h.deps)).resolves.toEqual({ exitCode: 0 });

    expect(h.startOpenShellSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: "named", gatewayName: "nemoclaw-18080" },
      }),
    );
  });

  it("waits for OpenShell readiness before observing native gateway health", async () => {
    const h = harness();
    h.getSandbox.mockReturnValue(
      sandbox({ lifecycleGeneration: "standard-generation", stopped: true }),
    );

    await expect(startSandbox("my-sandbox", h.deps)).resolves.toEqual({
      exitCode: 0,
    });

    expect(h.order).toEqual(["openshell-start", "openshell-ready", "native-health"]);
    expect(h.recoverPortableSandbox).not.toHaveBeenCalled();
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

  it("uses recorded portable authority without standard OpenShell lifecycle dispatch", async () => {
    const h = harness();
    h.getSandbox.mockReturnValue(
      sandbox({
        agent: "hermes",
        gatewayName: "nemoclaw",
        lifecycleGeneration: "generation-alpha",
        lifecycleLiveIdentityFingerprint: "identity-alpha",
        openshellDriver: "docker",
        portableLifecycleProfile: "hermes",
      }),
    );
    h.recoverPortableSandbox.mockImplementation(async () => {
      h.order.push("portable-start");
      return { kind: "recovered" };
    });

    await expect(startSandbox("my-sandbox", h.deps)).resolves.toEqual({
      exitCode: 0,
    });

    expect(h.recoverPortableSandbox).toHaveBeenCalledOnce();
    expect(h.startOpenShellSandbox).not.toHaveBeenCalled();
    expect(h.verifyGateway).toHaveBeenCalledWith("my-sandbox");
  });

  it("admits only a receipt-qualified legacy Hermes portable profile", async () => {
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
    h.qualifyLegacyPortableProfile.mockReturnValue(true);
    h.recoverPortableSandbox.mockResolvedValue({ kind: "recovered" });

    await expect(startSandbox("my-sandbox", h.deps)).resolves.toEqual({ exitCode: 0 });

    expect(h.recoverPortableSandbox).toHaveBeenCalledOnce();
    expect(h.startOpenShellSandbox).not.toHaveBeenCalled();
  });

  it("keeps unqualified Docker Hermes state on the standard OpenShell path", async () => {
    const h = harness();
    h.getSandbox.mockReturnValue(
      sandbox({
        agent: "hermes",
        gatewayName: "nemoclaw",
        lifecycleGeneration: "standard-generation",
        openshellDriver: "docker",
      }),
    );

    await expect(startSandbox("my-sandbox", h.deps)).resolves.toEqual({ exitCode: 0 });

    expect(h.qualifyLegacyPortableProfile).toHaveBeenCalledOnce();
    expect(h.recoverPortableSandbox).not.toHaveBeenCalled();
    expect(h.startOpenShellSandbox).toHaveBeenCalledOnce();
    expect(h.updateSandbox).not.toHaveBeenCalledWith("my-sandbox", {
      portableLifecycleProfile: "hermes",
    });
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
    expect(h.verifyGateway).toHaveBeenCalledExactlyOnceWith("my-sandbox");
    expect(h.verifyGateway.mock.invocationCallOrder[0]).toBeGreaterThan(
      probeGatewayProcess.mock.invocationCallOrder[2],
    );
  });

  it.each(["RUNNING", "UNAVAILABLE"])(
    "observes Hermes startup health outcome %s",
    async (health) => {
      const requests: OpenShellSandboxBufferedCommandRequest[] = [];
      const runBuffered = vi.fn(async (request: OpenShellSandboxBufferedCommandRequest) => {
        requests.push(request);
        return {
          outcome: { kind: "completed" as const, exitCode: 0 },
          stdout: `__NEMOCLAW_SANDBOX_EXEC_STARTED__\n${health}\n`,
          stderr: "",
        };
      });
      vi.spyOn(sandboxCommandCli, "createCliOpenShellSandboxCommandExecutor").mockReturnValue({
        probeDirectory: vi.fn(async () => ({ state: "present" as const })),
        runBuffered,
        runStreaming: vi.fn(async () => ({
          outcome: { kind: "completed" as const, exitCode: 0 },
          release: () => undefined,
        })),
      });
      vi.spyOn(registry, "getSandbox").mockReturnValue(
        sandbox({ agent: "hermes", gatewayName: "nemoclaw-19080", stopped: true }),
      );
      const h = harness({ probeGatewayProcess: undefined });
      h.getSandbox.mockReturnValue(
        sandbox({ agent: "hermes", gatewayName: "nemoclaw-19080", stopped: true }),
      );

      await expect(startSandbox("my-sandbox", h.deps)).resolves.toEqual({
        exitCode: health === "RUNNING" ? 0 : 1,
      });

      expect(requests).toHaveLength(health === "RUNNING" ? 1 : 6);
      expect(h.verifyGateway).toHaveBeenCalledTimes(health === "RUNNING" ? 1 : 0);
      expect(requests[0]).toEqual(
        expect.objectContaining({
          sandboxName: "my-sandbox",
          target: { kind: "named", gatewayName: "nemoclaw-19080" },
          command: expect.arrayContaining(["sh", "-c", expect.stringContaining("/health")]),
        }),
      );
      expect(requests[0]?.command.join(" ")).not.toContain(
        "/usr/local/bin/nemoclaw-gateway-control",
      );
    },
  );

  it.each(["openclaw", undefined])(
    "waits for the stopped %s gateway HTTP listener before repairing forwards",
    async (agent) => {
      const probeGatewayProcess = vi
        .fn(async () => true)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false);
      const delayGatewayProcessProbe = vi.fn(async () => {});
      const h = harness({ probeGatewayProcess, delayGatewayProcessProbe });
      h.getSandbox.mockReturnValue(
        sandbox({ agent, gatewayName: "nemoclaw-19080", stopped: true }),
      );

      await expect(startSandbox("my-sandbox", h.deps)).resolves.toEqual({ exitCode: 0 });
      expect(probeGatewayProcess).toHaveBeenCalledTimes(4);
      expect(probeGatewayProcess).toHaveBeenCalledWith("my-sandbox", "nemoclaw-19080", {
        startup: { timeoutMs: 15_000 },
      });
      expect(delayGatewayProcessProbe.mock.calls).toEqual([[2_000], [2_000], [2_000]]);
      expect(h.verifyGateway.mock.invocationCallOrder[0]).toBeGreaterThan(
        probeGatewayProcess.mock.invocationCallOrder[3],
      );
    },
  );

  it.each([
    [undefined, 30_000],
    ["", 30_000],
    ["-1", 30_000],
    ["Infinity", 30_000],
    ["invalid", 30_000],
    ["0", 0],
    ["0.25", 250],
    ["4", 4_000],
  ] as const)("bounds stopped OpenClaw startup with recovery timeout %s", async (value, budget) => {
    let elapsed = 0;
    const probeGatewayProcess = vi.fn(async () => false);
    const delayGatewayProcessProbe = vi.fn(async (ms: number) => {
      elapsed += ms;
    });
    const h = harness({
      probeGatewayProcess,
      delayGatewayProcessProbe,
      now: () => elapsed,
      environment: { NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS: value },
    });
    await expect(startSandbox("my-sandbox", h.deps)).resolves.toEqual({ exitCode: 1 });
    expect(elapsed).toBe(budget);
    expect(probeGatewayProcess).toHaveBeenCalledTimes(Math.ceil(budget / 2_000));
    expect(h.verifyGateway).not.toHaveBeenCalled();
  });

  it("uses a bounded shared override for a large finite startup setting", async () => {
    const h = harness({ environment: { NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS: "1e300" } });
    await expect(startSandbox("my-sandbox", h.deps)).resolves.toEqual({ exitCode: 0 });
    expect(h.probeGatewayProcess).toHaveBeenCalledWith("my-sandbox", "nemoclaw", {
      startup: { timeoutMs: 15_000 },
    });
  });

  it("charges slow probes and sleep to one deadline and passes only the remaining time", async () => {
    let elapsed = 0;
    const budgets: number[] = [];
    const probeGatewayProcess = vi.fn<NonNullable<SandboxStartDeps["probeGatewayProcess"]>>(
      async (_name, _gateway, options) => {
        const remaining = options?.startup?.timeoutMs ?? 0;
        budgets.push(remaining);
        elapsed += Math.min(700, remaining);
        return false;
      },
    );
    const h = harness({
      probeGatewayProcess,
      now: () => elapsed,
      delayGatewayProcessProbe: async (ms) => {
        elapsed += ms;
      },
      environment: { NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS: "3" },
    });
    await expect(startSandbox("my-sandbox", h.deps)).resolves.toEqual({ exitCode: 1 });
    expect(elapsed).toBe(3_000);
    expect(budgets).toEqual([3_000, 300]);
    expect(h.verifyGateway).not.toHaveBeenCalled();
  });

  it("rejects a positive observation that arrives after the startup deadline", async () => {
    let elapsed = 0;
    const h = harness({
      probeGatewayProcess: async () => {
        elapsed = 1_001;
        return true;
      },
      now: () => elapsed,
      environment: { NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS: "1" },
    });
    await expect(startSandbox("my-sandbox", h.deps)).resolves.toEqual({ exitCode: 1 });
    expect(h.verifyGateway).not.toHaveBeenCalled();
  });

  it("repeats stopped OpenClaw settlement after a timed-out start retry", async () => {
    const probeGatewayProcess = vi
      .fn<NonNullable<SandboxStartDeps["probeGatewayProcess"]>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const h = harness({
      probeGatewayProcess,
      environment: { NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS: "0.001" },
    });
    h.getSandbox.mockReturnValue(sandbox({ agent: "openclaw", stopped: true }));

    await expect(startSandbox("my-sandbox", h.deps)).resolves.toEqual({ exitCode: 1 });
    expect(h.updateSandbox).not.toHaveBeenCalled();
    expect(h.verifyGateway).not.toHaveBeenCalled();

    await expect(startSandbox("my-sandbox", h.deps)).resolves.toEqual({ exitCode: 0 });
    expect(probeGatewayProcess).toHaveBeenCalledTimes(2);
    expect(h.verifyGateway).toHaveBeenCalledOnce();
    expect(h.verifyGateway.mock.invocationCallOrder[0]).toBeGreaterThan(
      probeGatewayProcess.mock.invocationCallOrder[1],
    );
    expect(h.updateSandbox.mock.invocationCallOrder[0]).toBeGreaterThan(
      h.verifyGateway.mock.invocationCallOrder[0],
    );
    expect(h.updateSandbox).toHaveBeenCalledWith("my-sandbox", { stopped: false });
  });

  it.each(["openclaw", undefined])(
    "does not wait for %s when the sandbox was already running",
    async (agent) => {
      const h = harness();
      h.getSandbox.mockReturnValue(sandbox({ agent, stopped: false }));
      await expect(startSandbox("my-sandbox", h.deps)).resolves.toEqual({ exitCode: 0 });
      expect(h.probeGatewayProcess).not.toHaveBeenCalled();
    },
  );

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

    expect(probeGatewayProcess).toHaveBeenCalledTimes(6);
    expect(delayGatewayProcessProbe.mock.calls).toEqual([
      [2_000],
      [2_000],
      [2_000],
      [2_000],
      [2_000],
    ]);
    expect(h.verifyGateway).not.toHaveBeenCalled();
    expect(probeInferenceInvocation).not.toHaveBeenCalled();
  });

  it("settles a transient unavailable Hermes observation before gateway verification", async () => {
    const probeGatewayProcess = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(true);
    const delayGatewayProcessProbe = vi.fn(async () => {});
    const h = harness({ probeGatewayProcess, delayGatewayProcessProbe });
    h.getSandbox.mockReturnValue(sandbox({ agent: "hermes", stopped: true }));

    await expect(startSandbox("my-sandbox", h.deps)).resolves.toEqual({ exitCode: 0 });

    expect(probeGatewayProcess).toHaveBeenCalledTimes(2);
    expect(delayGatewayProcessProbe).toHaveBeenCalledOnce();
    expect(h.verifyGateway).toHaveBeenCalledOnce();
  });

  it("fails closed after persistently unavailable Hermes observations", async () => {
    const probeGatewayProcess = vi.fn(async () => null);
    const delayGatewayProcessProbe = vi.fn(async () => {});
    const h = harness({ probeGatewayProcess, delayGatewayProcessProbe });
    h.getSandbox.mockReturnValue(sandbox({ agent: "hermes", stopped: true }));

    await expect(startSandbox("my-sandbox", h.deps)).resolves.toEqual({ exitCode: 1 });

    expect(probeGatewayProcess).toHaveBeenCalledTimes(6);
    expect(delayGatewayProcessProbe.mock.calls).toEqual([
      [2_000],
      [2_000],
      [2_000],
      [2_000],
      [2_000],
    ]);
    expect(h.verifyGateway).not.toHaveBeenCalled();
  });

  it("passes an unavailable OpenClaw observation to gateway verification", async () => {
    const probeGatewayProcess = vi.fn(async () => null);
    const delayGatewayProcessProbe = vi.fn(async () => {});
    const h = harness({ probeGatewayProcess, delayGatewayProcessProbe });
    h.getSandbox.mockReturnValue(sandbox({ agent: "openclaw", stopped: true }));
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
    expect(probeInferenceInvocation).toHaveBeenCalledOnce();
  });

  it("retries a transient HTTP 503 while a restarted inference route settles", async () => {
    const probeInferenceInvocation = vi
      .fn<NonNullable<SandboxStartDeps["probeInferenceInvocation"]>>()
      .mockResolvedValueOnce({
        ok: false,
        detail: "sandbox inference invocation probe returned HTTP 503",
        httpStatus: 503,
      })
      .mockResolvedValueOnce({ ok: true });
    const delayInferenceInvocationProbe = vi.fn(async () => {});
    const h = harness({ delayInferenceInvocationProbe, probeInferenceInvocation });
    h.getSandbox.mockReturnValue(
      sandbox({
        agent: "pi",
        provider: "nvidia-prod",
        model: "nvidia/nemotron-3-super-120b-a12b",
      }),
    );

    await expect(startSandbox("my-sandbox", h.deps)).resolves.toEqual({ exitCode: 0 });
    expect(probeInferenceInvocation).toHaveBeenCalledTimes(2);
    expect(delayInferenceInvocationProbe).toHaveBeenCalledExactlyOnceWith(2_000);
    expect(h.log.mock.calls.map(([line]) => line).join("\n")).toContain("HTTP 503");
  });

  it("settles a transient inference HTTP 503 after native startup", async () => {
    const probeInferenceInvocation = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false as const,
        detail: "sandbox inference invocation probe returned HTTP 503",
        httpStatus: 503,
      })
      .mockResolvedValueOnce({ ok: true as const });
    const delayInferenceInvocationProbe = vi.fn(async () => {});
    const h = harness({ probeInferenceInvocation, delayInferenceInvocationProbe });
    h.getSandbox.mockReturnValue(
      sandbox({
        agent: "hermes",
        provider: "nvidia",
        model: "nvidia/nemotron-3-super-120b-a12b",
      }),
    );

    await expect(startSandbox("my-sandbox", h.deps)).resolves.toEqual({ exitCode: 0 });

    expect(probeInferenceInvocation).toHaveBeenCalledTimes(2);
    expect(delayInferenceInvocationProbe).toHaveBeenCalledWith(2_000);
  });

  it("fails closed after the bounded transient inference settlement window", async () => {
    const probeInferenceInvocation = vi.fn(async () => ({
      ok: false as const,
      detail: "sandbox inference invocation probe returned HTTP 503",
      httpStatus: 503,
    }));
    const delayInferenceInvocationProbe = vi.fn(async () => {});
    const h = harness({ probeInferenceInvocation, delayInferenceInvocationProbe });
    h.getSandbox.mockReturnValue(
      sandbox({
        agent: "hermes",
        provider: "nvidia",
        model: "nvidia/nemotron-3-super-120b-a12b",
      }),
    );

    await expect(startSandbox("my-sandbox", h.deps)).resolves.toEqual({ exitCode: 1 });

    expect(probeInferenceInvocation).toHaveBeenCalledTimes(3);
    expect(delayInferenceInvocationProbe.mock.calls).toEqual([[2_000], [2_000]]);
  });

  it("does not add Hermes startup settlement to OpenClaw inference", async () => {
    const probeInferenceInvocation = vi.fn(async () => ({
      ok: false as const,
      detail: "sandbox inference invocation probe returned HTTP 503",
      httpStatus: 503,
    }));
    const delayInferenceInvocationProbe = vi.fn(async () => {});
    const h = harness({ probeInferenceInvocation, delayInferenceInvocationProbe });
    h.getSandbox.mockReturnValue(
      sandbox({ agent: "openclaw", provider: "nvidia", model: "nvidia/nemotron" }),
    );

    await expect(startSandbox("my-sandbox", h.deps)).resolves.toEqual({ exitCode: 1 });

    expect(probeInferenceInvocation).toHaveBeenCalledOnce();
    expect(delayInferenceInvocationProbe).not.toHaveBeenCalled();
  });
});
