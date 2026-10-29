// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as openshellRuntime from "../../adapters/openshell/runtime";
import type { SandboxEntry } from "../../state/registry";
import { SANDBOX_PROVIDER_SUFFIXES } from "../../onboard/sandbox-provider-cleanup";
import { assertUnambiguousDestroyContainerIdentity, cleanupSandboxServices } from "./destroy";
import {
  createDestroyHarness,
  resetDestroyModuleCache,
} from "../../../../test/helpers/destroy-flow-test-harness";

afterEach(() => vi.restoreAllMocks());

const SANDBOX = "mybox";
const mainPidDir = path.resolve("/tmp", `nemoclaw-services-${SANDBOX}`);
const googlechatPidDir = `${mainPidDir}-googlechat`;

describe("cleanupSandboxServices Google Chat tunnel cleanup (#7317)", () => {
  it("deletes every messaging and search registration through the selected gateway", async () => {
    const runOpenshell = vi.fn(() => ({ status: 0 }));

    await cleanupSandboxServices(
      SANDBOX,
      { stopHostServices: false },
      {
        getSandbox: () => null,
        withOllamaModelOwnershipLock: (operation) => operation(),
        loadPersistedOllamaHost: () => "127.0.0.1",
        loadPendingOllamaModelCleanup: () => [],
        migrateLegacyCloudflaredState: vi.fn(() => false),
        rmSync: vi.fn(),
        runOpenshell,
        stopGooglechatWebhookTunnel: vi.fn(() => googlechatPidDir),
        googlechatWebhookTunnelPidDir: vi.fn(() => googlechatPidDir),
      },
    );

    expect(runOpenshell.mock.calls).toEqual(
      SANDBOX_PROVIDER_SUFFIXES.map((suffix) => [
        ["provider", "delete", `${SANDBOX}-${suffix}`],
        expect.objectContaining({
          ignoreError: true,
          suppressOutput: true,
          stdio: ["ignore", "pipe", "pipe"],
        }),
      ]),
    );
  });

  it("fails closed before later cleanup when the Google Chat tunnel cannot stop", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rmSync = vi.fn();
    const runOpenshell = vi.fn(() => ({ status: 0 }));
    const stopAll = vi.fn();
    const getSandbox = vi.fn(() => null);
    const googlechatWebhookTunnelPidDir = vi.fn(() => googlechatPidDir);
    const stopGooglechatWebhookTunnel = vi.fn(() => {
      throw new Error("cloudflared refused to stop");
    });

    await expect(
      cleanupSandboxServices(
        SANDBOX,
        { stopHostServices: true },
        {
          stopAll,
          getSandbox,
          migrateLegacyCloudflaredState: vi.fn(() => false),
          rmSync,
          runOpenshell,
          stopGooglechatWebhookTunnel,
          googlechatWebhookTunnelPidDir,
        },
      ),
    ).rejects.toThrow(/public Google Chat webhook endpoint may still be running/);

    expect(googlechatWebhookTunnelPidDir).toHaveBeenCalledWith(mainPidDir);
    // Preserve both PID directories and refuse every later side effect so a
    // repeated destroy can still prove and stop the public endpoint.
    expect(rmSync).not.toHaveBeenCalled();
    expect(stopAll).not.toHaveBeenCalled();
    expect(getSandbox).not.toHaveBeenCalled();
    expect(runOpenshell).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
  });

  it("removes the Google Chat PID directory after a successful tunnel stop", async () => {
    const rmSync = vi.fn();
    const stopAll = vi.fn();
    const migrateLegacyCloudflaredState = vi.fn(() => false);
    const stopGooglechatWebhookTunnel = vi.fn(() => googlechatPidDir);
    const googlechatWebhookTunnelPidDir = vi.fn(() => googlechatPidDir);

    await cleanupSandboxServices(
      SANDBOX,
      { stopHostServices: true, channelStopTransport: "openshell", gatewayPort: 18_080 },
      {
        stopAll,
        migrateLegacyCloudflaredState,
        getSandbox: vi.fn(() => null),
        rmSync,
        runOpenshell: vi.fn(() => ({ status: 0 })),
        stopGooglechatWebhookTunnel,
        googlechatWebhookTunnelPidDir,
      },
    );

    expect(rmSync).toHaveBeenCalledWith(googlechatPidDir, { recursive: true, force: true });
    expect(migrateLegacyCloudflaredState).toHaveBeenCalledTimes(1);
    expect(migrateLegacyCloudflaredState).toHaveBeenCalledWith(
      { sandboxName: SANDBOX, gatewayPort: 18_080 },
      { recoverySandboxName: SANDBOX },
    );
    expect(stopAll).toHaveBeenCalledWith(
      expect.objectContaining({
        channelStopTransport: "openshell",
        sandboxName: SANDBOX,
        stopCloudflared: false,
      }),
    );
  });
});

