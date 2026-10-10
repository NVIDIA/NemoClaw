// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  clearPendingOllamaModelCleanup,
  decideOllamaModelOwnership,
  discoverOllamaModelOwnership,
  loadPendingOllamaModelCleanup,
  type OllamaHostRoute,
  type OllamaModelHolder,
  type OllamaModelRoute,
  persistPendingOllamaModelCleanup,
  supersededOllamaModelWithActivePeers,
} from "./model-ownership";
import { isLocalOllamaRouteOwner } from "./model-ownership";

function holder(overrides: Partial<OllamaModelHolder> = {}): OllamaModelHolder {
  return { name: "test-box", provider: "ollama-local", model: "llama3", ...overrides };
}

function route(model: string, overrides: Partial<OllamaModelRoute> = {}): OllamaModelRoute {
  return { provider: "ollama-local", model, ...overrides };
}

function releaseCandidate(
  previous: OllamaModelHolder | null,
  next: OllamaModelRoute,
  peers: readonly OllamaModelHolder[],
  activePeers: readonly OllamaModelHolder[] = [],
  selectedHost: OllamaHostRoute | null = null,
): string | null {
  return supersededOllamaModelWithActivePeers(
    previous,
    next,
    peers,
    new Set(activePeers.map((peer) => peer.name)),
    selectedHost,
    new Set(activePeers),
  );
}

describe("isLocalOllamaRouteOwner", () => {
  it.each([["ollama-local"], ["ollama/qwen3-vl:4b"]])(
    "recognizes the direct local provider %s",
    (provider) => {
      expect(isLocalOllamaRouteOwner({ provider }, "127.0.0.1")).toBe(true);
    },
  );

  it("recognizes a compatible endpoint at the selected local daemon", () => {
    expect(
      isLocalOllamaRouteOwner(
        {
          provider: "compatible-endpoint",
          endpointUrl: "http://127.0.0.1:11434/v1",
        },
        "127.0.0.1",
      ),
    ).toBe(true);
  });

  it.each([
    ["a remote endpoint", "https://ollama.example.com:11434/v1"],
    ["the other fixed host route", "http://host.docker.internal:11434/v1"],
    ["a different port", "http://127.0.0.1:11435/v1"],
  ])("excludes %s", (_label, endpointUrl) => {
    expect(
      isLocalOllamaRouteOwner({ provider: "compatible-endpoint", endpointUrl }, "127.0.0.1"),
    ).toBe(false);
  });
});

describe("supersededOllamaModelWithActivePeers route changes", () => {
  it("releases the previous model when a re-onboard moves to a different one (#9110)", () => {
    const previous = holder();
    expect(releaseCandidate(previous, route("qwen2.5:7b"), [previous])).toBe("llama3");
  });

  it.each([
    ["the identical ref", "llama3", "llama3"],
    ["an explicit latest tag on the next model", "llama3", "llama3:latest"],
    ["an explicit latest tag on the previous model", "llama3:latest", "llama3"],
  ])("keeps the model when the next ref is %s (#9110)", (_label, previousModel, nextModel) => {
    const previous = holder({ model: previousModel });
    expect(releaseCandidate(previous, route(nextModel), [previous])).toBeNull();
  });

  it.each([["llama3"], ["llama3:latest"]])(
    "keeps a model an active Ollama peer records as %s (#9110)",
    (peerModel) => {
      const previous = holder();
      const peer = holder({ model: peerModel, name: "peer" });
      expect(releaseCandidate(previous, route("qwen2.5:7b"), [previous, peer], [peer])).toBeNull();
    },
  );

  it("releases the model when peers hold different ones (#9110)", () => {
    const previous = holder();
    const peer = holder({ model: "llama3:8b", name: "peer" });
    expect(releaseCandidate(previous, route("qwen2.5:7b"), [previous, peer])).toBe("llama3");
  });

  it.each([["nvidia-prod"], ["vllm-local"], [undefined]])(
    "does nothing when the previous provider is %s (#9110)",
    (provider) => {
      const previous = holder({ provider });
      expect(releaseCandidate(previous, route("qwen2.5:7b"), [previous])).toBeNull();
    },
  );

  it("does nothing when the previous model is unrecorded (#9110)", () => {
    const previous = holder({ model: undefined });
    expect(releaseCandidate(previous, route("qwen2.5:7b"), [previous])).toBeNull();
  });

  it.each([[""], ["   "]])("does nothing when the next model is %j (#9110)", (nextModel) => {
    const previous = holder();
    expect(releaseCandidate(previous, route(nextModel), [previous])).toBeNull();
  });

  it("does nothing when there is no previous entry (#9110)", () => {
    expect(releaseCandidate(null, route("qwen2.5:7b"), [])).toBeNull();
  });

  it("keeps a model selected through a compatible endpoint at the same local daemon", () => {
    const previous = holder();
    expect(
      releaseCandidate(
        previous,
        route("llama3:latest", {
          provider: "compatible-endpoint",
          endpointUrl: "http://127.0.0.1:11434/v1",
        }),
        [previous],
        [],
        "127.0.0.1",
      ),
    ).toBeNull();
  });

  it("does not mistake a remote compatible endpoint for the local daemon", () => {
    const previous = holder();
    expect(
      releaseCandidate(
        previous,
        route("llama3", {
          provider: "compatible-endpoint",
          endpointUrl: "https://ollama.example.com:11434/v1",
        }),
        [previous],
        [],
        "127.0.0.1",
      ),
    ).toBe("llama3");
  });
});

