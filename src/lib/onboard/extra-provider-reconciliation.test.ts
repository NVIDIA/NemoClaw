// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyExtraProviderReconciliation,
  planRegisteredExtraProviders,
} from "./extra-provider-reconciliation";
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

describe("planRegisteredExtraProviders", () => {
  it("skips gateway probes when no extra provider is recorded (#6501)", async () => {
    const runOpenshell = vi.fn((): ProbeResult => ok());

    expect(
      await planRegisteredExtraProviders("nemoclaw", {
        listExtraProviders: () => [],
        runOpenshell,
      }),
    ).toEqual({ extraProviders: [], staleExtraProviders: [] });
    expect(runOpenshell).not.toHaveBeenCalled();
  });

  it("probes every recorded provider exactly and never trusts provider-list snapshots (#6501)", async () => {
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

    const plan = await planRegisteredExtraProviders("nemoclaw", {
      listExtraProviders: () => [...recorded],
      removeExtraProvider,
      runOpenshell,
    });
    expect(plan).toEqual({
      extraProviders: recorded.slice(0, -1),
      staleExtraProviders: ["custom-provider-127"],
    });
    expect(removeExtraProvider).not.toHaveBeenCalled();
    applyExtraProviderReconciliation(plan, { removeExtraProvider });
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

  it("keeps healthy providers and omits only exact provider-specific not-found diagnostics (#6501)", async () => {
    expect(
      await reconcile(["healthy-provider", "stale-provider", "indeterminate-provider"], {
        "stale-provider": {
          status: 1,
          stderr: Buffer.from("Error: provider 'stale-provider' not found\n"),
        },
        "indeterminate-provider": missing("some-other-provider"),
      }),
    ).toEqual(["healthy-provider", "indeterminate-provider"]);
  });

  it("plans stale-provider cleanup without mutation until apply (#6226)", async () => {
    const removeExtraProvider = vi.fn(() => true);
    const plan = await planRegisteredExtraProviders("nemoclaw", {
      listExtraProviders: () => ["healthy-provider", "stale-provider"],
      removeExtraProvider,
      runOpenshell: (args) => (args.at(-1) === "stale-provider" ? missing("stale-provider") : ok()),
    });

    expect(plan).toEqual({
      extraProviders: ["healthy-provider"],
      staleExtraProviders: ["stale-provider"],
    });
    expect(removeExtraProvider).not.toHaveBeenCalled();

    applyExtraProviderReconciliation(plan, { removeExtraProvider });
    expect(removeExtraProvider).toHaveBeenCalledWith("stale-provider");
  });
});