describe("cleanupSandboxServices Ollama ownership", () => {
  it("discovers two pending models in one gateway once and keeps cleanup fail-closed", async () => {
    const own = {
      name: SANDBOX,
      gatewayName: "gateway-a",
      gatewayPort: 18080,
      provider: "nvidia-prod",
      model: "replacement",
    } as SandboxEntry;
    const activePeer = {
      name: "active-peer",
      gatewayName: "gateway-b",
      gatewayPort: 18081,
      provider: "ollama-local",
      model: "old-model",
    } as SandboxEntry;
    const stoppedPeer = {
      ...activePeer,
      name: "stopped-peer",
      model: "other-model",
    };
    const captureSandboxOwnershipPhases = vi
      .fn()
      .mockReturnValueOnce({
        status: 0,
        output: "NAME CREATED PHASE\nactive-peer 2026-01-01 Running",
      })
      .mockReturnValue({
        status: 0,
        output:
          "NAME CREATED PHASE\nactive-peer 2026-01-01 Running\nstopped-peer 2026-01-01 Stopped",
      });
    const unloadOllamaModels = vi.fn();
    const clearPendingOllamaModelCleanup = vi.fn();
    const cleanup = () =>
      cleanupSandboxServices(
        SANDBOX,
        { stopHostServices: false, gatewayPort: 18080 },
        {
          getSandbox: () => own,
          listOllamaModelOwnershipPeers: () => [own, activePeer, stoppedPeer],
          loadPersistedOllamaHost: () => "127.0.0.1",
          loadPendingOllamaModelCleanup: () => ["old-model", "other-model"],
          clearPendingOllamaModelCleanup,
          captureSandboxOwnershipPhases,
          resolvePersistedSandboxOwnershipGateway: () => "gateway-b",
          migrateLegacyCloudflaredState: vi.fn(() => false),
          unloadOllamaModels,
          withOllamaModelOwnershipLock: (operation) => operation(),
          rmSync: vi.fn(),
          runOpenshell: vi.fn(() => ({ status: 0 })),
          stopGooglechatWebhookTunnel: vi.fn(() => googlechatPidDir),
          googlechatWebhookTunnelPidDir: vi.fn(() => googlechatPidDir),
        },
      );

    await expect(cleanup()).rejects.toThrow(/omitted sibling/);
    expect(captureSandboxOwnershipPhases).toHaveBeenCalledTimes(1);
    expect(unloadOllamaModels).not.toHaveBeenCalled();
    expect(clearPendingOllamaModelCleanup).not.toHaveBeenCalled();

    await cleanup();
    expect(captureSandboxOwnershipPhases).toHaveBeenCalledTimes(2);
    expect(unloadOllamaModels).toHaveBeenCalledExactlyOnceWith(["other-model"]);
    expect(clearPendingOllamaModelCleanup).toHaveBeenCalledExactlyOnceWith(own, ["other-model"]);
  });

  it("retains a pending model owned by an active sandbox in another gateway root", async () => {
    const own = {
      name: SANDBOX,
      gatewayName: "gateway-a",
      gatewayPort: 18080,
      provider: "ollama-local",
      model: "old-model",
    } as SandboxEntry;
    const peer = {
      name: "peer",
      gatewayName: "gateway-b",
      gatewayPort: 18081,
      provider: "ollama-local",
      model: "old-model",
    } as SandboxEntry;
    const unloadOllamaModels = vi.fn();
    const clearPendingOllamaModelCleanup = vi.fn();
    const captureSandboxOwnershipPhases = vi
      .spyOn(openshellRuntime, "captureSandboxPhasesForGateway")
      .mockReturnValue({ status: 0, output: "NAME CREATED PHASE\npeer 2026-01-01 Running" });
    const runOpenshell = vi.fn(() => ({ status: 0 }));

    await cleanupSandboxServices(
      SANDBOX,
      { stopHostServices: false, gatewayPort: 18080 },
      {
        getSandbox: () => own,
        listOllamaModelOwnershipPeers: () => [own, peer],
        loadPersistedOllamaHost: () => "127.0.0.1",
        loadPendingOllamaModelCleanup: () => ["old-model"],
        clearPendingOllamaModelCleanup,
        resolvePersistedSandboxOwnershipGateway: (sandbox) =>
          sandbox.gatewayName === "gateway-b" ? "gateway-b" : "gateway-a",
        migrateLegacyCloudflaredState: vi.fn(() => false),
        unloadOllamaModels,
        withOllamaModelOwnershipLock: (operation) => operation(),
        rmSync: vi.fn(),
        runOpenshell,
        stopGooglechatWebhookTunnel: vi.fn(() => googlechatPidDir),
        googlechatWebhookTunnelPidDir: vi.fn(() => googlechatPidDir),
      },
    );

    expect(captureSandboxOwnershipPhases).toHaveBeenCalledWith("gateway-b", process.env);
    expect(unloadOllamaModels).not.toHaveBeenCalled();
    expect(clearPendingOllamaModelCleanup).not.toHaveBeenCalled();
  });

  it("fails closed when shared phase capture reports an unreachable gateway", async () => {
    const own = {
      name: SANDBOX,
      gatewayName: "gateway-a",
      gatewayPort: 18080,
      provider: "ollama-local",
      model: "old-model",
    } as SandboxEntry;
    const peer = {
      name: "peer",
      gatewayName: "gateway-b",
      gatewayPort: 18081,
      provider: "ollama-local",
      model: "old-model",
    } as SandboxEntry;
    const unloadOllamaModels = vi.fn();
    const clearPendingOllamaModelCleanup = vi.fn();
    const captureSandboxOwnershipPhases = vi
      .spyOn(openshellRuntime, "captureSandboxPhasesForGateway")
      .mockReturnValue({ status: 1, output: "gateway unreachable" });
    const runOpenshell = vi.fn(() => ({ status: 0 }));

    await expect(
      cleanupSandboxServices(
        SANDBOX,
        { stopHostServices: false, gatewayPort: 18080 },
        {
          getSandbox: () => own,
          listOllamaModelOwnershipPeers: () => [own, peer],
          loadPersistedOllamaHost: () => "127.0.0.1",
          loadPendingOllamaModelCleanup: () => ["old-model"],
          clearPendingOllamaModelCleanup,
          resolvePersistedSandboxOwnershipGateway: (sandbox) =>
            sandbox.gatewayName === "gateway-b" ? "gateway-b" : "gateway-a",
          migrateLegacyCloudflaredState: vi.fn(() => false),
          unloadOllamaModels,
          withOllamaModelOwnershipLock: (operation) => operation(),
          rmSync: vi.fn(),
          runOpenshell,
          stopGooglechatWebhookTunnel: vi.fn(() => googlechatPidDir),
          googlechatWebhookTunnelPidDir: vi.fn(() => googlechatPidDir),
        },
      ),
    ).rejects.toThrow(/gateway unreachable/);

    expect(captureSandboxOwnershipPhases).toHaveBeenCalledWith("gateway-b", process.env);
    expect(unloadOllamaModels).not.toHaveBeenCalled();
    expect(clearPendingOllamaModelCleanup).not.toHaveBeenCalled();
  });

  it("preserves pending cleanup and fails closed when cross-gateway ownership is inconclusive", async () => {
    const own = {
      name: SANDBOX,
      gatewayName: "gateway-a",
      gatewayPort: 18080,
      provider: "ollama-local",
      model: "old-model",
    } as SandboxEntry;
    const peer = {
      name: "peer",
      gatewayName: "gateway-b",
      gatewayPort: 18081,
      provider: "ollama-local",
      model: "old-model",
    } as SandboxEntry;
    const unloadOllamaModels = vi.fn();
    const clearPendingOllamaModelCleanup = vi.fn();

    await expect(
      cleanupSandboxServices(
        SANDBOX,
        { stopHostServices: false, gatewayPort: 18080 },
        {
          getSandbox: () => own,
          listOllamaModelOwnershipPeers: () => [own, peer],
          loadPersistedOllamaHost: () => "127.0.0.1",
          loadPendingOllamaModelCleanup: () => ["old-model"],
          clearPendingOllamaModelCleanup,
          captureSandboxOwnershipPhases: () => ({ status: 1, output: "gateway unavailable" }),
          resolvePersistedSandboxOwnershipGateway: (sandbox) =>
            sandbox.gatewayName === "gateway-b" ? "gateway-b" : "gateway-a",
          migrateLegacyCloudflaredState: vi.fn(() => false),
          unloadOllamaModels,
          withOllamaModelOwnershipLock: (operation) => operation(),
          rmSync: vi.fn(),
          runOpenshell: vi.fn(() => ({ status: 0 })),
          stopGooglechatWebhookTunnel: vi.fn(() => googlechatPidDir),
          googlechatWebhookTunnelPidDir: vi.fn(() => googlechatPidDir),
        },
      ),
    ).rejects.toThrow(/ownership could not be verified/);

    expect(unloadOllamaModels).not.toHaveBeenCalled();
    expect(clearPendingOllamaModelCleanup).not.toHaveBeenCalled();
  });

  it("scopes host-service model cleanup when another gateway owns a model", async () => {
    const own = {
      name: SANDBOX,
      gatewayName: "gateway-a",
      gatewayPort: 18080,
      provider: "ollama-local",
      model: "old-model",
    } as SandboxEntry;
    const peer = {
      name: "peer",
      gatewayName: "gateway-b",
      gatewayPort: 18081,
      provider: "ollama-local",
      model: "old-model",
    } as SandboxEntry;
    const unloadOllamaModels = vi.fn();
    const clearPendingOllamaModelCleanup = vi.fn();
    const stopAll = vi.fn();

    await cleanupSandboxServices(
      SANDBOX,
      { stopHostServices: true, gatewayPort: 18080 },
      {
        getSandbox: () => own,
        listOllamaModelOwnershipPeers: () => [own, peer],
        loadPersistedOllamaHost: () => "127.0.0.1",
        loadPendingOllamaModelCleanup: () => [],
        clearPendingOllamaModelCleanup,
        captureSandboxOwnershipPhases: () => ({
          status: 0,
          output: "NAME CREATED PHASE\npeer 2026-01-01 Running",
        }),
        resolvePersistedSandboxOwnershipGateway: (sandbox) =>
          sandbox.gatewayName === "gateway-b" ? "gateway-b" : "gateway-a",
        migrateLegacyCloudflaredState: vi.fn(() => false),
        stopAll,
        unloadOllamaModels,
        withOllamaModelOwnershipLock: (operation) => operation(),
        rmSync: vi.fn(),
        runOpenshell: vi.fn(() => ({ status: 0 })),
        stopGooglechatWebhookTunnel: vi.fn(() => googlechatPidDir),
        googlechatWebhookTunnelPidDir: vi.fn(() => googlechatPidDir),
      },
    );

    expect(stopAll).toHaveBeenCalledWith(
      expect.objectContaining({ cleanupOllamaModels: false, stopCloudflared: false }),
    );
    expect(unloadOllamaModels).not.toHaveBeenCalled();
    expect(clearPendingOllamaModelCleanup).not.toHaveBeenCalled();
  });

  it("retains retry state when host-service cleanup cannot verify a peer", async () => {
    const own = {
      name: SANDBOX,
      gatewayName: "gateway-a",
      gatewayPort: 18080,
      provider: "ollama-local",
      model: "old-model",
    } as SandboxEntry;
    const peer = {
      name: "peer",
      gatewayName: "gateway-b",
      gatewayPort: 18081,
      provider: "ollama-local",
      model: "old-model",
    } as SandboxEntry;
    const unloadOllamaModels = vi.fn();
    const clearPendingOllamaModelCleanup = vi.fn();
    const stopAll = vi.fn();

    await expect(
      cleanupSandboxServices(
        SANDBOX,
        { stopHostServices: true, gatewayPort: 18080 },
        {
          getSandbox: () => own,
          listOllamaModelOwnershipPeers: () => [own, peer],
          loadPersistedOllamaHost: () => "127.0.0.1",
          loadPendingOllamaModelCleanup: () => ["old-model"],
          clearPendingOllamaModelCleanup,
          captureSandboxOwnershipPhases: () => ({
            status: 1,
            output: "gateway unavailable",
          }),
          resolvePersistedSandboxOwnershipGateway: (sandbox) =>
            sandbox.gatewayName === "gateway-b" ? "gateway-b" : "gateway-a",
          migrateLegacyCloudflaredState: vi.fn(() => false),
          stopAll,
          unloadOllamaModels,
          withOllamaModelOwnershipLock: (operation) => operation(),
          rmSync: vi.fn(),
          runOpenshell: vi.fn(() => ({ status: 0 })),
          stopGooglechatWebhookTunnel: vi.fn(() => googlechatPidDir),
          googlechatWebhookTunnelPidDir: vi.fn(() => googlechatPidDir),
        },
      ),
    ).rejects.toThrow(/Host-service cleanup failed.*ownership could not be verified/);

    expect(stopAll).toHaveBeenCalledWith(
      expect.objectContaining({ cleanupOllamaModels: false, stopCloudflared: false }),
    );
    expect(unloadOllamaModels).not.toHaveBeenCalled();
    expect(clearPendingOllamaModelCleanup).not.toHaveBeenCalled();
  });

  it("retains pending cleanup when the unload request fails", async () => {
    const own = {
      name: SANDBOX,
      gatewayName: "gateway-a",
      gatewayPort: 18080,
      provider: "ollama-local",
      model: "old-model",
    } as SandboxEntry;
    const unloadOllamaModels = vi.fn(() => ({
      ok: false,
      outcome: "still-resident" as const,
      endpoint: "http://127.0.0.1:11434",
      selectedModels: ["old-model"],
      discoveries: [],
      requests: [],
    }));
    const clearPendingOllamaModelCleanup = vi.fn();

    await expect(
      cleanupSandboxServices(
        SANDBOX,
        { stopHostServices: false, gatewayPort: 18080 },
        {
          getSandbox: () => own,
          listOllamaModelOwnershipPeers: () => [own],
          loadPersistedOllamaHost: () => "127.0.0.1",
          loadPendingOllamaModelCleanup: () => ["old-model"],
          clearPendingOllamaModelCleanup,
          migrateLegacyCloudflaredState: vi.fn(() => false),
          unloadOllamaModels,
          withOllamaModelOwnershipLock: (operation) => operation(),
          rmSync: vi.fn(),
          runOpenshell: vi.fn(() => ({ status: 0 })),
          stopGooglechatWebhookTunnel: vi.fn(() => googlechatPidDir),
          googlechatWebhookTunnelPidDir: vi.fn(() => googlechatPidDir),
        },
      ),
    ).rejects.toThrow(/Ollama model cleanup failed/);

    expect(unloadOllamaModels).toHaveBeenCalledExactlyOnceWith(["old-model"]);
    expect(clearPendingOllamaModelCleanup).not.toHaveBeenCalled();
  });

  it("keeps a model shared through a compatible endpoint at the same local daemon", async () => {
    const own = {
      name: SANDBOX,
      provider: "ollama-local",
      model: "llama3",
    } as SandboxEntry;
    const peer = {
      name: "peer",
      provider: "compatible-endpoint",
      endpointUrl: "http://127.0.0.1:11434/v1",
      model: "llama3:latest",
    } as SandboxEntry;
    const unloadOllamaModels = vi.fn();

    await cleanupSandboxServices(
      SANDBOX,
      { stopHostServices: false },
      {
        getSandbox: () => own,
        listOllamaModelOwnershipPeers: () => [own, peer],
        captureSandboxOwnershipPhases: () => ({
          status: 0,
          output: "NAME CREATED PHASE\npeer 2026-01-01 Running",
        }),
        resolvePersistedSandboxOwnershipGateway: () => "nemoclaw",
        loadPersistedOllamaHost: () => "127.0.0.1",
        migrateLegacyCloudflaredState: vi.fn(() => false),
        unloadOllamaModels,
        withOllamaModelOwnershipLock: (operation) => operation(),
        rmSync: vi.fn(),
        runOpenshell: vi.fn(() => ({ status: 0 })),
        stopGooglechatWebhookTunnel: vi.fn(() => googlechatPidDir),
        googlechatWebhookTunnelPidDir: vi.fn(() => googlechatPidDir),
      },
    );

    expect(unloadOllamaModels).not.toHaveBeenCalled();
  });
});

