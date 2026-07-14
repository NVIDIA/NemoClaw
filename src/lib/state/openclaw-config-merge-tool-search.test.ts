// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { mergeOpenClawRestoredConfig } from "./openclaw-config-merge";

describe("mergeOpenClawRestoredConfig Tool Search", () => {
  it("keeps the rebuilt tool-search selection while restoring other tool settings", () => {
    const merged = mergeOpenClawRestoredConfig(
      {
        tools: {
          toolSearch: false,
          web: { fetch: { enabled: false } },
          loopDetection: { enabled: true, historySize: 12 },
        },
      },
      {
        tools: {
          toolSearch: { mode: "tools", maxResults: 8 },
          web: { fetch: { enabled: true } },
        },
      },
    ) as { tools: Record<string, unknown> };

    expect(merged.tools.toolSearch).toEqual({ mode: "tools", maxResults: 8 });
    expect(merged.tools.web).toEqual({ fetch: { enabled: false } });
    expect(merged.tools.loopDetection).toEqual({ enabled: true, historySize: 12 });
  });

  it("does not resurrect backed-up Tool Search when the rebuilt config omits it", () => {
    const merged = mergeOpenClawRestoredConfig(
      {
        tools: {
          toolSearch: { mode: "code" },
          loopDetection: { enabled: true },
        },
      },
      { gateway: { auth: { token: "fresh-token" } } },
    ) as { tools: Record<string, unknown> };

    expect(merged.tools.toolSearch).toBeUndefined();
    expect(merged.tools.loopDetection).toEqual({ enabled: true });
  });
});
