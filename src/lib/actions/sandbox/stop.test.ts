// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as agentRuntime from "../../agent/runtime";
import type { OpenShellForwardAdapter } from "../../adapters/openshell/forward";
import { fingerprintOpenShellSandboxId } from "../../adapters/openshell/sandbox-identity";
import type { OpenShellSandboxStateLifecycle } from "../../adapters/openshell/sandbox-lifecycle-sdk";
import {
  createDockerRuntimeProviderBundle,
  createKubernetesRuntimeProviderBundle,
} from "../../onboard/runtime-provider/docker";
import { createRuntimeProviderBundleRegistry } from "../../onboard/runtime-provider/registry";
import { decideOllamaModelOwnership } from "../../inference/ollama/model-ownership";
import type { OllamaUnloadResult } from "../../inference/ollama/proxy";
import * as ollamaProxy from "../../inference/ollama/proxy";
import type { SandboxEntry } from "../../state/registry";
import { teardownSandboxDashboardForward } from "./forward-recovery";
import { discoverActiveOllamaSandboxNames, type SandboxStopDeps, stopSandbox } from "./stop";

function sandbox(values: Partial<SandboxEntry> = {}): SandboxEntry {
  return {
    name: "my-sandbox",
    lifecycleLiveIdentityFingerprint: fingerprintOpenShellSandboxId("sandbox-alpha")!,
    ...values,
  };
}

function successfulUnload(outcome: "released" | "not-resident" = "released"): OllamaUnloadResult {
  return {
    ok: true,
    outcome,
    endpoint: "http://127.0.0.1:11434",
    selectedModels: ["qwen2.5:7b"],
    discoveries: [
      {
        attempt: 1,
        endpoint: "http://127.0.0.1:11434/api/ps",
        status: 0,
        residentModels: [],
        matchedModels: [],
      },
    ],
    requests: [],
  };
}

function failedUnload(
  outcome: "discovery-failed" | "unload-request-failed" | "still-resident",
  message: string,
): OllamaUnloadResult {
  return {
    ok: false,
    outcome,
    endpoint: "http://127.0.0.1:11434",
    selectedModels: ["qwen2.5:7b"],
    discoveries: [
      {
        attempt: 3,
        endpoint: "http://127.0.0.1:11434/api/ps",
        status: 0,
        residentModels: ["qwen2.5:7b"],
        matchedModels: ["qwen2.5:7b"],
      },
    ],
    requests: [],
    message,
  };
}

function openShellFailure(message: string) {
  return {
    kind: "failed" as const,
    error: { kind: "transport" as const, reason: "unreachable" as const, message },
  };
}

type StopHarnessOverrides = Partial<SandboxStopDeps> & {
  stopOpenShellSandbox?: OpenShellSandboxStateLifecycle["stopSandbox"];
};

function harness(overrides: StopHarnessOverrides = {}) {
  const { stopOpenShellSandbox: stopOpenShellSandboxOverride, ...actionOverrides } = overrides;
  let storedSandbox = sandbox();
  const getSandbox = vi.fn<NonNullable<SandboxStopDeps["getSandbox"]>>(() => storedSandbox);
  const stopPortableSandbox = vi.fn<NonNullable<SandboxStopDeps["stopPortableSandbox"]>>(
    async () => ({ kind: "not-installed" }),
  );
  const qualifyLegacyPortableProfile = vi.fn<
    NonNullable<SandboxStopDeps["qualifyLegacyPortableProfile"]>
  >(() => false);
  const stopSandboxChannels = vi.fn<NonNullable<SandboxStopDeps["stopSandboxChannels"]>>();
  const stopOpenShellSandbox = vi.fn<OpenShellSandboxStateLifecycle["stopSandbox"]>(
    stopOpenShellSandboxOverride ?? (async () => ({ kind: "accepted" })),
  );
  const openShellLifecycle: OpenShellSandboxStateLifecycle = {
    startSandbox: vi.fn(async () => ({ kind: "accepted" as const })),
    stopSandbox: stopOpenShellSandbox,
  };
  const withLifecycleLock: NonNullable<SandboxStopDeps["withLifecycleLock"]> = async (
    _sandboxName,
    operation,
  ) => await operation();
  const teardownSandboxDashboardForward = vi.fn<
    NonNullable<SandboxStopDeps["teardownSandboxDashboardForward"]>
  >(async () => true);
  const updateSandbox = vi.fn<NonNullable<SandboxStopDeps["updateSandbox"]>>((_name, updates) => {
    storedSandbox = { ...storedSandbox, ...updates };
    return true;
  });
  const log = vi.fn<(message: string) => void>();
  const warn = vi.fn<(message: string) => void>();
  const runtimeProviders = createRuntimeProviderBundleRegistry([
    ["docker", createDockerRuntimeProviderBundle()],
    ["kubernetes", createKubernetesRuntimeProviderBundle()],
  ]);
  const deps: SandboxStopDeps = {
    getSandbox,
    openShellLifecycle,
    qualifyLegacyPortableProfile,
    runtimeProviders,
    stopSandboxChannels,
    teardownSandboxDashboardForward,
    listSandboxes: () => ({ sandboxes: [storedSandbox], defaultSandbox: null }),
    log,
    warn,
    decideOllamaModelOwnership,
    discoverActiveOllamaSandboxNames: (peers) => ({
      ok: true,
      activeSandboxNames: new Set(peers.map((peer) => peer.name)),
      gatewayChecks: [],
    }),
    loadPersistedOllamaHost: () => null,
    withOllamaModelOwnershipLock: (operation) => operation(),
    withLifecycleLock,
    stopPortableSandbox,
    updateSandbox,
    ...actionOverrides,
  };
  return {
    deps,
    teardownSandboxDashboardForward,
    updateSandbox,
    getSandbox,
    log,
    qualifyLegacyPortableProfile,
    stopSandboxChannels,
    stopPortableSandbox,
    stopOpenShellSandbox,
    warn,
  };
}

