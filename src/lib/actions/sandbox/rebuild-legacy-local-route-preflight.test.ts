// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { RebuildSandboxEntry } from "./rebuild-flow-helpers";
import { blockRebuildOnLegacySharedLocalRoute } from "./rebuild-preflight-phase";

describe("rebuild legacy local route preflight", () => {
  it.each([
    { agent: "openclaw", provider: "ollama-local" },
    { agent: "openclaw", provider: "vllm-local" },
    { agent: "langchain-deepagents-code", provider: "ollama-local" },
  ])("warns before rebuilding an existing $agent $provider sandbox", ({ agent, provider }) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const bail = vi.fn((message: string): never => {
      throw new Error(message);
    });
    const entry = {
      name: "alpha",
      createdAt: "2026-09-01T00:00:00Z",
      agent,
      provider,
      model: "local-model",
    } as RebuildSandboxEntry;

    expect(() => blockRebuildOnLegacySharedLocalRoute("alpha", entry, bail)).toThrow(
      "Legacy shared local inference cannot be rebuilt safely",
    );
    expect(error.mock.calls.flat().join("\n")).toContain("Back up the sandbox");
    expect(bail).toHaveBeenCalledOnce();
  });

  it("leaves attached and unpublished selections on their existing preflight path", () => {
    const bail = vi.fn((message: string): never => {
      throw new Error(message);
    });
    const entry = {
      name: "alpha",
      createdAt: "2026-09-01T00:00:00Z",
      agent: "openclaw",
      provider: "ollama-local",
      model: "local-model",
      nativeLocalProviderAttachment: {},
    } as RebuildSandboxEntry;
    expect(blockRebuildOnLegacySharedLocalRoute("alpha", entry, bail)).toBe(false);
    expect(
      blockRebuildOnLegacySharedLocalRoute(
        "alpha",
        { ...entry, createdAt: undefined, nativeLocalProviderAttachment: undefined },
        bail,
      ),
    ).toBe(false);
    expect(bail).not.toHaveBeenCalled();
  });

  it("keeps a published Pi shared local selection eligible for rebuild", () => {
    const bail = vi.fn((message: string): never => {
      throw new Error(message);
    });
    const entry = {
      name: "alpha",
      createdAt: "2026-09-01T00:00:00Z",
      agent: "pi",
      provider: "ollama-local",
      model: "local-model",
    } as RebuildSandboxEntry;

    expect(blockRebuildOnLegacySharedLocalRoute("alpha", entry, bail)).toBe(false);
    expect(bail).not.toHaveBeenCalled();
  });
});
