// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { waitForSandboxDeleteAbsence } from "../../adapters/openshell/sandbox-lifecycle-cli";
import type { CliOpenShellSandboxLookup } from "../../adapters/openshell/sandbox-observer-cli";

const present = {
  result: {
    ok: true,
    value: {
      state: "present",
      sandbox: { name: "alpha", phase: "Deleting", readiness: "not_ready" },
    },
  },
  displayOutput: "",
} as const;

const missing = {
  result: { ok: true, value: { state: "missing" } },
  displayOutput: "",
} as const;

describe("sandbox delete convergence", () => {
  it("waits for explicit exact-gateway absence after transient presence (#11941)", async () => {
    let currentMs = 0;
    const lookup = vi
      .fn<CliOpenShellSandboxLookup>()
      .mockResolvedValueOnce(present)
      .mockResolvedValueOnce(missing);

    const result = await waitForSandboxDeleteAbsence("alpha", "nemoclaw", lookup, vi.fn(), {
      now: () => currentMs,
      sleep: (milliseconds) => {
        currentMs += milliseconds;
      },
    });

    expect(result).toMatchObject({ confirmed: true, attempts: 2, lastObservation: missing.result });
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(lookup).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        sandboxName: "alpha",
        target: { kind: "named", gatewayName: "nemoclaw" },
      }),
    );
  });

  it("fails closed when the same-name sandbox remains present through the bound (#11941)", async () => {
    let currentMs = 0;
    const lookup = vi.fn<CliOpenShellSandboxLookup>().mockResolvedValue(present);

    const result = await waitForSandboxDeleteAbsence("alpha", "nemoclaw", lookup, vi.fn(), {
      now: () => currentMs,
      sleep: (milliseconds) => {
        currentMs += milliseconds;
      },
    });

    expect(result.confirmed).toBe(false);
    expect(result.attempts).toBeGreaterThan(1);
    expect(result.attempts).toBeLessThanOrEqual(20);
    expect(result.lastObservation).toEqual(present.result);
    expect(currentMs).toBeLessThanOrEqual(15_000);
  });
});