describe("teardownSandboxDashboardForward", () => {
  it("does not verify a fallback dashboard port for a terminal agent", async () => {
    const registeredAgent = vi
      .spyOn(agentRuntime, "getRegisteredAgent")
      .mockReturnValue({ runtime: { kind: "terminal" } } as never);
    const resolveSandboxDashboardPort = vi.fn(() => 18789);
    const verifyForwardRelease = vi.fn<OpenShellForwardAdapter["verifyForwardRelease"]>();

    await expect(
      teardownSandboxDashboardForward("terminal-sandbox", {
        forwardAdapterForAuthority: () => ({ verifyForwardRelease }),
        getSandbox: () => sandbox({ agent: "terminal-agent" }),
        resolveSandboxDashboardPort,
      }),
    ).resolves.toBe(true);
    expect(resolveSandboxDashboardPort).not.toHaveBeenCalled();
    expect(verifyForwardRelease).not.toHaveBeenCalled();
    registeredAgent.mockRestore();
  });

  it("verifies the selected sandbox port is released after stop", async () => {
    const getSandbox = vi.fn(() =>
      sandbox({
        dashboardPort: 19443,
        gatewayName: "nemoclaw-18080",
        gatewayPort: 18080,
      }),
    );
    const resolveSandboxDashboardPort = vi.fn(() => 19443);
    const verifyForwardRelease = vi
      .fn<OpenShellForwardAdapter["verifyForwardRelease"]>()
      .mockResolvedValue({ state: "released" });

    await expect(
      teardownSandboxDashboardForward("selected-sandbox", {
        forwardAdapterForAuthority: () => ({ verifyForwardRelease }),
        getSandbox,
        resolveForwardRuntimeAuthority: () => ({
          authority: {
            endpoint: "https://127.0.0.1:18080",
            owner: {
              endpoint: null,
              gatewayName: "nemoclaw-18080",
              gatewayPort: 18080,
              mode: "nemoclaw-managed",
              requiredCapabilities: [],
              source: "packaged-service",
              stateDir: null,
              supervisor: null,
            },
          },
          runtime: {
            gatewayEndpoint: "https://127.0.0.1:18080",
            gatewayName: "nemoclaw-18080",
            workspace: "default",
          },
        }),
        resolveSandboxDashboardPort,
      }),
    ).resolves.toBe(true);

    expect(resolveSandboxDashboardPort).toHaveBeenCalledWith(
      "selected-sandbox",
      expect.objectContaining({ getSandbox: expect.any(Function) }),
    );
    expect(verifyForwardRelease).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        forwards: [expect.objectContaining({ port: 19443, sandboxName: "selected-sandbox" })],
        timeoutMs: 5_000,
      }),
    );
  });
});

