// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  clearPendingOllamaModelCleanup,
  decideOllamaModelOwnership,
  exclusivelyHeldOllamaModel,
  loadPendingOllamaModelCleanup,
  type OllamaModelHolder,
  type OllamaModelRoute,
  persistPendingOllamaModelCleanup,
  supersededOllamaModel,
} from "./model-ownership";
import { isLocalOllamaRouteOwner } from "./model-ownership";

function holder(overrides: Partial<OllamaModelHolder> = {}): OllamaModelHolder {
  return { name: "test-box", provider: "ollama-local", model: "llama3", ...overrides };
}

function route(model: string, overrides: Partial<OllamaModelRoute> = {}): OllamaModelRoute {
  return { provider: "ollama-local", model, ...overrides };
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

describe("supersededOllamaModel", () => {
  it("releases the previous model when a re-onboard moves to a different one (#9110)", () => {
    expect(supersededOllamaModel(holder(), route("qwen2.5:7b"), [holder()])).toBe("llama3");
  });

  it.each([
    ["the identical ref", "llama3", "llama3"],
    ["an explicit latest tag on the next model", "llama3", "llama3:latest"],
    ["an explicit latest tag on the previous model", "llama3:latest", "llama3"],
  ])("keeps the model when the next ref is %s (#9110)", (_label, previousModel, nextModel) => {
    const previous = holder({ model: previousModel });
    expect(supersededOllamaModel(previous, route(nextModel), [previous])).toBeNull();
  });

  it.each([["llama3"], ["llama3:latest"]])(
    "keeps a model an Ollama peer records as %s (#9110)",
    (peerModel) => {
      const peer = holder({ model: peerModel, name: "peer" });
      expect(supersededOllamaModel(holder(), route("qwen2.5:7b"), [holder(), peer])).toBeNull();
    },
  );

  it("releases the model when peers hold different ones (#9110)", () => {
    const peer = holder({ model: "llama3:8b", name: "peer" });
    expect(supersededOllamaModel(holder(), route("qwen2.5:7b"), [holder(), peer])).toBe("llama3");
  });

  it.each([["nvidia-prod"], ["vllm-local"], [undefined]])(
    "does nothing when the previous provider is %s (#9110)",
    (provider) => {
      const previous = holder({ provider });
      expect(supersededOllamaModel(previous, route("qwen2.5:7b"), [previous])).toBeNull();
    },
  );

  it("does nothing when the previous model is unrecorded (#9110)", () => {
    const previous = holder({ model: undefined });
    expect(supersededOllamaModel(previous, route("qwen2.5:7b"), [previous])).toBeNull();
  });

  it.each([[""], ["   "]])("does nothing when the next model is %j (#9110)", (nextModel) => {
    expect(supersededOllamaModel(holder(), route(nextModel), [holder()])).toBeNull();
  });

  it("does nothing when there is no previous entry (#9110)", () => {
    expect(supersededOllamaModel(null, route("qwen2.5:7b"), [])).toBeNull();
  });

  it("keeps a model selected through a compatible endpoint at the same local daemon", () => {
    expect(
      supersededOllamaModel(
        holder(),
        route("llama3:latest", {
          provider: "compatible-endpoint",
          endpointUrl: "http://127.0.0.1:11434/v1",
        }),
        [holder()],
        "127.0.0.1",
      ),
    ).toBeNull();
  });

  it("does not mistake a remote compatible endpoint for the local daemon", () => {
    expect(
      supersededOllamaModel(
        holder(),
        route("llama3", {
          provider: "compatible-endpoint",
          endpointUrl: "https://ollama.example.com:11434/v1",
        }),
        [holder()],
        "127.0.0.1",
      ),
    ).toBe("llama3");
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

describe("exclusivelyHeldOllamaModel", () => {
  it("is not blocked by a non-Ollama peer that records the same model (#9110)", () => {
    const peer = holder({ name: "peer", provider: "nvidia-prod" });
    expect(exclusivelyHeldOllamaModel(holder(), [holder(), peer])).toBe("llama3");
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