describe("assertUnambiguousDestroyContainerIdentity (#8999)", () => {
  const dockerSandbox = { openshellDriver: "docker" } as { openshellDriver: string | null };

  it("refuses destroy when a foreign container shares the sandbox-name label", () => {
    const error = vi.fn();
    const classify = vi.fn(() => ({
      status: "ambiguous" as const,
      sandboxName: "destroytest",
      reason: "a foreign container carries the label",
      foreign: [{ id: "ffff", managedBy: "", workspace: "foreign", sandboxId: "" }],
      managed: [{ id: "aaaa", managedBy: "openshell", workspace: "default", sandboxId: "sb" }],
    }));

    const proceed = assertUnambiguousDestroyContainerIdentity("destroytest", {
      providerId: dockerSandbox.openshellDriver ?? "docker",
      redact: String,
      classify: classify as never,
      error,
    });

    expect(proceed).toBe(false);
    expect(classify).toHaveBeenCalledWith("destroytest");
    expect(error).toHaveBeenCalled();
  });

  it("proceeds for a clear single managed identity", () => {
    const identity = {
      id: "aaaa000000000000",
      managedBy: "openshell",
      workspace: "default",
      sandboxId: "sb",
    };
    const classify = vi.fn(() => ({ status: "clear" as const, identity }));
    expect(
      assertUnambiguousDestroyContainerIdentity("destroytest", {
        providerId: dockerSandbox.openshellDriver ?? "docker",
        redact: String,
        classify: classify as never,
      }),
    ).toEqual({ identities: [identity] });
  });

  it("does not probe or block a non-Docker runtime provider", () => {
    const classify = vi.fn();
    const proceed = assertUnambiguousDestroyContainerIdentity("destroytest", {
      providerId: "unregistered-provider",
      redact: String,
      classify: classify as never,
    });
    expect(proceed).toEqual({});
    expect(classify).not.toHaveBeenCalled();
  });

  it("uses provider-owned identity before registry finalization", () => {
    const classify = vi.fn();
    const providerIdentity = {
      schemaVersion: 1 as const,
      providerId: "podman",
      resourceHandle: "a".repeat(64),
      ownershipSha256: "b".repeat(64),
    };
    const captureProviderIdentityByName = vi.fn(() => providerIdentity);

    expect(
      assertUnambiguousDestroyContainerIdentity("destroytest", {
        providerId: "podman",
        redact: String,
        captureProviderIdentityByName,
        classify: classify as never,
      }),
    ).toEqual({ identity: undefined, providerIdentity });
    expect(captureProviderIdentityByName).toHaveBeenCalledWith("destroytest");
    expect(classify).not.toHaveBeenCalled();
  });

  it("uses provider-owned name lookup for a partial registry row", () => {
    const classify = vi.fn();
    const providerIdentity = {
      schemaVersion: 1 as const,
      providerId: "podman",
      resourceHandle: "a".repeat(64),
      ownershipSha256: "b".repeat(64),
    };
    const captureProviderIdentity = vi.fn();
    const captureProviderIdentityByName = vi.fn(() => providerIdentity);
    const sandbox = { name: "destroytest", agent: "openclaw" as const, openshellDriver: null };

    expect(
      assertUnambiguousDestroyContainerIdentity("destroytest", {
        providerId: "podman",
        redact: String,
        sandbox,
        captureProviderIdentity,
        captureProviderIdentityByName,
        classify: classify as never,
      }),
    ).toEqual({ identities: undefined, providerIdentity });
    expect(captureProviderIdentity).not.toHaveBeenCalled();
    expect(captureProviderIdentityByName).toHaveBeenCalledWith("destroytest");
    expect(classify).not.toHaveBeenCalled();
  });

  it("uses a provider-owned destroy identity without the Docker classifier", () => {
    const classify = vi.fn();
    const providerIdentity = {
      schemaVersion: 1 as const,
      providerId: "podman",
      resourceHandle: "a".repeat(64),
      ownershipSha256: "b".repeat(64),
    };
    const captureProviderIdentity = vi.fn(() => providerIdentity);
    const sandbox = { name: "destroytest", agent: "openclaw" as const, openshellDriver: "podman" };

    expect(
      assertUnambiguousDestroyContainerIdentity("destroytest", {
        providerId: "podman",
        redact: String,
        sandbox,
        captureProviderIdentity,
        classify: classify as never,
      }),
    ).toEqual({ identity: undefined, providerIdentity });
    expect(captureProviderIdentity).toHaveBeenCalledWith(sandbox, "destroytest");
    expect(classify).not.toHaveBeenCalled();
  });

  it("refuses when the Docker probe cannot prove identity", () => {
    const error = vi.fn();
    const proceed = assertUnambiguousDestroyContainerIdentity("destroytest", {
      providerId: dockerSandbox.openshellDriver ?? "docker",
      redact: String,
      classify: vi.fn(() => ({ status: "probe-failed" as const, detail: "daemon down" })) as never,
      error,
    });
    expect(proceed).toBe(false);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("daemon down"));
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("No sandbox resources were removed"),
    );
  });

  it("treats an unknown/null driver as Docker (the default) and still guards", () => {
    const classify = vi.fn(() => ({ status: "clear" as const, identity: null }));
    assertUnambiguousDestroyContainerIdentity("destroytest", {
      providerId: "docker",
      redact: String,
      classify: classify as never,
    });
    expect(classify).toHaveBeenCalledWith("destroytest");
  });
});

describe("forced destroy host cleanup", () => {
  it(
    "preserves host resources when --force cannot confirm sandbox deletion",
    { timeout: 30_000 },
    async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-destroy-force-home-"));
      vi.stubEnv("HOME", home);
      try {
        const harness = createDestroyHarness({
          deleteStatus: 1,
          deleteOutput: "connection refused",
        });
        await expect(harness.destroySandbox("alpha", { force: true })).resolves.toBeUndefined();
        expect(harness.unloadOllamaModelsSpy).not.toHaveBeenCalled();
        expect(harness.stopAllSpy).not.toHaveBeenCalled();
        expect(harness.runOpenshellSpy).not.toHaveBeenCalledWith(
          expect.arrayContaining(["provider", "delete"]),
          expect.anything(),
        );
      } finally {
        vi.unstubAllEnvs();
        resetDestroyModuleCache();
        fs.rmSync(home, { force: true, recursive: true });
      }
    },
  );
});