describe("discoverActiveOllamaSandboxNames", () => {
  const environment = { HOME: "/tmp/test-home" };
  const activePeer = sandbox({ name: "active-peer" });
  const stoppedPeer = sandbox({ name: "stopped-peer" });

  it("groups peers by gateway and distinguishes active phases from stopped or absent rows (#10074)", async () => {
    const captureSandboxOwnershipPhases = vi.fn(() => ({
      status: 0,
      output: [
        "NAME CREATED PHASE",
        "active-peer 2026-08-25 Ready",
        "transient-peer 2026-08-25 Provisioning",
        "stopped-peer 2026-08-25 Error",
      ].join("\n"),
    }));
    const transientPeer = sandbox({ name: "transient-peer" });
    const missingPeer = sandbox({ name: "missing-peer" });

    expect(
      discoverActiveOllamaSandboxNames(
        [activePeer, transientPeer, stoppedPeer, missingPeer],
        environment,
        {
          captureSandboxOwnershipPhases,
          resolvePersistedSandboxOwnershipGateway: () => "nemoclaw",
        },
      ),
    ).toEqual({
      ok: true,
      activeSandboxNames: new Set(["active-peer", "transient-peer"]),
      gatewayChecks: [
        {
          activeSandboxes: ["active-peer", "transient-peer"],
          gateway: "nemoclaw",
        },
      ],
    });
    expect(captureSandboxOwnershipPhases).toHaveBeenCalledExactlyOnceWith("nemoclaw", environment);
  });

  it("fails closed when a listed sibling has no usable phase (#10074)", async () => {
    const result = discoverActiveOllamaSandboxNames([activePeer], environment, {
      captureSandboxOwnershipPhases: () => ({
        status: 0,
        output: "NAME CREATED PHASE\nactive-peer 2026-08-25 Unknown",
      }),
      resolvePersistedSandboxOwnershipGateway: () => "nemoclaw",
    });

    expect(result).toEqual({
      ok: false,
      message: "OpenShell returned no usable phase for sibling 'active-peer' on gateway 'nemoclaw'",
    });
  });

  it("returns bounded OpenShell discovery evidence instead of treating a failed list as stale (#10074)", async () => {
    const result = discoverActiveOllamaSandboxNames([activePeer], environment, {
      captureSandboxOwnershipPhases: () => ({ status: 1, output: "gateway unavailable\n" }),
      resolvePersistedSandboxOwnershipGateway: () => "nemoclaw",
    });

    expect(result).toEqual({
      ok: false,
      message: "OpenShell could not list sandbox phases on gateway 'nemoclaw': gateway unavailable",
    });
  });
});

