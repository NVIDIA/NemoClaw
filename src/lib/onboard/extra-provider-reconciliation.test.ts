// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { reconcileRegisteredExtraProviders } from "./extra-provider-reconciliation";

type RunResult = { status: number | null; stderr?: string; stdout?: string | Buffer };

describe("reconcileRegisteredExtraProviders", () => {
  it("keeps every user-owned extra whose exact name appears in one scoped gateway list", () => {
    const runOpenshell = vi.fn(
      (_args: string[]): RunResult => ({
        status: 0,
        stdout: Buffer.from(
          " tavily-search\nbrave-search\ncustom-provider\nmy-slack-bridge\nunrelated\n",
        ),
      }),
    );
    const recorded = ["tavily-search", "brave-search", "custom-provider", "my-slack-bridge"];

    const result = reconcileRegisteredExtraProviders("nemoclaw", {
      runOpenshell,
      listExtraProviders: () => recorded,
    });

    expect(result).toEqual(recorded);
    expect(runOpenshell).toHaveBeenCalledOnce();
    expect(runOpenshell).toHaveBeenCalledWith(["provider", "list", "-g", "nemoclaw", "--names"], {
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
      suppressOutput: true,
    });
  });

  it("omits a stale tavily record only from the current create plan (#6501)", () => {
    const recorded = ["tavily-search", "custom-provider"];

    const result = reconcileRegisteredExtraProviders("nemoclaw", {
      runOpenshell: vi.fn(() => ({ status: 0, stdout: "custom-provider\n" })),
      listExtraProviders: () => recorded,
    });

    expect(result).toEqual(["custom-provider"]);
    expect(recorded).toEqual(["tavily-search", "custom-provider"]);
  });

  it("matches complete names instead of prefixes or provider-name heuristics", () => {
    const result = reconcileRegisteredExtraProviders("nemoclaw", {
      runOpenshell: vi.fn(() => ({
        status: 0,
        stdout: "tavily-search-backup\ncustom-provider-v2\n",
      })),
      listExtraProviders: () => ["tavily-search", "custom-provider"],
    });

    expect(result).toEqual([]);
  });

  it("preserves every recorded extra when the gateway list exits nonzero", () => {
    const recorded = ["tavily-search", "brave-search", "custom-provider"];

    const result = reconcileRegisteredExtraProviders("nemoclaw", {
      runOpenshell: vi.fn(() => ({ status: 1, stderr: "gateway unavailable" })),
      listExtraProviders: () => recorded,
    });

    expect(result).toEqual(recorded);
  });

  it("preserves every recorded extra when the gateway list throws", () => {
    const recorded = ["tavily-search", "my-slack-bridge"];

    const result = reconcileRegisteredExtraProviders("nemoclaw", {
      runOpenshell: vi.fn(() => {
        throw new Error("spawn failed");
      }),
      listExtraProviders: () => recorded,
    });

    expect(result).toEqual(recorded);
  });

  it("does not query the gateway when no extras are recorded", () => {
    const runOpenshell = vi.fn();

    expect(
      reconcileRegisteredExtraProviders("nemoclaw", {
        runOpenshell,
        listExtraProviders: () => [],
      }),
    ).toEqual([]);
    expect(runOpenshell).not.toHaveBeenCalled();
  });
});
