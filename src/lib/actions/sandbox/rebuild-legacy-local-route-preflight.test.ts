// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { parseSandboxRegistryEntries } from "../../state/registry-normalization";
import type { RebuildSandboxEntry } from "./rebuild-flow-helpers";
import { blockRebuildOnLegacySharedLocalRoute } from "./rebuild-preflight-phase";

describe("rebuild legacy local route preflight", () => {
  it.each([
    { agent: "openclaw", provider: "ollama-local", recordedAt: "2026-09-01T00:00:00Z" },
    { agent: "openclaw", provider: "ollama-local", recordedAt: undefined },
    { agent: "openclaw", provider: "vllm-local", recordedAt: "2026-09-01T00:00:00Z" },
    {
      agent: "langchain-deepagents-code",
      provider: "ollama-local",
      recordedAt: "2026-09-01T00:00:00Z",
    },
    { agent: "langchain-deepagents-code", provider: "ollama-local", recordedAt: undefined },
  ])(
    "warns before rebuilding an existing $agent $provider sandbox",
    ({ agent, provider, recordedAt }) => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const bail = vi.fn((message: string): never => {
        throw new Error(message);
      });
      const entry = {
        name: "alpha",
        ...(recordedAt ? { createdAt: recordedAt } : {}),
        agent,
        provider,
        model: "local-model",
      } as RebuildSandboxEntry;

      const [, persisted] = parseSandboxRegistryEntries(
        JSON.parse(JSON.stringify({ alpha: entry })),
      )[0]!;
      expect(() => blockRebuildOnLegacySharedLocalRoute("alpha", persisted, bail)).toThrow(
        "Legacy shared local inference cannot be rebuilt safely",
      );
      expect(error.mock.calls.flat().join("\n")).toContain("Back up the sandbox");
      expect(bail).toHaveBeenCalledOnce();
    },
  );

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
        {
          ...entry,
          createdAt: undefined,
          pendingRouteReservation: true,
          nativeLocalProviderAttachment: undefined,
        },
        bail,
      ),
    ).toBe(false);
    expect(
      blockRebuildOnLegacySharedLocalRoute(
        "alpha",
        { ...entry, pendingRouteReservation: true, nativeLocalProviderAttachment: undefined },
        bail,
      ),
    ).toBe(false);
    expect(bail).not.toHaveBeenCalled();
  });
});
