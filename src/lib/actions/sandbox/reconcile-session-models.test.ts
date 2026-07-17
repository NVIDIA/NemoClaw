// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { reconcilePinnedSessionModels } from "./reconcile-session-models";

function store(entries: Record<string, unknown>): string {
  return JSON.stringify(entries);
}

describe("reconcilePinnedSessionModels (#7102)", () => {
  const primary = "inference/nvidia/llama-3.3-nemotron-super-49b-v1.5";

  it("clears a managed pin that no longer matches the current default", () => {
    const raw = store({
      "agent:main:main": {
        sessionId: "s1",
        updatedAt: 1,
        modelProvider: "inference",
        model: "meta/llama-3.1-8b-instruct",
      },
    });
    const result = reconcilePinnedSessionModels(raw, primary);
    expect(result.changed).toBe(true);
    expect(result.clearedSessionKeys).toEqual(["agent:main:main"]);
    const parsed = JSON.parse(result.content);
    expect(parsed["agent:main:main"].model).toBeUndefined();
    expect(parsed["agent:main:main"].modelProvider).toBeUndefined();
    // Non-model fields are preserved.
    expect(parsed["agent:main:main"].sessionId).toBe("s1");
  });

  it("leaves a session already on the current default untouched", () => {
    const raw = store({
      "agent:main:main": {
        modelProvider: "inference",
        model: "nvidia/llama-3.3-nemotron-super-49b-v1.5",
      },
    });
    const result = reconcilePinnedSessionModels(raw, primary);
    expect(result.changed).toBe(false);
    expect(result.content).toBe(raw);
  });

  it("leaves an intentional non-managed provider pin untouched", () => {
    const raw = store({
      "agent:main:main": { modelProvider: "openai", model: "gpt-5.6-terra" },
    });
    const result = reconcilePinnedSessionModels(raw, primary);
    expect(result.changed).toBe(false);
  });

  it("only clears the stale managed sessions in a mixed store", () => {
    const raw = store({
      stale: { modelProvider: "inference", model: "meta/llama-3.1-8b-instruct" },
      current: { modelProvider: "inference", model: "nvidia/llama-3.3-nemotron-super-49b-v1.5" },
      intentional: { modelProvider: "openai", model: "gpt-5.6-terra" },
      unpinned: { sessionId: "x" },
    });
    const result = reconcilePinnedSessionModels(raw, primary);
    expect(result.clearedSessionKeys).toEqual(["stale"]);
    const parsed = JSON.parse(result.content);
    expect(parsed.stale.model).toBeUndefined();
    expect(parsed.current.model).toBe("nvidia/llama-3.3-nemotron-super-49b-v1.5");
    expect(parsed.intentional.model).toBe("gpt-5.6-terra");
    expect(parsed.unpinned.sessionId).toBe("x");
  });

  it("is a no-op when the primary ref is missing", () => {
    const raw = store({
      "agent:main:main": { modelProvider: "inference", model: "meta/llama-3.1-8b-instruct" },
    });
    expect(reconcilePinnedSessionModels(raw, null).changed).toBe(false);
  });

  it("is a no-op on malformed session json", () => {
    expect(reconcilePinnedSessionModels("not json", primary).changed).toBe(false);
    expect(reconcilePinnedSessionModels("[]", primary).changed).toBe(false);
  });

  it("ignores an entry with a non-string model", () => {
    const raw = store({
      "agent:main:main": { modelProvider: "inference", model: 42 },
    });
    expect(reconcilePinnedSessionModels(raw, primary).changed).toBe(false);
  });
});
