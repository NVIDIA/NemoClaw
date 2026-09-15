// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { SandboxEntry } from "../../state/registry";
import { SANDBOX_PROVIDER_SUFFIXES } from "../../onboard/sandbox-provider-cleanup";
import { assertUnambiguousDestroyContainerIdentity, cleanupSandboxServices } from "./destroy";

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
        listSandboxes: () => ({ sandboxes: [], defaultSandbox: null }),
        withOllamaModelOwnershipLock: (operation) => operation(),
        loadPersistedOllamaHost: () => "127.0.0.1",
        loadPendingOllamaModelCleanup: () => [],
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
    const stopGooglechatWebhookTunnel = vi.fn(() => googlechatPidDir);
    const googlechatWebhookTunnelPidDir = vi.fn(() => googlechatPidDir);

    await cleanupSandboxServices(
      SANDBOX,
      { stopHostServices: true },
      {
        stopAll: vi.fn(),
        getSandbox: vi.fn(() => null),
        rmSync,
        runOpenshell: vi.fn(() => ({ status: 0 })),
        stopGooglechatWebhookTunnel,
        googlechatWebhookTunnelPidDir,
      },
    );

    expect(rmSync).toHaveBeenCalledWith(googlechatPidDir, { recursive: true, force: true });
  });
});

describe("cleanupSandboxServices Ollama ownership", () => {
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
        listSandboxes: () => ({ sandboxes: [own, peer], defaultSandbox: null }),
        loadPersistedOllamaHost: () => "127.0.0.1",
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
