// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type {
  OllamaModelCleanupOwner,
  OllamaModelHolder,
} from "../inference/ollama/model-ownership";
import type { OllamaUnloadResult } from "../inference/ollama/proxy";
import type { SandboxEntry } from "../state/registry";
import { releaseSupersededOllamaModel, type SetupInferenceDeps } from "./setup-inference";

// Reservation recovery has its own state tests; this suite injects registry writes.
vi.mock("./sandbox-lifecycle", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sandbox-lifecycle")>()),
  releaseAbandonedRouteReservation: vi.fn(() => false),
}));

function createOllamaCleanupHarness(
  options: {
    peers?: readonly SandboxEntry[];
    useProductionPeerSource?: boolean;
    useProductionDiscovery?: boolean;
    activeSandboxNames?: ReadonlySet<string>;
    discovery?: SetupInferenceDeps["discoverActiveOllamaSandboxNames"];
    pendingModels?: readonly string[];
    unloadResult?: OllamaUnloadResult;
  } = {},
) {
  let pendingModels = [...(options.pendingModels ?? [])];
  const localInference = {
    loadPersistedOllamaHost: vi.fn(() => "127.0.0.1"),
    loadPendingOllamaModelCleanup: vi.fn((_owner: OllamaModelCleanupOwner) => pendingModels),
    persistPendingOllamaModelCleanup: vi.fn(
      (_owner: OllamaModelCleanupOwner, models: readonly string[]) => {
        pendingModels = [...new Set([...pendingModels, ...models])];
      },
    ),
    clearPendingOllamaModelCleanup: vi.fn(
      (_owner: OllamaModelCleanupOwner, models: readonly string[]) => {
        pendingModels = pendingModels.filter((model) => !models.includes(model));
      },
    ),
    clearPersistedOllamaHostIfUnused: vi.fn(),
  };
  const unloadOllamaModels = vi.fn(
    () =>
      options.unloadResult ?? {
        ok: true,
        outcome: "released" as const,
        endpoint: "http://127.0.0.1:11434",
        selectedModels: ["qwen2.5:1.5b"],
        discoveries: [],
        requests: [],
      },
  );
  const discoverActiveOllamaSandboxNames = vi.fn(
    options.discovery ??
      (() => ({
        ok: true as const,
        activeSandboxNames: options.activeSandboxNames ?? new Set<string>(),
        gatewayChecks: [],
      })),
  );
  const deps = {
    localInference,
    ...(options.useProductionPeerSource
      ? {}
      : { listOllamaModelOwnershipPeers: () => options.peers ?? [] }),
    ...(!options.useProductionDiscovery ? { discoverActiveOllamaSandboxNames } : {}),
    unloadOllamaModels,
    withOllamaModelOwnershipLock: (operation: () => void) => operation(),
  } as unknown as SetupInferenceDeps;
  return { deps, localInference, unloadOllamaModels, discoverActiveOllamaSandboxNames };
}

const previousLocalOllamaRoute: OllamaModelHolder = {
  name: "alpha",
  provider: "ollama-local",
  model: "qwen2.5:1.5b",
  endpointUrl: "http://127.0.0.1:11434",
  gatewayName: "nemoclaw-32677",
  gatewayPort: 32677,
  lifecycleGeneration: "generation-alpha",
  lifecycleLiveIdentityFingerprint: "a".repeat(64),
};

function releaseToNvidia(previous: OllamaModelHolder, deps: SetupInferenceDeps): void {
  releaseSupersededOllamaModel(
    previous,
    "nvidia-prod",
    "nvidia/test-model",
    "https://integrate.api.nvidia.com/v1",
    { ok: true },
    deps,
  );
}

