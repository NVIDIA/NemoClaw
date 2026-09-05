// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import * as agentRuntime from "../../agent/runtime";
import {
  createDockerRuntimeProviderBundle,
  createKubernetesRuntimeProviderBundle,
  type DockerRuntimeProviderDependencies,
} from "../../onboard/runtime-provider/docker";
import { createRuntimeProviderBundleRegistry } from "../../onboard/runtime-provider/registry";
import { decideOllamaModelOwnership } from "../../inference/ollama/model-ownership";
import type { OllamaUnloadResult } from "../../inference/ollama/proxy";
import type { SandboxEntry } from "../../state/registry";
import { teardownSandboxDashboardForward } from "./forward-recovery";
import { discoverActiveOllamaSandboxNames, type SandboxStopDeps, stopSandbox } from "./stop";

function sandbox(values: Partial<SandboxEntry> = {}): SandboxEntry {
  return { name: "my-sandbox", ...values };
}

function container(name: string, running: boolean) {
  return {
    name,
    status: running ? "Up 5 minutes" : "Exited (0) 2 hours ago",
    running,
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

type StopHarnessOverrides = Partial<SandboxStopDeps> & {
  dockerStop?: DockerRuntimeProviderDependencies["stopContainer"];
  findLabeledSandboxContainers?: DockerRuntimeProviderDependencies["findLabeledSandboxContainers"];
};

function harness(overrides: StopHarnessOverrides = {}) {
  const {
    dockerStop: dockerStopOverride,
    findLabeledSandboxContainers: findContainersOverride,
    ...actionOverrides
  } = overrides;
  const getSandbox = vi.fn<NonNullable<SandboxStopDeps["getSandbox"]>>(() => sandbox());
  const isDockerRuntimeDown = vi.fn<DockerRuntimeProviderDependencies["isRuntimeDown"]>(
    () => false,
  );
  const printDockerRuntimeDownGuidance =
    vi.fn<DockerRuntimeProviderDependencies["printRuntimeDownGuidance"]>();
  const findLabeledSandboxContainers = vi.fn<
    DockerRuntimeProviderDependencies["findLabeledSandboxContainers"]
  >(findContainersOverride ?? (() => [container("openshell-my-sandbox", true)]));
  const hasPortableLifecycleReceipt = vi.fn<
    DockerRuntimeProviderDependencies["hasPortableLifecycleReceipt"]
  >(() => false);
  const stopPortableSandbox = vi.fn<DockerRuntimeProviderDependencies["stopPortableSandbox"]>(
    () => ({ kind: "not-installed" }),
  );
  const stopSandboxChannels = vi.fn<NonNullable<SandboxStopDeps["stopSandboxChannels"]>>();
  const dockerStop = vi.fn<DockerRuntimeProviderDependencies["stopContainer"]>(
    dockerStopOverride ?? (() => ({ status: 0 })),
  );
  const teardownSandboxDashboardForward =
    vi.fn<NonNullable<SandboxStopDeps["teardownSandboxDashboardForward"]>>();
  const log = vi.fn<(message: string) => void>();
  const warn = vi.fn<(message: string) => void>();
  const runtimeProviders = createRuntimeProviderBundleRegistry([
    [
      "docker",
      createDockerRuntimeProviderBundle({
        findLabeledSandboxContainers,
        hasPortableLifecycleReceipt,
        isRuntimeDown: isDockerRuntimeDown,
        printRuntimeDownGuidance: printDockerRuntimeDownGuidance,
        stopContainer: dockerStop,
        stopPortableSandbox,
      }),
    ],
    ["kubernetes", createKubernetesRuntimeProviderBundle()],
  ]);
  const deps: SandboxStopDeps = {
    getSandbox,
    runtimeProviders,
    stopSandboxChannels,
    teardownSandboxDashboardForward,
    log,
    warn,
    decideOllamaModelOwnership,
    discoverActiveOllamaSandboxNames: (peers) => ({
      ok: true,
      activeSandboxNames: new Set(peers.map((peer) => peer.name)),
      gatewayChecks: [],
    }),
    withOllamaModelOwnershipLock: (operation) => operation(),
    withLifecycleLockSync: (_sandboxName, operation) => operation(),
    ...actionOverrides,
  };
  return {
    deps,
    dockerStop,
    teardownSandboxDashboardForward,
    findLabeledSandboxContainers,
    getSandbox,
    hasPortableLifecycleReceipt,
    isDockerRuntimeDown,
    log,
    printDockerRuntimeDownGuidance,
    stopSandboxChannels,
    stopPortableSandbox,
    warn,
  };
}

describe("teardownSandboxDashboardForward", () => {
  it("does not wait on a fallback dashboard port for a terminal agent", () => {
    const registeredAgent = vi
      .spyOn(agentRuntime, "getRegisteredAgent")
      .mockReturnValue({ runtime: { kind: "terminal" } } as never);
    const resolveSandboxDashboardPort = vi.fn(() => 18789);
    const isLocalForwardReachable = vi.fn(() => true);

    expect(
      teardownSandboxDashboardForward("terminal-sandbox", {
        getSandbox: () => sandbox({ agent: "terminal-agent" }),
        isLocalForwardReachable,
        resolveSandboxDashboardPort,
      }),
    ).toBe(true);
    expect(resolveSandboxDashboardPort).not.toHaveBeenCalled();
    expect(isLocalForwardReachable).not.toHaveBeenCalled();
    registeredAgent.mockRestore();
  });

  it("waits for the selected sandbox port to release after stop", () => {
    const getSandbox = vi.fn(() =>
      sandbox({
        dashboardPort: 19443,
        gatewayName: "nemoclaw-18080",
        gatewayPort: 18080,
      }),
    );
    const resolveSandboxDashboardPort = vi.fn(() => 19443);
    const isLocalForwardReachable = vi
      .fn<() => boolean>()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);

    expect(() =>
      teardownSandboxDashboardForward("selected-sandbox", {
        getSandbox,
        isLocalForwardReachable,
        resolveSandboxDashboardPort,
        sleep: () => {},
      }),
    ).not.toThrow();

    expect(resolveSandboxDashboardPort).toHaveBeenCalledWith(
      "selected-sandbox",
      expect.objectContaining({ getSandbox: expect.any(Function) }),
    );
    expect(isLocalForwardReachable).toHaveBeenCalledTimes(2);
    expect(isLocalForwardReachable).toHaveBeenNthCalledWith(1, 19443);
    expect(isLocalForwardReachable).toHaveBeenNthCalledWith(2, 19443);
  });
});

describe("discoverActiveOllamaSandboxNames", () => {
  const environment = { HOME: "/tmp/test-home" };
  const activePeer = sandbox({ name: "active-peer" });
  const stoppedPeer = sandbox({ name: "stopped-peer" });

  it("groups peers by gateway and distinguishes active phases from stopped or absent rows (#10074)", () => {
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

  it("fails closed when a listed sibling has no usable phase (#10074)", () => {
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

  it("returns bounded OpenShell discovery evidence instead of treating a failed list as stale (#10074)", () => {
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
  it("gracefully stops in-sandbox channels before stopping the container (#6026)", () => {
    const h = harness();

    const result = stopSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(0);
    expect(h.stopSandboxChannels).toHaveBeenCalledWith(
      "my-sandbox",
      expect.objectContaining({
        channelStopTransport: "docker-kubectl-first",
        info: expect.any(Function),
        warn: expect.any(Function),
      }),
    );
    expect(h.dockerStop).toHaveBeenCalledWith("openshell-my-sandbox", {
      ignoreError: true,
      timeout: 30_000,
    });
    expect(h.stopSandboxChannels.mock.invocationCallOrder[0]).toBeLessThan(
      h.dockerStop.mock.invocationCallOrder[0],
    );
  });

  it("tears down the host-side dashboard port-forward after stopping the container (#7227)", () => {
    const h = harness();

    const result = stopSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(0);
    expect(h.teardownSandboxDashboardForward).toHaveBeenCalledWith("my-sandbox");
    // Release the forward only after the container is stopped, never before.
    expect(h.dockerStop.mock.invocationCallOrder[0]).toBeLessThan(
      h.teardownSandboxDashboardForward.mock.invocationCallOrder[0],
    );
  });

  it("keeps a successful stop successful when dashboard cleanup cannot launch (#7227)", () => {
    const teardownSandboxDashboardForward = vi.fn(() => {
      throw new Error("spawn openshell EACCES");
    });
    const h = harness({ teardownSandboxDashboardForward });

    const result = stopSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(0);
    expect(teardownSandboxDashboardForward).toHaveBeenCalledWith("my-sandbox");
    expect(h.warn).toHaveBeenCalledWith(
      "  Warning: could not release the dashboard port-forward: spawn openshell EACCES",
    );
  });

  it("does not release the dashboard forward when the container failed to stop (#7227)", () => {
    const h = harness({ dockerStop: vi.fn(() => ({ status: 1 })) });

    const result = stopSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(1);
    expect(h.teardownSandboxDashboardForward).not.toHaveBeenCalled();
  });

  it("releases a leftover dashboard forward for an already-stopped sandbox — idempotent (#7227)", () => {
    const h = harness({
      findLabeledSandboxContainers: vi.fn(() => [container("openshell-my-sandbox", false)]),
    });

    const result = stopSandbox("my-sandbox", h.deps);

    // No container to stop, but a repeated stop must still converge on no
    // leftover dashboard listener (e.g. a forward orphaned by an earlier stop).
    expect(result.exitCode).toBe(0);
    expect(h.dockerStop).not.toHaveBeenCalled();
    expect(h.teardownSandboxDashboardForward).toHaveBeenCalledWith("my-sandbox");
  });

  it("routes channel-stop reporter lines through the action's log and warn (#6026)", () => {
    const h = harness();
    h.stopSandboxChannels.mockImplementation((_name, channelDeps) => {
      channelDeps?.info?.("gateway stopped inside sandbox.");
      channelDeps?.warn?.("could not reach gateway.");
    });

    stopSandbox("my-sandbox", h.deps);

    expect(h.log).toHaveBeenCalledWith("  gateway stopped inside sandbox.");
    expect(h.warn).toHaveBeenCalledWith("  could not reach gateway.");
  });

  it("preserves the registry entry and tells the user how to start again (#6026)", () => {
    const h = harness();

    const result = stopSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(0);
    const output = h.log.mock.calls.map(([line]) => line).join("\n");
    expect(output).toContain("Workspace state is preserved");
    expect(output).toContain("nemoclaw my-sandbox start");
  });

  it("uses recorded Podman authority instead of ambient Docker for a portable receipt (#9070)", () => {
    const h = harness();
    h.getSandbox.mockReturnValue(
      sandbox({
        agent: "openclaw",
        gatewayName: "nemoclaw",
        lifecycleGeneration: "generation-alpha",
        openshellDriver: "docker",
      }),
    );
    h.hasPortableLifecycleReceipt.mockReturnValue(true);
    h.stopPortableSandbox.mockImplementation((_name, _context, beforeStop) => {
      beforeStop();
      return { kind: "stopped" };
    });

    expect(stopSandbox("my-sandbox", h.deps)).toEqual({ exitCode: 0 });

    expect(h.isDockerRuntimeDown).not.toHaveBeenCalled();
    expect(h.stopPortableSandbox).toHaveBeenCalledWith(
      "my-sandbox",
      expect.objectContaining({ lifecycleGeneration: "generation-alpha" }),
      expect.any(Function),
      expect.objectContaining({ env: process.env }),
    );
    expect(h.stopSandboxChannels).toHaveBeenCalledExactlyOnceWith("my-sandbox", expect.any(Object));
    expect(h.findLabeledSandboxContainers).not.toHaveBeenCalled();
    expect(h.dockerStop).not.toHaveBeenCalled();
  });

  it("keeps active Hermes stop out of Docker and Docker-capable channel transport (#9203)", () => {
    const unloadOllamaModels = vi.fn(() => successfulUnload());
    const h = harness({ unloadOllamaModels });
    h.getSandbox.mockReturnValue(
      sandbox({
        agent: "hermes",
        gatewayName: "nemoclaw",
        lifecycleGeneration: "generation-alpha",
        lifecycleLiveIdentityFingerprint: "identity-alpha",
        model: "qwen2.5:7b",
        openshellDriver: "docker",
        provider: "ollama/qwen3-vl:4b",
      }),
    );
    h.hasPortableLifecycleReceipt.mockReturnValue(true);
    h.stopPortableSandbox.mockReturnValue({ kind: "stopped", portableAgent: "hermes" });

    expect(stopSandbox("my-sandbox", h.deps)).toEqual({ exitCode: 0 });

    expect(h.isDockerRuntimeDown).not.toHaveBeenCalled();
    expect(h.stopSandboxChannels).not.toHaveBeenCalled();
    expect(h.findLabeledSandboxContainers).not.toHaveBeenCalled();
    expect(h.dockerStop).not.toHaveBeenCalled();
    expect(h.teardownSandboxDashboardForward).not.toHaveBeenCalled();
    expect(unloadOllamaModels).toHaveBeenCalledWith(["qwen2.5:7b"]);
  });

  it("keeps a shared Ollama model loaded after a verified Hermes stop (#10074)", () => {
    const unloadOllamaModels = vi.fn(() => successfulUnload());
    const hermesSandbox = sandbox({
      agent: "hermes",
      gatewayName: "nemoclaw",
      lifecycleGeneration: "generation-alpha",
      lifecycleLiveIdentityFingerprint: "identity-alpha",
      model: "qwen2.5:7b",
      openshellDriver: "docker",
      provider: "ollama/qwen3-vl:4b",
    });
    const peer = sandbox({ model: "qwen2.5:7b", name: "peer", provider: "ollama-local" });
    const h = harness({
      listSandboxes: () => ({ sandboxes: [hermesSandbox, peer], defaultSandbox: null }),
      unloadOllamaModels,
    });
    h.getSandbox.mockReturnValue(hermesSandbox);
    h.hasPortableLifecycleReceipt.mockReturnValue(true);
    h.stopPortableSandbox.mockReturnValue({ kind: "stopped", portableAgent: "hermes" });

    expect(stopSandbox("my-sandbox", h.deps)).toEqual({ exitCode: 0 });
    expect(unloadOllamaModels).not.toHaveBeenCalled();
  });

  it("succeeds idempotently when the container is already stopped (#6026)", () => {
    const h = harness();
    h.findLabeledSandboxContainers.mockReturnValue([container("openshell-my-sandbox", false)]);

    const result = stopSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(0);
    expect(h.dockerStop).not.toHaveBeenCalled();
    const output = h.log.mock.calls.map(([line]) => line).join("\n");
    expect(output).toContain("already stopped");
  });

  it("stops a crash-looping container instead of calling it stopped (#6026)", () => {
    const h = harness();
    h.findLabeledSandboxContainers.mockReturnValue([
      {
        name: "openshell-my-sandbox",
        status: "Restarting (137) 2 seconds ago",
        running: false,
      },
    ]);

    const result = stopSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(0);
    expect(h.dockerStop).toHaveBeenCalledWith("openshell-my-sandbox", {
      ignoreError: true,
      timeout: 30_000,
    });
  });

  it("stops a paused container (#6026)", () => {
    const h = harness();
    h.findLabeledSandboxContainers.mockReturnValue([
      {
        name: "openshell-my-sandbox",
        status: "Up 5 minutes (Paused)",
        running: true,
      },
    ]);

    const result = stopSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(0);
    expect(h.dockerStop).toHaveBeenCalledTimes(1);
  });

  it("stops every running labeled container, including backup siblings (#6026)", () => {
    const h = harness();
    h.findLabeledSandboxContainers.mockReturnValue([
      container("openshell-my-sandbox", true),
      container("openshell-my-sandbox-nemoclaw-gpu-backup-1700000000000", true),
    ]);

    const result = stopSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(0);
    expect(h.dockerStop).toHaveBeenCalledTimes(2);
  });

  it("continues to docker stop when the graceful channel stop throws (#6026)", () => {
    const h = harness();
    h.stopSandboxChannels.mockImplementation(() => {
      throw new Error("gateway unreachable");
    });

    const result = stopSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(0);
    expect(h.dockerStop).toHaveBeenCalledTimes(1);
    const warned = h.warn.mock.calls.map(([line]) => line).join("\n");
    expect(warned).toContain("gateway unreachable");
  });

  it("names the Docker daemon outage instead of claiming the container was removed (#6026)", () => {
    const h = harness();
    h.isDockerRuntimeDown.mockReturnValue(true);

    const result = stopSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(1);
    expect(result.message).toBeUndefined();
    expect(h.printDockerRuntimeDownGuidance).toHaveBeenCalledWith("my-sandbox", {
      retryCommand: "stop",
    });
    expect(h.findLabeledSandboxContainers).not.toHaveBeenCalled();
    expect(h.dockerStop).not.toHaveBeenCalled();
  });

  it("fails with a rebuild hint when no labeled container exists (#6026)", () => {
    const h = harness();
    h.findLabeledSandboxContainers.mockReturnValue([]);

    const result = stopSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("No Docker container");
    expect(result.message).toContain("rebuild");
    expect(h.dockerStop).not.toHaveBeenCalled();
  });

  it("refuses an unregistered sandbox (#6026)", () => {
    const h = harness();
    h.getSandbox.mockReturnValue(null);

    const result = stopSandbox("ghost", h.deps);

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("not registered");
    expect(h.findLabeledSandboxContainers).not.toHaveBeenCalled();
  });

  it("refuses non-direct drivers instead of guessing at container control (#6026)", () => {
    const h = harness();
    h.getSandbox.mockReturnValue(sandbox({ openshellDriver: "kubernetes" }));

    const result = stopSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("kubernetes");
    expect(result.message).toContain("does not authorize 'stop' mutation");
    expect(h.stopSandboxChannels).not.toHaveBeenCalled();
    expect(h.findLabeledSandboxContainers).not.toHaveBeenCalled();
    expect(h.dockerStop).not.toHaveBeenCalled();
    expect(h.teardownSandboxDashboardForward).not.toHaveBeenCalled();
  });

  it.each(["unknown-runtime", "mxc-not-installed"])(
    "fails closed for unregistered provider %s without lifecycle side effects",
    (providerId) => {
      const h = harness();
      h.getSandbox.mockReturnValue(sandbox({ openshellDriver: providerId }));

      const result = stopSandbox("my-sandbox", h.deps);

      expect(result.exitCode).toBe(1);
      expect(result.message).toContain(providerId);
      expect(result.message).toContain("has no registered lifecycle provider");
      expect(h.stopSandboxChannels).not.toHaveBeenCalled();
      expect(h.findLabeledSandboxContainers).not.toHaveBeenCalled();
      expect(h.dockerStop).not.toHaveBeenCalled();
      expect(h.teardownSandboxDashboardForward).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["null driver", sandbox({ openshellDriver: null })],
    ["docker driver", sandbox({ openshellDriver: "docker" })],
    ["vm driver", sandbox({ openshellDriver: "vm" })],
  ])("allows the %s like privileged exec does (#6026)", (_label, entry) => {
    const h = harness();
    h.getSandbox.mockReturnValue(entry);

    const result = stopSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(0);
  });

  it("surfaces a docker stop failure with the container name (#6026)", () => {
    const h = harness();
    h.dockerStop.mockReturnValue({ status: 125 });

    const result = stopSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("openshell-my-sandbox");
    expect(result.message).toContain("125");
  });

  it("attempts every container and aggregates failures when one stop fails (#6026)", () => {
    const h = harness();
    h.findLabeledSandboxContainers.mockReturnValue([
      container("openshell-my-sandbox", true),
      container("openshell-my-sandbox-nemoclaw-gpu-backup-1700000000000", true),
    ]);
    // First container fails to stop; the sibling still must be attempted.
    h.dockerStop.mockReturnValueOnce({ status: 137 }).mockReturnValueOnce({ status: 0 });

    const result = stopSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(1);
    expect(h.dockerStop).toHaveBeenCalledTimes(2);
    expect(h.teardownSandboxDashboardForward).not.toHaveBeenCalled();
    expect(h.dockerStop).toHaveBeenNthCalledWith(
      2,
      "openshell-my-sandbox-nemoclaw-gpu-backup-1700000000000",
      {
        ignoreError: true,
        timeout: 30_000,
      },
    );
    expect(result.message).toContain("openshell-my-sandbox");
    expect(result.message).toContain("137");
    expect(result.message).not.toContain("gpu-backup");
  });

  it("never removes containers or touches the registry entry (#6026)", () => {
    const h = harness();

    stopSandbox("my-sandbox", h.deps);

    // The deps surface has no removal lever at all; assert the only docker
    // mutation issued is the stop of the labeled container.
    expect(h.dockerStop.mock.calls).toEqual([
      ["openshell-my-sandbox", { ignoreError: true, timeout: 30_000 }],
    ]);
  });
});

describe("stopSandbox Ollama GPU release", () => {
  const ollamaSandbox = sandbox({ model: "qwen2.5:7b", provider: "ollama-local" });

  function registryOf(...sandboxes: SandboxEntry[]) {
    return () => ({ sandboxes, defaultSandbox: null });
  }

  it("unloads the sandbox's own model so a stop frees GPU memory (#9110)", () => {
    const unloadOllamaModels = vi.fn(() => successfulUnload());
    const h = harness({ listSandboxes: registryOf(ollamaSandbox), unloadOllamaModels });
    h.getSandbox.mockReturnValue(ollamaSandbox);

    const result = stopSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(0);
    expect(unloadOllamaModels).toHaveBeenCalledWith(["qwen2.5:7b"]);
  });

  it("holds the shared ownership lock across the peer scan and unload (#9110)", () => {
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

    stopSandbox("my-sandbox", h.deps);

    expect(events).toEqual(["ownership-lock-enter", "peer-scan", "unload", "ownership-lock-exit"]);
  });

  it("releases GPU memory on an already-stopped sandbox too (#9110)", () => {
    const unloadOllamaModels = vi.fn(() => successfulUnload());
    const h = harness({
      findLabeledSandboxContainers: () => [container("openshell-my-sandbox", false)],
      listSandboxes: registryOf(ollamaSandbox),
      unloadOllamaModels,
    });
    h.getSandbox.mockReturnValue(ollamaSandbox);

    const result = stopSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(0);
    expect(unloadOllamaModels).toHaveBeenCalledWith(["qwen2.5:7b"]);
  });

  it("never unloads a model a sibling Ollama sandbox also uses (#9110)", () => {
    const unloadOllamaModels = vi.fn(() => successfulUnload());
    const peer = sandbox({ model: "qwen2.5:7b", name: "peer", provider: "ollama-local" });
    const h = harness({
      listSandboxes: registryOf(ollamaSandbox, peer),
      unloadOllamaModels,
    });
    h.getSandbox.mockReturnValue(ollamaSandbox);

    const result = stopSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(0);
    expect(unloadOllamaModels).not.toHaveBeenCalled();
    expect(h.log).toHaveBeenCalledWith(
      "  Ollama model 'qwen2.5:7b' remains loaded for active sandbox: peer.",
    );
  });

  it("never unloads a model a compatible local endpoint sibling also uses", () => {
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

    const result = stopSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(0);
    expect(unloadOllamaModels).not.toHaveBeenCalled();
  });

  it("ignores a stopped sibling registry row and releases the exclusive model (#10074)", () => {
    const unloadOllamaModels = vi.fn(() => successfulUnload());
    const stoppedPeer = sandbox({
      model: "qwen2.5:7b",
      name: "stopped-peer",
      provider: "ollama-local",
    });
    const h = harness({
      discoverActiveOllamaSandboxNames: () => ({
        ok: true,
        activeSandboxNames: new Set(),
        gatewayChecks: [{ activeSandboxes: [], gateway: "nemoclaw" }],
      }),
      listSandboxes: registryOf(ollamaSandbox, stoppedPeer),
      unloadOllamaModels,
    });
    h.getSandbox.mockReturnValue(ollamaSandbox);

    expect(stopSandbox("my-sandbox", h.deps)).toEqual({ exitCode: 0 });
    expect(unloadOllamaModels).toHaveBeenCalledWith(["qwen2.5:7b"]);
    expect(h.log).toHaveBeenCalledWith(
      "  Ollama ownership ignored stopped or incomplete registry row: stopped-peer.",
    );
  });

  it("fails without unloading when active sibling discovery is unavailable (#10074)", () => {
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

    const result = stopSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("ownership could not be verified");
    expect(result.message).toContain("OpenShell sandbox list timed out");
    expect(unloadOllamaModels).not.toHaveBeenCalled();
    expect(h.teardownSandboxDashboardForward).toHaveBeenCalledWith("my-sandbox");
  });

  it.each([
    ["an implicit latest tag", "llama3", "llama3:latest"],
    ["an explicit latest tag", "llama3:latest", "llama3"],
  ])("protects a sibling recorded with %s (#9110)", (_label, ownModel, peerModel) => {
    const unloadOllamaModels = vi.fn(() => successfulUnload());
    const own = sandbox({ model: ownModel, provider: "ollama-local" });
    const peer = sandbox({ model: peerModel, name: "peer", provider: "ollama-local" });
    const h = harness({ listSandboxes: registryOf(own, peer), unloadOllamaModels });
    h.getSandbox.mockReturnValue(own);

    stopSandbox("my-sandbox", h.deps);

    expect(unloadOllamaModels).not.toHaveBeenCalled();
  });

  it("still releases its own model when a sibling holds a different one (#9110)", () => {
    const unloadOllamaModels = vi.fn(() => successfulUnload());
    const peer = sandbox({ model: "llama3:8b", name: "peer", provider: "ollama-local" });
    const h = harness({
      listSandboxes: registryOf(ollamaSandbox, peer),
      unloadOllamaModels,
    });
    h.getSandbox.mockReturnValue(ollamaSandbox);

    stopSandbox("my-sandbox", h.deps);

    expect(unloadOllamaModels).toHaveBeenCalledWith(["qwen2.5:7b"]);
  });

  it.each([
    ["nvidia-prod", sandbox({ model: "qwen2.5:7b", provider: "nvidia-prod" })],
    ["vllm-local", sandbox({ model: "qwen2.5:7b", provider: "vllm-local" })],
    ["an unrecorded provider", sandbox({ model: "qwen2.5:7b" })],
    ["an unrecorded model", sandbox({ provider: "ollama-local" })],
  ])("leaves %s sandboxes untouched (#9110)", (_label, entry) => {
    const unloadOllamaModels = vi.fn(() => successfulUnload());
    const h = harness({ listSandboxes: registryOf(entry), unloadOllamaModels });
    h.getSandbox.mockReturnValue(entry);

    const result = stopSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(0);
    expect(unloadOllamaModels).not.toHaveBeenCalled();
  });

  it("returns an actionable failure when the unload throws (#10074)", () => {
    const unloadOllamaModels = vi.fn(() => {
      throw new Error("curl: command not found");
    });
    const h = harness({ listSandboxes: registryOf(ollamaSandbox), unloadOllamaModels });
    h.getSandbox.mockReturnValue(ollamaSandbox);

    const result = stopSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("curl: command not found");
    expect(result.message).toContain("retry 'nemoclaw my-sandbox stop'");
  });

  it.each([
    ["a rejected unload request", failedUnload("unload-request-failed", "HTTP 500")],
    ["a model that remains resident", failedUnload("still-resident", "still loaded")],
    ["a failed post-release discovery", failedUnload("discovery-failed", "malformed JSON")],
  ])("returns a nonzero stop for %s (#10074)", (_label, unloadResult) => {
    const h = harness({
      listSandboxes: registryOf(ollamaSandbox),
      unloadOllamaModels: () => unloadResult,
    });
    h.getSandbox.mockReturnValue(ollamaSandbox);

    const result = stopSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain(unloadResult.outcome);
    expect(result.message).toContain("after 3 bounded attempts");
    expect(result.message).toContain("ollama stop qwen2.5:7b");
    expect(h.teardownSandboxDashboardForward).toHaveBeenCalledWith("my-sandbox");
  });

  it("skips the unload when the stop itself failed (#9110)", () => {
    const unloadOllamaModels = vi.fn(() => successfulUnload());
    const h = harness({ listSandboxes: registryOf(ollamaSandbox), unloadOllamaModels });
    h.getSandbox.mockReturnValue(ollamaSandbox);
    h.dockerStop.mockReturnValue({ status: 125 });

    const result = stopSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(1);
    expect(unloadOllamaModels).not.toHaveBeenCalled();
  });
});
