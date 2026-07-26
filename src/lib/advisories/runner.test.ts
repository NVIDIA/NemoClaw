// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { runAdvisories } from "./runner";
import type { Advisory, AdvisoryCheck } from "./types";

function advisory(id: string, overrides: Partial<Advisory> = {}): Advisory {
  return {
    id,
    severity: "warning",
    phase: "preflight.host",
    title: `Finding ${id}`,
    reason: `Reason ${id}`,
    resumeSafe: true,
    ...overrides,
  };
}

function check(
  id: string,
  run: AdvisoryCheck<{ enabled: boolean }>["check"],
  overrides: Partial<AdvisoryCheck<{ enabled: boolean }>> = {},
): AdvisoryCheck<{ enabled: boolean }> {
  return {
    id,
    severity: "warning",
    phase: "preflight.host",
    resumeSafe: true,
    check: run,
    ...overrides,
  };
}

describe("runAdvisories", () => {
  it("filters phases and skipped checks without evaluating them", () => {
    const hostRun = vi.fn(() => advisory("host"));
    const networkRun = vi.fn(() => advisory("network", { phase: "preflight.network" }));
    const skippedRun = vi.fn(() => advisory("skipped"));

    const result = runAdvisories(
      [
        check("host", hostRun),
        check("network", networkRun, { phase: "preflight.network" }),
        check("skipped", skippedRun, { skipIf: (context) => !context.enabled }),
      ],
      { enabled: false },
      { phase: "preflight.host" },
    );

    expect(result.advisories.map((item) => item.id)).toEqual(["host"]);
    expect(result.executedCheckIds).toEqual(["host"]);
    expect(result.results.get("skipped")).toBeNull();
    expect(hostRun).toHaveBeenCalledOnce();
    expect(networkRun).not.toHaveBeenCalled();
    expect(skippedRun).not.toHaveBeenCalled();
  });

  it("reuses only resume-safe cached results", () => {
    const safeRun = vi.fn(() => advisory("safe"));
    const unsafeRun = vi.fn(() => advisory("unsafe", { resumeSafe: false }));
    const cachedSafe = advisory("safe", { reason: "cached" });
    const cachedUnsafe = advisory("unsafe", { reason: "stale", resumeSafe: false });

    const result = runAdvisories(
      [check("safe", safeRun), check("unsafe", unsafeRun, { resumeSafe: false })],
      { enabled: true },
      {
        resuming: true,
        cachedResults: new Map([
          ["safe", cachedSafe],
          ["unsafe", cachedUnsafe],
        ]),
      },
    );

    expect(result.reusedCheckIds).toEqual(["safe"]);
    expect(result.executedCheckIds).toEqual(["unsafe"]);
    expect(result.results.get("safe")).toBe(cachedSafe);
    expect(result.results.get("unsafe")?.reason).toBe("Reason unsafe");
    expect(safeRun).not.toHaveBeenCalled();
    expect(unsafeRun).toHaveBeenCalledOnce();
  });

  it("suppresses presentation without discarding the evaluated result", () => {
    const result = runAdvisories(
      [check("hidden", () => advisory("hidden"))],
      { enabled: true },
      { suppressed: ["hidden"] },
    );

    expect(result.advisories).toEqual([]);
    expect(result.results.get("hidden")?.id).toBe("hidden");
  });

  it("does not suppress fatal or blocking findings", () => {
    const result = runAdvisories(
      [
        check("fatal", () => advisory("fatal", { severity: "fatal" }), {
          severity: "fatal",
        }),
        check("blocking", () => advisory("blocking", { severity: "blocking" }), {
          severity: "blocking",
        }),
      ],
      { enabled: true },
      { suppressed: ["fatal", "blocking"] },
    );

    expect(result.advisories.map((item) => item.id)).toEqual(["fatal", "blocking"]);
  });

  it("rejects duplicate IDs before a second check can overwrite the first", () => {
    expect(() =>
      runAdvisories([check("duplicate", () => null), check("duplicate", () => null)], {
        enabled: true,
      }),
    ).toThrow("Duplicate advisory check id 'duplicate'.");
  });

  it("rejects advisory metadata that diverges from its check", () => {
    expect(() =>
      runAdvisories([check("stable-id", () => advisory("different-id", { severity: "fatal" }))], {
        enabled: true,
      }),
    ).toThrow("Advisory check 'stable-id' returned mismatched metadata");
  });
});
