// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { reconcileRegisteredExtraProviders } from "./extra-provider-reconciliation";
import {
  LIMIT,
  missing,
  ok,
  type ProbeResult,
  reconcile,
} from "./extra-provider-reconciliation.test-fixtures";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("reconcileRegisteredExtraProviders", () => {
  it("skips gateway probes when no extra provider is recorded (#6501)", () => {
    const runOpenshell = vi.fn((): ProbeResult => ok());

    expect(
      reconcileRegisteredExtraProviders("nemoclaw", {
        listExtraProviders: () => [],
        runOpenshell,
      }),
    ).toEqual([]);
    expect(runOpenshell).not.toHaveBeenCalled();
  });

  it("probes every recorded provider exactly and never trusts provider-list snapshots (#6501)", () => {
    const recorded = Array.from({ length: 128 }, (_value, index) => `custom-provider-${index}`);
    const calls: Array<{
      args: string[];
      options: Record<string, unknown> | undefined;
    }> = [];
    const removeExtraProvider = vi.fn(() => true);
    const runOpenshell = vi.fn((args: string[], options?: Record<string, unknown>) => {
      calls.push({ args, options });
      return args.at(-1) === "custom-provider-127" ? missing("custom-provider-127") : ok();
    });

    expect(
      reconcileRegisteredExtraProviders("nemoclaw", {
        listExtraProviders: () => [...recorded],
        removeExtraProvider,
        runOpenshell,
      }),
    ).toEqual(recorded.slice(0, -1));
    expect(removeExtraProvider).toHaveBeenCalledWith("custom-provider-127");
    expect(calls).toHaveLength(recorded.length);
    expect(calls.some(({ args }) => args.includes("list") || args.includes("--names"))).toBe(false);
    expect(calls[0]).toEqual({
      args: ["provider", "get", "-g", "nemoclaw", "custom-provider-0"],
      options: {
        ignoreError: true,
        maxBuffer: LIMIT,
        stdio: ["ignore", "pipe", "pipe"],
        suppressOutput: true,
        timeout: 5_000,
      },
    });
  });

  it("keeps healthy providers and omits only exact provider-specific not-found diagnostics (#6501)", () => {
    expect(
      reconcile(["healthy-provider", "stale-provider", "indeterminate-provider"], {
        "stale-provider": {
          status: 1,
          stderr: Buffer.from("Error: provider 'stale-provider' not found\n"),
        },
        "indeterminate-provider": missing("some-other-provider"),
      }),
    ).toEqual(["healthy-provider", "indeterminate-provider"]);
  });
});