describe("supersededOllamaModelWithActivePeers live ownership rows", () => {
  it("releases a superseded model despite stale or incomplete matching registry rows", () => {
    const previous = holder();
    const inactivePeer = holder({ name: "incomplete-reservation" });
    expect(releaseCandidate(previous, route("qwen2.5:1.5b"), [previous, inactivePeer])).toBe(
      "llama3",
    );
  });

  it("protects the model while a matching sibling is active", () => {
    const previous = holder();
    const activePeer = holder({ name: "active-peer", model: "llama3:latest" });
    expect(
      releaseCandidate(previous, route("qwen2.5:1.5b"), [previous, activePeer], [activePeer]),
    ).toBeNull();
  });

  it("protects a same-named active peer registered under another gateway", () => {
    const previous = holder({ gatewayName: "current-gateway" });
    const peer = holder({ gatewayName: "other-gateway" });

    expect(releaseCandidate(previous, route("qwen2.5:1.5b"), [peer], [peer])).toBeNull();
  });

  it("does not treat a same-named row with incomplete gateway identity as the subject", () => {
    const previous = holder();
    const peer = holder({ gatewayName: "other-gateway" });

    expect(releaseCandidate(previous, route("qwen2.5:1.5b"), [peer], [peer])).toBeNull();
  });

  it("preserves an active model selected through the same local daemon", () => {
    const previous = holder();
    expect(releaseCandidate(previous, route("llama3:latest"), [previous])).toBeNull();
  });
});

describe("discoverOllamaModelOwnership", () => {
  it("does not leak a live same-name peer across gateway roots", () => {
    const stoppedMatchingPeer = holder({
      name: "duplicate-peer",
      model: "llama3",
      gatewayName: "gateway-stopped",
    });
    const activeDifferentModelPeer = holder({
      name: "duplicate-peer",
      model: "llama3:8b",
      gatewayName: "gateway-live",
    });
    const discovery = discoverOllamaModelOwnership(
      [stoppedMatchingPeer, activeDifferentModelPeer],
      {},
      (gateway) => ({
        status: 0,
        output: gateway === "gateway-live" ? "live" : "stopped",
      }),
      {
        parseLiveSandboxEntries: (output) => [
          {
            name: "duplicate-peer",
            phase: output === "live" ? "Ready" : "Stopped",
          },
        ],
        resolvePersistedSandboxOwnershipGateway: (peer) => peer.gatewayName ?? "default",
      },
    );

    expect(discovery.ok).toBe(true);
    const successfulDiscovery = discovery as Extract<typeof discovery, { readonly ok: true }>;
    const activePeers = successfulDiscovery.activePeers as ReadonlySet<OllamaModelHolder>;
    expect(successfulDiscovery.activeSandboxNames).toEqual(new Set(["duplicate-peer"]));
    expect(activePeers).toEqual(new Set([activeDifferentModelPeer]));
    expect(
      decideOllamaModelOwnership(
        holder({ name: "alpha", model: "llama3" }),
        [stoppedMatchingPeer, activeDifferentModelPeer],
        successfulDiscovery.activeSandboxNames,
        null,
        activePeers,
      ),
    ).toEqual({ kind: "exclusive", model: "llama3", stalePeers: ["duplicate-peer"] });
  });
});

