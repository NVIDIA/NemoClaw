// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  decideOllamaModelOwnership,
  exclusivelyHeldOllamaModel,
  type OllamaModelHolder,
  supersededOllamaModel,
} from "./model-ownership";

function holder(overrides: Partial<OllamaModelHolder> = {}): OllamaModelHolder {
  return { name: "test-box", provider: "ollama-local", model: "llama3", ...overrides };
}

describe("supersededOllamaModel", () => {
  it("releases the previous model when a re-onboard moves to a different one (#9110)", () => {
    expect(supersededOllamaModel(holder(), "qwen2.5:7b", [holder()])).toBe("llama3");
  });

  it.each([
    ["the identical ref", "llama3", "llama3"],
    ["an explicit latest tag on the next model", "llama3", "llama3:latest"],
    ["an explicit latest tag on the previous model", "llama3:latest", "llama3"],
  ])("keeps the model when the next ref is %s (#9110)", (_label, previousModel, nextModel) => {
    const previous = holder({ model: previousModel });
    expect(supersededOllamaModel(previous, nextModel, [previous])).toBeNull();
  });

  it.each([["llama3"], ["llama3:latest"]])(
    "keeps a model an Ollama peer records as %s (#9110)",
    (peerModel) => {
      const peer = holder({ model: peerModel, name: "peer" });
      expect(supersededOllamaModel(holder(), "qwen2.5:7b", [holder(), peer])).toBeNull();
    },
  );

  it("releases the model when peers hold different ones (#9110)", () => {
    const peer = holder({ model: "llama3:8b", name: "peer" });
    expect(supersededOllamaModel(holder(), "qwen2.5:7b", [holder(), peer])).toBe("llama3");
  });

  it.each([["nvidia-prod"], ["vllm-local"], [undefined]])(
    "does nothing when the previous provider is %s (#9110)",
    (provider) => {
      const previous = holder({ provider });
      expect(supersededOllamaModel(previous, "qwen2.5:7b", [previous])).toBeNull();
    },
  );

  it("does nothing when the previous model is unrecorded (#9110)", () => {
    const previous = holder({ model: undefined });
    expect(supersededOllamaModel(previous, "qwen2.5:7b", [previous])).toBeNull();
  });

  it.each([[""], ["   "]])("does nothing when the next model is %j (#9110)", (nextModel) => {
    expect(supersededOllamaModel(holder(), nextModel, [holder()])).toBeNull();
  });

  it("does nothing when there is no previous entry (#9110)", () => {
    expect(supersededOllamaModel(null, "qwen2.5:7b", [])).toBeNull();
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
      expect(decideOllamaModelOwnership(holder({ model }), [holder({ model })], new Set())).toEqual({
        kind: "missing-model",
      });
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
});

describe("exclusivelyHeldOllamaModel", () => {
  it("is not blocked by a non-Ollama peer that records the same model (#9110)", () => {
    const peer = holder({ name: "peer", provider: "nvidia-prod" });
    expect(exclusivelyHeldOllamaModel(holder(), [holder(), peer])).toBe("llama3");
  });
});
