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
    const calls: Array<{ args: string[]; options: Record<string, unknown> | undefined }> = [];
    const runOpenshell = vi.fn((args: string[], options?: Record<string, unknown>) => {
      calls.push({ args, options });
      return args.at(-1) === "custom-provider-127" ? missing("custom-provider-127") : ok();
    });

    expect(
      reconcileRegisteredExtraProviders("nemoclaw", {
        listExtraProviders: () => [...recorded],
        runOpenshell,
      }),
    ).toEqual(recorded.slice(0, -1));
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

  it("preserves providers for thrown, timed-out, process-error, and nonstandard probes (#6501)", () => {
    const warn = vi.fn();
    const recorded = [
      "thrown-provider",
      "timed-out-provider",
      "nonstandard-exit-provider",
      "buffer-error-provider",
    ];

    expect(
      reconcile(
        recorded,
        {
          "thrown-provider": () => {
            throw new Error("gateway process unavailable");
          },
          "timed-out-provider": { status: null, stderr: missing("timed-out-provider").stderr },
          "nonstandard-exit-provider": {
            status: 7,
            stderr: missing("nonstandard-exit-provider").stderr,
          },
          "buffer-error-provider": {
            status: 1,
            error: new Error("spawnSync ENOBUFS"),
            stderr: missing("buffer-error-provider").stderr,
          },
        },
        { warn },
      ),
    ).toEqual(recorded);
    expect(warn).toHaveBeenCalledWith(
      "  Warning: extra-provider reconciliation preserved indeterminate attachments " +
        "(providerCount=4; reasonClasses=probe-process-error,probe-threw,timeout-or-signal,unexpected-exit).",
    );
  });

  it("bounds aggregate probe latency and preserves names left after the deadline (#6501)", () => {
    let now = 0;
    const timeouts: number[] = [];
    const warn = vi.fn();
    const runOpenshell = vi.fn((_args: string[], options?: Record<string, unknown>) => {
      const timeout = Number(options?.timeout);
      timeouts.push(timeout);
      now += timeout;
      return { status: null, stderr: "provider process timed out" };
    });
    const recorded = ["provider-1", "provider-2", "provider-3", "provider-4", "provider-5"];

    expect(
      reconcileRegisteredExtraProviders("nemoclaw", {
        listExtraProviders: () => [...recorded],
        nowMs: () => now,
        runOpenshell,
        warn,
      }),
    ).toEqual(recorded);
    expect(runOpenshell).toHaveBeenCalledTimes(3);
    expect(timeouts).toEqual([5_000, 5_000, 5_000]);
    expect(warn).toHaveBeenCalledWith(
      "  Warning: extra-provider reconciliation preserved indeterminate attachments " +
        "(providerCount=5; reasonClasses=aggregate-time-budget,timeout-or-signal).",
    );
  });

  it("enforces gateway containment and requires a gateway name before probing (#6501)", () => {
    const runOpenshell = vi.fn((): ProbeResult => ok());
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://other.example.test");

    expect(() =>
      reconcileRegisteredExtraProviders("nemoclaw", {
        listExtraProviders: () => ["custom-provider"],
        runOpenshell,
      }),
    ).toThrow(/OPENSHELL_GATEWAY_ENDPOINT is set/);
    vi.unstubAllEnvs();
    expect(() =>
      reconcileRegisteredExtraProviders("", {
        listExtraProviders: () => ["custom-provider"],
        runOpenshell,
      }),
    ).toThrow("OpenShell gateway name is required.");
    expect(runOpenshell).not.toHaveBeenCalled();
  });
});