describe("decideOllamaModelOwnership", () => {
  it("returns the exclusive model and names stopped matching registry rows (#10074)", () => {
    const stoppedPeer = holder({ name: "stopped-peer" });

    expect(decideOllamaModelOwnership(holder(), [holder(), stoppedPeer], new Set())).toEqual({
      kind: "exclusive",
      model: "llama3",
      stalePeers: ["stopped-peer"],
    });
  });

  it("protects a matching model held by a genuinely active sibling (#10074)", () => {
    const activePeer = holder({ name: "active-peer", model: "llama3:latest" });
    const stoppedPeer = holder({ name: "stopped-peer" });

    expect(
      decideOllamaModelOwnership(
        holder(),
        [holder(), stoppedPeer, activePeer],
        new Set(["active-peer"]),
      ),
    ).toEqual({
      kind: "shared-active",
      model: "llama3",
      activePeers: ["active-peer"],
      stalePeers: ["stopped-peer"],
    });
  });

  it.each([[undefined], [""], ["   "]])(
    "returns missing-model for registry model %j (#10074)",
    (model) => {
      expect(decideOllamaModelOwnership(holder({ model }), [holder({ model })], new Set())).toEqual(
        {
          kind: "missing-model",
        },
      );
    },
  );

  it("does not classify a different model or provider as an owner (#10074)", () => {
    const differentModel = holder({ name: "different-model", model: "llama3:8b" });
    const differentProvider = holder({ name: "different-provider", provider: "nvidia-prod" });

    expect(
      decideOllamaModelOwnership(
        holder(),
        [holder(), differentModel, differentProvider],
        new Set(["different-model", "different-provider"]),
      ),
    ).toEqual({ kind: "exclusive", model: "llama3", stalePeers: [] });
  });

  it("protects a matching compatible endpoint at the same local daemon", () => {
    const activePeer = holder({
      name: "compatible-peer",
      provider: "compatible-endpoint",
      endpointUrl: "http://127.0.0.1:11434/v1",
    });

    expect(
      decideOllamaModelOwnership(
        holder(),
        [holder(), activePeer],
        new Set(["compatible-peer"]),
        "127.0.0.1",
      ),
    ).toEqual({
      kind: "shared-active",
      model: "llama3",
      activePeers: ["compatible-peer"],
      stalePeers: [],
    });
  });
});

describe("pending Ollama model cleanup", () => {
  it("persists exact sandbox-scoped models until verified release", () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "nemoclaw-pending-ollama-cleanup-"));
    try {
      persistPendingOllamaModelCleanup("test-box", ["llama3", "llama3:latest"], stateRoot);
      persistPendingOllamaModelCleanup("test-box", ["qwen3.5:9b"], stateRoot);

      expect(loadPendingOllamaModelCleanup("test-box", stateRoot)).toEqual([
        "llama3",
        "qwen3.5:9b",
      ]);
      clearPendingOllamaModelCleanup("test-box", ["llama3:latest"], stateRoot);
      expect(loadPendingOllamaModelCleanup("test-box", stateRoot)).toEqual(["qwen3.5:9b"]);
      clearPendingOllamaModelCleanup("test-box", undefined, stateRoot);
      expect(loadPendingOllamaModelCleanup("test-box", stateRoot)).toEqual([]);
    } finally {
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("rejects an unsafe sandbox name before state access", () => {
    expect(() => loadPendingOllamaModelCleanup("../peer")).toThrow(
      "Invalid sandbox name for pending Ollama cleanup",
    );
  });
});