describe("stopSandbox", () => {
  it("derives the canonical gateway name from a persisted non-default port", async () => {
    const h = harness();
    h.getSandbox.mockReturnValue(
      sandbox({ gatewayName: undefined, gatewayPort: 18080, openshellDriver: "docker" }),
    );

    await expect(stopSandbox("my-sandbox", h.deps)).resolves.toEqual({ exitCode: 0 });

    expect(h.stopOpenShellSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: "named", gatewayName: "nemoclaw-18080" },
      }),
    );
  });

  beforeEach(() => {
    vi.spyOn(ollamaProxy, "loadPersistedOllamaHost").mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stops a sandbox from its sibling gateway registry and records stop intent there", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-stop-cross-root-"));
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
            dashboardPort: 19443,
            gatewayName: "nemoclaw-8245",
            gatewayPort: 8245,
            lifecycleLiveIdentityFingerprint: fingerprintOpenShellSandboxId("sandbox-alpha"),
            openshellDriver: "docker",
          },
        },
      }),
    );
    vi.stubEnv("HOME", home);
    try {
      const verifyForwardRelease = vi
        .fn<OpenShellForwardAdapter["verifyForwardRelease"]>()
        .mockResolvedValue({ state: "released" });
      const h = harness({
        teardownSandboxDashboardForward: (sandboxName) =>
          teardownSandboxDashboardForward(sandboxName, {
            forwardAdapterForAuthority: () => ({ verifyForwardRelease }),
            resolveForwardRuntimeAuthority: () => ({
              authority: {
                endpoint: "https://127.0.0.1:8245",
                owner: {
                  endpoint: null,
                  gatewayName: "nemoclaw-8245",
                  gatewayPort: 8245,
                  mode: "nemoclaw-managed",
                  requiredCapabilities: [],
                  source: "standalone",
                  stateDir: null,
                  supervisor: null,
                },
              },
              runtime: {
                gatewayEndpoint: "https://127.0.0.1:8245",
                gatewayName: "nemoclaw-8245",
                workspace: "default",
              },
            }),
          }),
      });
      const {
        getSandbox: _getSandbox,
        listSandboxes: _listSandboxes,
        updateSandbox: _updateSandbox,
        ...deps
      } = h.deps;

      await expect(stopSandbox("my-sandbox", deps)).resolves.toEqual({ exitCode: 0 });

      expect(
        JSON.parse(fs.readFileSync(registryFile, "utf8")).sandboxes["my-sandbox"],
      ).toMatchObject({ gatewayPort: 8245, stopped: true });
      expect(verifyForwardRelease).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          forwards: [
            expect.objectContaining({
              gatewayName: "nemoclaw-8245",
              port: 19443,
              sandboxName: "my-sandbox",
            }),
          ],
        }),
      );
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("gracefully stops in-sandbox channels before stopping through OpenShell (#6026)", async () => {
    const h = harness();
    h.getSandbox.mockReturnValue(sandbox({ lifecycleGeneration: "standard-generation" }));

    const result = await stopSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(0);
    expect(h.stopSandboxChannels).toHaveBeenCalledWith(
      "my-sandbox",
      expect.objectContaining({
        channelStopTransport: "docker-kubectl-first",
        info: expect.any(Function),
        warn: expect.any(Function),
      }),
    );
    expect(h.stopOpenShellSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxName: "my-sandbox" }),
    );
    expect(h.stopPortableSandbox).not.toHaveBeenCalled();
    expect(h.stopSandboxChannels.mock.invocationCallOrder[0]).toBeLessThan(
      h.stopOpenShellSandbox.mock.invocationCallOrder[0],
    );
  });

  it("tears down the host-side dashboard port-forward after stopping the container (#7227)", async () => {
    const h = harness();

    const result = await stopSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(0);
    expect(h.teardownSandboxDashboardForward).toHaveBeenCalledWith("my-sandbox");
    // Release the forward only after the container is stopped, never before.
    expect(h.stopOpenShellSandbox.mock.invocationCallOrder[0]).toBeLessThan(
      h.teardownSandboxDashboardForward.mock.invocationCallOrder[0],
    );
  });

  it("reports failure and preserves recovery state when dashboard cleanup cannot launch (#7227, #9808)", async () => {
    const teardownSandboxDashboardForward = vi.fn(() => {
      throw new Error("spawn openshell EACCES");
    });
    const h = harness({ teardownSandboxDashboardForward });

    const result = await stopSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("release of its host forward ports could not be proved");
    expect(result.message).toContain("Recoverable registry state was preserved");
    expect(h.getSandbox("my-sandbox")?.stopped).toBe(true);
    expect(teardownSandboxDashboardForward).toHaveBeenCalledWith("my-sandbox");
    expect(h.warn).toHaveBeenCalledWith(
      "  Warning: could not release the dashboard port-forward: spawn openshell EACCES",
    );
  });

  it("reports failure when dashboard port release remains unproved (#9808)", async () => {
    const h = harness({ teardownSandboxDashboardForward: vi.fn(async () => false) });

    const result = await stopSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("release of its host forward ports could not be proved");
    expect(h.getSandbox("my-sandbox")?.stopped).toBe(true);
    expect(h.warn).toHaveBeenCalledWith(
      "  Warning: a ForwardTcp port for 'my-sandbox' did not release. Retry 'nemoclaw my-sandbox stop'.",
    );
  });

  it("does not release the dashboard forward when the container failed to stop (#7227)", async () => {
    const h = harness({
      stopOpenShellSandbox: async () => openShellFailure("gateway unavailable"),
    });

    const result = await stopSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(1);
    expect(h.teardownSandboxDashboardForward).not.toHaveBeenCalled();
  });

  it("records stopped: true in the sandbox registry on successful stop (#11025)", async () => {
    const h = harness();

    const result = await stopSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(0);
    expect(h.updateSandbox).toHaveBeenCalledWith("my-sandbox", { stopped: true });
    expect(h.getSandbox("my-sandbox")?.stopped).toBe(true);
  });

  it("does not record stopped: true when container stop fails (#11025)", async () => {
    const h = harness({
      stopOpenShellSandbox: async () => openShellFailure("gateway unavailable"),
    });

    const result = await stopSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(1);
    expect(h.updateSandbox).not.toHaveBeenCalled();
    expect(h.getSandbox("my-sandbox")?.stopped).toBeUndefined();
  });

  it("returns retryable error and still runs cleanup when updateSandbox throws (#11025)", async () => {
    const teardownSandboxDashboardForward = vi.fn();
    const updateSandbox = vi.fn(() => {
      throw new Error("disk full");
    });
    const h = harness({ teardownSandboxDashboardForward, updateSandbox });

    const result = await stopSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("could not record the intentional stop");
    expect(result.message).toContain("Retry 'nemoclaw my-sandbox stop'");
    expect(teardownSandboxDashboardForward).toHaveBeenCalledWith("my-sandbox");
  });

  it("returns a retryable error when the registry row disappears after stop (#11025)", async () => {
    const h = harness({ updateSandbox: vi.fn(() => false) });

    const result = await stopSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("could not record the intentional stop");
  });

  it("routes channel-stop reporter lines through the action's log and warn (#6026)", async () => {
    const h = harness();
    h.stopSandboxChannels.mockImplementation((_name, channelDeps) => {
      channelDeps?.info?.("gateway stopped inside sandbox.");
      channelDeps?.warn?.("could not reach gateway.");
    });

    await stopSandbox("my-sandbox", h.deps);

    expect(h.log).toHaveBeenCalledWith("  gateway stopped inside sandbox.");
    expect(h.warn).toHaveBeenCalledWith("  could not reach gateway.");
  });

  it("preserves the registry entry and tells the user how to start again (#6026)", async () => {
    const h = harness();

    const result = await stopSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(0);
    const output = h.log.mock.calls.map(([line]) => line).join("\n");
    expect(output).toContain("Workspace state is preserved");
    expect(output).toContain("nemoclaw my-sandbox start");
  });

  it("uses recorded Podman authority instead of ambient Docker for a portable receipt (#9070)", async () => {
    const h = harness();
    h.getSandbox.mockReturnValue(
      sandbox({
        agent: "openclaw",
        gatewayName: "nemoclaw",
        lifecycleGeneration: "generation-alpha",
        openshellDriver: "docker",
        portableLifecycleProfile: "openclaw",
      }),
    );
    h.stopPortableSandbox.mockImplementation(async (_name, _context, beforeStop) => {
      beforeStop();
      return { kind: "stopped" };
    });

    expect(await stopSandbox("my-sandbox", h.deps)).toEqual({ exitCode: 0 });

    expect(h.stopPortableSandbox).toHaveBeenCalledWith(
      "my-sandbox",
      expect.objectContaining({ lifecycleGeneration: "generation-alpha" }),
      expect.any(Function),
      expect.objectContaining({ env: process.env }),
    );
    expect(h.stopSandboxChannels).toHaveBeenCalledExactlyOnceWith("my-sandbox", expect.any(Object));
    expect(h.stopOpenShellSandbox).not.toHaveBeenCalled();
  });

  it("admits a receipt-qualified legacy Hermes profile for portable stop", async () => {
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
    h.stopPortableSandbox.mockResolvedValue({ kind: "stopped", portableAgent: "hermes" });

    await expect(stopSandbox("my-sandbox", h.deps)).resolves.toEqual({ exitCode: 0 });

    expect(h.stopPortableSandbox).toHaveBeenCalledOnce();
    expect(h.stopOpenShellSandbox).not.toHaveBeenCalled();
  });

  it("keeps active Hermes stop out of Docker and Docker-capable channel transport (#9203)", async () => {
    const unloadOllamaModels = vi.fn(() => successfulUnload());
    const h = harness({
      unloadOllamaModels,
      listSandboxes: () => ({ sandboxes: [], defaultSandbox: null }),
    });
    h.getSandbox.mockReturnValue(
      sandbox({
        agent: "hermes",
        gatewayName: "nemoclaw",
        lifecycleGeneration: "generation-alpha",
        lifecycleLiveIdentityFingerprint: "identity-alpha",
        model: "qwen2.5:7b",
        openshellDriver: "docker",
        portableLifecycleProfile: "hermes",
        provider: "ollama/qwen3-vl:4b",
      }),
    );
    h.stopPortableSandbox.mockResolvedValue({ kind: "stopped", portableAgent: "hermes" });

    expect(await stopSandbox("my-sandbox", h.deps)).toEqual({ exitCode: 0 });

    expect(h.stopSandboxChannels).not.toHaveBeenCalled();
    expect(h.stopOpenShellSandbox).not.toHaveBeenCalled();
    expect(h.teardownSandboxDashboardForward).toHaveBeenCalledWith("my-sandbox");
    expect(unloadOllamaModels).toHaveBeenCalledWith(["qwen2.5:7b"]);
  });

  it("keeps a shared Ollama model loaded after a verified Hermes stop (#10074)", async () => {
    const unloadOllamaModels = vi.fn(() => successfulUnload());
    const hermesSandbox = sandbox({
      agent: "hermes",
      gatewayName: "nemoclaw",
      lifecycleGeneration: "generation-alpha",
      lifecycleLiveIdentityFingerprint: "identity-alpha",
      model: "qwen2.5:7b",
      openshellDriver: "docker",
      portableLifecycleProfile: "hermes",
      provider: "ollama/qwen3-vl:4b",
    });
    const peer = sandbox({ model: "qwen2.5:7b", name: "peer", provider: "ollama-local" });
    const h = harness({
      listSandboxes: () => ({ sandboxes: [hermesSandbox, peer], defaultSandbox: null }),
      unloadOllamaModels,
    });
    h.getSandbox.mockReturnValue(hermesSandbox);
    h.stopPortableSandbox.mockResolvedValue({ kind: "stopped", portableAgent: "hermes" });

    expect(await stopSandbox("my-sandbox", h.deps)).toEqual({ exitCode: 0 });
    expect(unloadOllamaModels).not.toHaveBeenCalled();
  });

  it("continues to OpenShell stop when the graceful channel stop throws (#6026)", async () => {
    const h = harness();
    h.stopSandboxChannels.mockImplementation(() => {
      throw new Error("gateway unreachable");
    });

    const result = await stopSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(0);
    expect(h.stopOpenShellSandbox).toHaveBeenCalledTimes(1);
    const warned = h.warn.mock.calls.map(([line]) => line).join("\n");
    expect(warned).toContain("gateway unreachable");
  });

  it("refuses an unregistered sandbox (#6026)", async () => {
    const h = harness();
    h.getSandbox.mockReturnValue(null);

    const result = await stopSandbox("ghost", h.deps);

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("not registered");
    expect(h.stopOpenShellSandbox).not.toHaveBeenCalled();
  });

  it("refuses non-direct drivers instead of guessing at container control (#6026)", async () => {
    const h = harness();
    h.getSandbox.mockReturnValue(sandbox({ openshellDriver: "kubernetes" }));

    const result = await stopSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("kubernetes");
    expect(result.message).toContain("is unavailable for runtime provider");
    expect(h.stopSandboxChannels).not.toHaveBeenCalled();
    expect(h.stopOpenShellSandbox).not.toHaveBeenCalled();
    expect(h.teardownSandboxDashboardForward).not.toHaveBeenCalled();
  });

  it.each(["unknown-runtime", "mxc-not-installed"])(
    "fails closed for unregistered provider %s without lifecycle side effects",
    async (providerId) => {
      const h = harness();
      h.getSandbox.mockReturnValue(sandbox({ openshellDriver: providerId }));

      const result = await stopSandbox("my-sandbox", h.deps);

      expect(result.exitCode).toBe(1);
      expect(result.message).toContain(providerId);
      expect(result.message).toContain("has no registered lifecycle provider");
      expect(h.stopSandboxChannels).not.toHaveBeenCalled();
      expect(h.stopOpenShellSandbox).not.toHaveBeenCalled();
      expect(h.teardownSandboxDashboardForward).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["null driver", sandbox({ openshellDriver: null })],
    ["docker driver", sandbox({ openshellDriver: "docker" })],
    ["vm driver", sandbox({ openshellDriver: "vm" })],
  ])("allows the %s like privileged exec does (#6026)", async (_label, entry) => {
    const h = harness();
    h.getSandbox.mockReturnValue(entry);

    const result = await stopSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(0);
  });

  it("surfaces an OpenShell stop failure with the sandbox name (#6026)", async () => {
    const h = harness({
      stopOpenShellSandbox: async () => openShellFailure("gateway unavailable"),
    });

    const result = await stopSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("my-sandbox");
    expect(result.message).toContain("gateway unavailable");
  });
});