describe("releaseSupersededOllamaModel", () => {
  it("preserves the host target for a stopped peer after releasing its model", () => {
    const stoppedPeer = {
      name: "stopped-peer",
      provider: "ollama-local",
      model: "qwen2.5:1.5b",
      endpointUrl: "http://127.0.0.1:11434",
      gatewayName: "nemoclaw-32678",
      gatewayPort: 32678,
    } as unknown as SandboxEntry;
    const harness = createOllamaCleanupHarness({ peers: [stoppedPeer] });

    releaseToNvidia(previousLocalOllamaRoute, harness.deps);

    expect(harness.discoverActiveOllamaSandboxNames).toHaveBeenCalledOnce();
    expect(harness.unloadOllamaModels).toHaveBeenCalledExactlyOnceWith(["qwen2.5:1.5b"]);
    expect(harness.localInference.clearPersistedOllamaHostIfUnused).toHaveBeenCalledExactlyOnceWith(
      [stoppedPeer],
    );
  });

  it("releases the target model before unrelated gateway discovery for receipt retirement", () => {
    const unrelatedPeer = {
      name: "unrelated-peer",
      provider: "ollama-local",
      model: "llama3.2:1b",
      endpointUrl: null,
      gatewayName: "unavailable-gateway",
    } as unknown as SandboxEntry;
    const discovery = vi.fn((owners: readonly OllamaModelHolder[]) =>
      owners.some((owner) => owner.model === "llama3.2:1b")
        ? { ok: false as const, message: "unrelated gateway unavailable" }
        : { ok: true as const, activeSandboxNames: new Set<string>(), gatewayChecks: [] },
    );
    const harness = createOllamaCleanupHarness({ peers: [unrelatedPeer], discovery });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      releaseToNvidia(previousLocalOllamaRoute, harness.deps);

      expect(discovery).toHaveBeenCalledTimes(2);
      expect(discovery.mock.calls[0]?.[0]).toEqual([]);
      expect(discovery.mock.calls[1]?.[0]).toEqual([unrelatedPeer]);
      expect(harness.unloadOllamaModels).toHaveBeenCalledExactlyOnceWith(["qwen2.5:1.5b"]);
      expect(harness.localInference.clearPendingOllamaModelCleanup).toHaveBeenCalledWith(
        previousLocalOllamaRoute,
        ["qwen2.5:1.5b"],
      );
      expect(harness.localInference.clearPersistedOllamaHostIfUnused).not.toHaveBeenCalled();
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining("host route receipt was retained"),
      );
    } finally {
      warning.mockRestore();
    }
  });

  it("preserves the model and host receipt while a matching live peer owns it", () => {
    const activePeer = {
      name: "active-peer",
      provider: "ollama-local",
      model: "qwen2.5:1.5b",
      endpointUrl: null,
      gatewayName: "peer-gateway-port",
    } as unknown as SandboxEntry;
    const harness = createOllamaCleanupHarness({
      peers: [activePeer],
      activeSandboxNames: new Set([activePeer.name]),
    });

    releaseToNvidia(previousLocalOllamaRoute, harness.deps);

    expect(harness.unloadOllamaModels).not.toHaveBeenCalled();
    expect(harness.localInference.clearPersistedOllamaHostIfUnused).not.toHaveBeenCalled();
  });

  it("uses Ollama peer records from other gateway roots by default", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-ollama-peer-roots-"));
    vi.stubEnv("HOME", home);
    const gatewayRoot = path.join(home, ".nemoclaw", "gateways", "32665");
    fs.mkdirSync(gatewayRoot, { recursive: true });
    const peer: SandboxEntry = {
      name: "active-peer",
      provider: "ollama-local",
      model: "qwen2.5:1.5b",
      gatewayName: "nemoclaw-32665",
      gatewayPort: 32665,
      endpointUrl: "http://127.0.0.1:11434",
    };
    fs.writeFileSync(
      path.join(gatewayRoot, "sandboxes.json"),
      JSON.stringify({
        defaultSandbox: null,
        defaultSelectionRevision: 1,
        sandboxes: { "active-peer": peer },
      }),
    );
    const harness = createOllamaCleanupHarness({
      useProductionPeerSource: true,
      activeSandboxNames: new Set([peer.name]),
    });

    try {
      releaseToNvidia(previousLocalOllamaRoute, harness.deps);

      expect(harness.discoverActiveOllamaSandboxNames).toHaveBeenCalledOnce();
      expect(harness.discoverActiveOllamaSandboxNames.mock.calls[0]?.[0]).toEqual([
        expect.objectContaining({ name: "active-peer", gatewayName: "nemoclaw-32665" }),
      ]);
      expect(harness.unloadOllamaModels).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps the model and records retry when a sibling gateway has state but no registry", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-ollama-missing-peer-registry-"));
    vi.stubEnv("HOME", home);
    const siblingRoot = path.join(home, ".nemoclaw", "gateways", "32665");
    fs.mkdirSync(siblingRoot, { recursive: true });
    fs.writeFileSync(path.join(siblingRoot, "onboard-session.json"), "{}");
    const harness = createOllamaCleanupHarness({ useProductionPeerSource: true });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      releaseToNvidia(previousLocalOllamaRoute, harness.deps);

      expect(harness.unloadOllamaModels).not.toHaveBeenCalled();
      expect(harness.localInference.persistPendingOllamaModelCleanup).toHaveBeenCalledWith(
        previousLocalOllamaRoute,
        ["qwen2.5:1.5b"],
      );
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("sandboxes.json is missing"));
    } finally {
      warning.mockRestore();
      vi.unstubAllEnvs();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("uses the injected phase capture for cross-gateway discovery", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-ollama-default-discovery-"));
    vi.stubEnv("HOME", home);
    const gatewayRoot = path.join(home, ".nemoclaw", "gateways", "32665");
    fs.mkdirSync(gatewayRoot, { recursive: true });
    const peer: SandboxEntry = {
      name: "active-peer",
      provider: "ollama-local",
      model: "qwen2.5:1.5b",
      gatewayName: "nemoclaw-32665",
      gatewayPort: 32665,
      endpointUrl: "http://127.0.0.1:11434",
    };
    fs.writeFileSync(
      path.join(gatewayRoot, "sandboxes.json"),
      JSON.stringify({
        defaultSandbox: null,
        defaultSelectionRevision: 1,
        sandboxes: { "active-peer": peer },
      }),
    );
    const harness = createOllamaCleanupHarness({
      useProductionPeerSource: true,
      useProductionDiscovery: true,
    });
    const captureOllamaOwnershipPhases = vi.fn(() => ({
      status: 0,
      output: "NAME CREATED PHASE\nactive-peer 2026-08-25 Ready\n",
    }));
    const deps = harness.deps as SetupInferenceDeps;
    deps.captureOllamaOwnershipPhases = captureOllamaOwnershipPhases;
    deps.resolveOllamaOwnershipGateway = (sandbox) => sandbox.gatewayName!;

    try {
      releaseToNvidia(previousLocalOllamaRoute, deps);

      expect(captureOllamaOwnershipPhases).toHaveBeenCalledExactlyOnceWith(
        "nemoclaw-32665",
        process.env,
      );
      expect(harness.discoverActiveOllamaSandboxNames).not.toHaveBeenCalled();
      expect(harness.unloadOllamaModels).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("fails closed and records retry state when a successful inventory omits a matching peer", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-ollama-omitted-inventory-"));
    vi.stubEnv("HOME", home);
    const gatewayRoot = path.join(home, ".nemoclaw", "gateways", "32665");
    fs.mkdirSync(gatewayRoot, { recursive: true });
    const peer: SandboxEntry = {
      name: "stale-peer",
      provider: "ollama-local",
      model: "qwen2.5:1.5b",
      gatewayName: "nemoclaw-32665",
      gatewayPort: 32665,
      endpointUrl: "http://127.0.0.1:11434",
    };
    fs.writeFileSync(
      path.join(gatewayRoot, "sandboxes.json"),
      JSON.stringify({
        defaultSandbox: null,
        defaultSelectionRevision: 1,
        sandboxes: { "stale-peer": peer },
      }),
    );
    const harness = createOllamaCleanupHarness({
      useProductionPeerSource: true,
      useProductionDiscovery: true,
    });
    const captureOllamaOwnershipPhases = vi.fn(() => ({
      status: 0,
      output: "NAME CREATED PHASE",
    }));
    const deps = harness.deps as SetupInferenceDeps;
    deps.captureOllamaOwnershipPhases = captureOllamaOwnershipPhases;
    deps.resolveOllamaOwnershipGateway = (sandbox) => sandbox.gatewayName ?? "default";
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      releaseToNvidia(previousLocalOllamaRoute, harness.deps);

      expect(harness.unloadOllamaModels).not.toHaveBeenCalled();
      expect(harness.localInference.persistPendingOllamaModelCleanup).toHaveBeenCalledWith(
        previousLocalOllamaRoute,
        ["qwen2.5:1.5b"],
      );
      expect(captureOllamaOwnershipPhases).toHaveBeenCalledExactlyOnceWith(
        "nemoclaw-32665",
        process.env,
      );
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("No model was unloaded"));
    } finally {
      warning.mockRestore();
      vi.unstubAllEnvs();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("records a failed ownership probe for retry, then unloads only after a safe retry", () => {
    const discovery = vi
      .fn<NonNullable<SetupInferenceDeps["discoverActiveOllamaSandboxNames"]>>()
      .mockReturnValueOnce({ ok: false, message: "gateway unavailable" })
      .mockReturnValueOnce({ ok: true, activeSandboxNames: new Set(), gatewayChecks: [] });
    const harness = createOllamaCleanupHarness({ discovery });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      releaseToNvidia(previousLocalOllamaRoute, harness.deps);
      expect(harness.unloadOllamaModels).not.toHaveBeenCalled();
      expect(harness.localInference.persistPendingOllamaModelCleanup).toHaveBeenCalledWith(
        previousLocalOllamaRoute,
        ["qwen2.5:1.5b"],
      );
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("No model was unloaded"));

      releaseToNvidia({ ...previousLocalOllamaRoute, provider: "nvidia-prod" }, harness.deps);

      expect(harness.unloadOllamaModels).toHaveBeenCalledExactlyOnceWith(["qwen2.5:1.5b"]);
      expect(harness.localInference.clearPendingOllamaModelCleanup).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "alpha",
          gatewayName: "nemoclaw-32677",
          gatewayPort: 32677,
          lifecycleGeneration: "generation-alpha",
          lifecycleLiveIdentityFingerprint: "a".repeat(64),
        }),
        ["qwen2.5:1.5b"],
      );
    } finally {
      warning.mockRestore();
    }
  });

  it("records the old model when identity changes after the new route commits", () => {
    const harness = createOllamaCleanupHarness();
    const refusal = new Error("sandbox lifecycle changed");
    const attempt = () =>
      releaseSupersededOllamaModel(
        previousLocalOllamaRoute,
        "nvidia-prod",
        "nvidia/test-model",
        "https://integrate.api.nvidia.com/v1",
        { ok: true },
        harness.deps,
        () => {
          throw refusal;
        },
      );

    expect(attempt).toThrow(refusal);
    expect(harness.unloadOllamaModels).not.toHaveBeenCalled();
    expect(harness.localInference.persistPendingOllamaModelCleanup).toHaveBeenCalledExactlyOnceWith(
      previousLocalOllamaRoute,
      ["qwen2.5:1.5b"],
    );
    harness.localInference.persistPendingOllamaModelCleanup.mockImplementation(() => {
      throw new Error("receipt write failed");
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(attempt).toThrow(refusal);
      expect(harness.unloadOllamaModels).not.toHaveBeenCalled();
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining("Cleanup retry state could not be recorded"),
      );
    } finally {
      warning.mockRestore();
    }
  });

  it("requires manual recovery when ownership failure cannot be recorded for retry", () => {
    const discovery = vi.fn<NonNullable<SetupInferenceDeps["discoverActiveOllamaSandboxNames"]>>(
      () => ({ ok: false, message: "gateway unavailable" }),
    );
    const harness = createOllamaCleanupHarness({ discovery });
    harness.localInference.persistPendingOllamaModelCleanup.mockImplementation(() => {
      throw new Error(
        "Cannot persist pending Ollama cleanup without complete sandbox ownership identity",
      );
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      releaseToNvidia(
        {
          ...previousLocalOllamaRoute,
          lifecycleGeneration: undefined,
          lifecycleLiveIdentityFingerprint: undefined,
        },
        harness.deps,
      );

      expect(harness.unloadOllamaModels).not.toHaveBeenCalled();
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining(
          "Manually verify that no active matching sandbox owns the model before releasing only qwen2.5:1.5b",
        ),
      );
      expect(warning).not.toHaveBeenCalledWith(
        expect.stringContaining("Re-run onboarding to retry only"),
      );
    } finally {
      warning.mockRestore();
    }
  });

  it("keeps the retry record when unloading the superseded model fails", () => {
    const harness = createOllamaCleanupHarness({
      unloadResult: {
        ok: false,
        outcome: "still-resident",
        endpoint: "http://127.0.0.1:11434",
        selectedModels: ["qwen2.5:1.5b"],
        discoveries: [],
        requests: [],
      },
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      releaseToNvidia(previousLocalOllamaRoute, harness.deps);

      expect(harness.unloadOllamaModels).toHaveBeenCalledExactlyOnceWith(["qwen2.5:1.5b"]);
      expect(harness.localInference.persistPendingOllamaModelCleanup).toHaveBeenCalledWith(
        previousLocalOllamaRoute,
        ["qwen2.5:1.5b"],
      );
      expect(harness.localInference.clearPendingOllamaModelCleanup).not.toHaveBeenCalled();
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining("Re-run onboarding or destroy 'alpha' to retry only"),
      );
    } finally {
      warning.mockRestore();
    }
  });

  it("does not probe or warn when the selected route still owns the same Ollama model", () => {
    const harness = createOllamaCleanupHarness();

    releaseSupersededOllamaModel(
      previousLocalOllamaRoute,
      "ollama-local",
      "qwen2.5:1.5b",
      "http://127.0.0.1:11434",
      { ok: true },
      harness.deps,
    );

    expect(harness.discoverActiveOllamaSandboxNames).not.toHaveBeenCalled();
    expect(harness.unloadOllamaModels).not.toHaveBeenCalled();
    expect(harness.localInference.clearPersistedOllamaHostIfUnused).not.toHaveBeenCalled();
  });

  it("does not probe unrelated routes when there is no Ollama cleanup retry", () => {
    const harness = createOllamaCleanupHarness({
      peers: [{ name: "ollama-peer", provider: "ollama-local", model: "qwen2.5:1.5b" }],
    });

    releaseToNvidia(
      { name: "alpha", provider: "nvidia-prod", model: "nvidia/model" },
      harness.deps,
    );

    expect(harness.discoverActiveOllamaSandboxNames).not.toHaveBeenCalled();
    expect(harness.unloadOllamaModels).not.toHaveBeenCalled();
    expect(harness.localInference.clearPersistedOllamaHostIfUnused).not.toHaveBeenCalled();
  });
});