describe("stopSandbox Ollama GPU release", () => {
  const ollamaSandbox = sandbox({ model: "qwen2.5:7b", provider: "ollama-local" });

  function registryOf(...sandboxes: SandboxEntry[]) {
    return () => ({ sandboxes, defaultSandbox: null });
  }

  it("unloads the sandbox's own model so a stop frees GPU memory (#9110)", async () => {
    const unloadOllamaModels = vi.fn(() => successfulUnload());
    const h = harness({ listSandboxes: registryOf(ollamaSandbox), unloadOllamaModels });
    h.getSandbox.mockReturnValue(ollamaSandbox);

    const result = await stopSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(0);
    expect(unloadOllamaModels).toHaveBeenCalledWith(["qwen2.5:7b"]);
  });

  it("holds the shared ownership lock across the peer scan and unload (#9110)", async () => {
    const events: string[] = [];
    const h = harness({
      listSandboxes: () => {
        events.push("peer-scan");
        return { sandboxes: [ollamaSandbox], defaultSandbox: null };
      },
      unloadOllamaModels: () => {
        events.push("unload");
        return successfulUnload();
      },
      withOllamaModelOwnershipLock: (operation) => {
        events.push("ownership-lock-enter");
        const result = operation();
        events.push("ownership-lock-exit");
        return result;
      },
    });
    h.getSandbox.mockReturnValue(ollamaSandbox);

    await stopSandbox("my-sandbox", h.deps);

    expect(events).toEqual(["ownership-lock-enter", "peer-scan", "unload", "ownership-lock-exit"]);
  });

  it("releases GPU memory on an already-stopped sandbox too (#9110)", async () => {
    const unloadOllamaModels = vi.fn(() => successfulUnload());
    const h = harness({
      listSandboxes: registryOf(ollamaSandbox),
      unloadOllamaModels,
    });
    h.getSandbox.mockReturnValue(ollamaSandbox);

    const result = await stopSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(0);
    expect(unloadOllamaModels).toHaveBeenCalledWith(["qwen2.5:7b"]);
  });

  it("never unloads a model a sibling Ollama sandbox also uses (#9110)", async () => {
    const unloadOllamaModels = vi.fn(() => successfulUnload());
    const peer = sandbox({ model: "qwen2.5:7b", name: "peer", provider: "ollama-local" });
    const h = harness({
      listSandboxes: registryOf(ollamaSandbox, peer),
      unloadOllamaModels,
    });
    h.getSandbox.mockReturnValue(ollamaSandbox);

    const result = await stopSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(0);
    expect(unloadOllamaModels).not.toHaveBeenCalled();
    expect(h.log).toHaveBeenCalledWith(
      "  Ollama model 'qwen2.5:7b' remains loaded for active sandbox: peer.",
    );
  });

  it("never unloads a model a compatible local endpoint sibling also uses", async () => {
    const unloadOllamaModels = vi.fn(() => successfulUnload());
    const peer = sandbox({
      endpointUrl: "http://127.0.0.1:11434/v1",
      model: "qwen2.5:7b",
      name: "peer",
      provider: "compatible-endpoint",
    });
    const h = harness({
      listSandboxes: registryOf(ollamaSandbox, peer),
      loadPersistedOllamaHost: () => "127.0.0.1",
      unloadOllamaModels,
    });
    h.getSandbox.mockReturnValue(ollamaSandbox);

    const result = await stopSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(0);
    expect(unloadOllamaModels).not.toHaveBeenCalled();
  });

  it("releases the model when OpenShell reports the only sibling as Stopped (#11650)", async () => {
    const unloadOllamaModels = vi.fn(() => successfulUnload());
    const stoppedPeer = sandbox({
      model: "qwen2.5:7b",
      name: "stopped-peer",
      provider: "ollama-local",
    });
    const h = harness({
      discoverActiveOllamaSandboxNames: (peers, environment) =>
        discoverActiveOllamaSandboxNames(peers, environment, {
          captureSandboxOwnershipPhases: () => ({
            status: 0,
            output: "NAME CREATED PHASE\nstopped-peer 2026-09-12 Stopped",
          }),
          resolvePersistedSandboxOwnershipGateway: () => "nemoclaw",
        }),
      listSandboxes: registryOf(ollamaSandbox, stoppedPeer),
      unloadOllamaModels,
    });
    h.getSandbox.mockReturnValue(ollamaSandbox);

    expect(await stopSandbox("my-sandbox", h.deps)).toEqual({ exitCode: 0 });
    expect(unloadOllamaModels).toHaveBeenCalledWith(["qwen2.5:7b"]);
    expect(h.log).toHaveBeenCalledWith(
      "  Ollama ownership ignored stopped or incomplete registry row: stopped-peer.",
    );
  });

  it("fails without unloading when active sibling discovery is unavailable (#10074)", async () => {
    const unloadOllamaModels = vi.fn(() => successfulUnload());
    const peer = sandbox({ model: "qwen2.5:7b", name: "peer", provider: "ollama-local" });
    const h = harness({
      discoverActiveOllamaSandboxNames: () => ({
        ok: false,
        message: "OpenShell sandbox list timed out",
      }),
      listSandboxes: registryOf(ollamaSandbox, peer),
      unloadOllamaModels,
    });
    h.getSandbox.mockReturnValue(ollamaSandbox);

    const result = await stopSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("ownership could not be verified");
    expect(result.message).toContain("OpenShell sandbox list timed out");
    expect(unloadOllamaModels).not.toHaveBeenCalled();
    expect(h.teardownSandboxDashboardForward).toHaveBeenCalledWith("my-sandbox");
  });

  it.each([
    ["an implicit latest tag", "llama3", "llama3:latest"],
    ["an explicit latest tag", "llama3:latest", "llama3"],
  ])("protects a sibling recorded with %s (#9110)", async (_label, ownModel, peerModel) => {
    const unloadOllamaModels = vi.fn(() => successfulUnload());
    const own = sandbox({ model: ownModel, provider: "ollama-local" });
    const peer = sandbox({ model: peerModel, name: "peer", provider: "ollama-local" });
    const h = harness({ listSandboxes: registryOf(own, peer), unloadOllamaModels });
    h.getSandbox.mockReturnValue(own);

    await stopSandbox("my-sandbox", h.deps);

    expect(unloadOllamaModels).not.toHaveBeenCalled();
  });

  it("still releases its own model when a sibling holds a different one (#9110)", async () => {
    const unloadOllamaModels = vi.fn(() => successfulUnload());
    const peer = sandbox({ model: "llama3:8b", name: "peer", provider: "ollama-local" });
    const h = harness({
      listSandboxes: registryOf(ollamaSandbox, peer),
      unloadOllamaModels,
    });
    h.getSandbox.mockReturnValue(ollamaSandbox);

    await stopSandbox("my-sandbox", h.deps);

    expect(unloadOllamaModels).toHaveBeenCalledWith(["qwen2.5:7b"]);
  });

  it.each([
    ["nvidia-prod", sandbox({ model: "qwen2.5:7b", provider: "nvidia-prod" })],
    ["vllm-local", sandbox({ model: "qwen2.5:7b", provider: "vllm-local" })],
    ["an unrecorded provider", sandbox({ model: "qwen2.5:7b" })],
    ["an unrecorded model", sandbox({ provider: "ollama-local" })],
  ])("leaves %s sandboxes untouched (#9110)", async (_label, entry) => {
    const unloadOllamaModels = vi.fn(() => successfulUnload());
    const h = harness({ listSandboxes: registryOf(entry), unloadOllamaModels });
    h.getSandbox.mockReturnValue(entry);

    const result = await stopSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(0);
    expect(unloadOllamaModels).not.toHaveBeenCalled();
  });

  it("returns an actionable failure when the unload throws (#10074)", async () => {
    const unloadOllamaModels = vi.fn(() => {
      throw new Error("curl: command not found");
    });
    const h = harness({ listSandboxes: registryOf(ollamaSandbox), unloadOllamaModels });
    h.getSandbox.mockReturnValue(ollamaSandbox);

    const result = await stopSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("curl: command not found");
    expect(result.message).toContain("retry 'nemoclaw my-sandbox stop'");
  });

  it.each([
    ["a rejected unload request", failedUnload("unload-request-failed", "HTTP 500")],
    ["a model that remains resident", failedUnload("still-resident", "still loaded")],
    ["a failed post-release discovery", failedUnload("discovery-failed", "malformed JSON")],
  ])("returns a nonzero stop for %s (#10074)", async (_label, unloadResult) => {
    const h = harness({
      listSandboxes: registryOf(ollamaSandbox),
      unloadOllamaModels: () => unloadResult,
    });
    h.getSandbox.mockReturnValue(ollamaSandbox);

    const result = await stopSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain(unloadResult.outcome);
    expect(result.message).toContain("after 3 bounded attempts");
    expect(result.message).toContain("ollama stop qwen2.5:7b");
    expect(h.teardownSandboxDashboardForward).toHaveBeenCalledWith("my-sandbox");
  });

  it("skips the unload when the stop itself failed (#9110)", async () => {
    const unloadOllamaModels = vi.fn(() => successfulUnload());
    const h = harness({ listSandboxes: registryOf(ollamaSandbox), unloadOllamaModels });
    h.getSandbox.mockReturnValue(ollamaSandbox);
    h.stopOpenShellSandbox.mockResolvedValue(openShellFailure("gateway unavailable"));

    const result = await stopSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(1);
    expect(unloadOllamaModels).not.toHaveBeenCalled();
  });
});
