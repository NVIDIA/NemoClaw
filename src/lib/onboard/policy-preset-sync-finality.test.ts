// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import { waitForPolicyMutation } from "./policy-preset-sync";

/**
 * `waitForPolicyMutation` polls through `waitUntil(fn, 10, 2000)`: a 10-second
 * budget probed every 2 seconds. That admits attempts at 0s, 2s, 4s, 6s and 8s
 * before the budget expires.
 */
const MUTATION_BUDGET_MS = 10_000;
const MUTATION_POLL_INTERVAL_MS = 2_000;
const MAX_MUTATION_ATTEMPTS = 5;

/** Produced by `policySetFailure` when OpenShell returns an authoritative refusal. */
const REJECTION_ERROR_MESSAGE =
  "OpenShell rejected the policy for sandbox 'sb-9206' (exit 1): " +
  "unsupported field in network_policies.weather. The policy was not applied and " +
  "re-applying it will be rejected again; change the preset selection instead.";

/** Produced by `policySetFailure` when the submission result is unconfirmed. */
const UNCONFIRMED_ERROR_MESSAGE =
  "Could not confirm the policy update for sandbox 'sb-9206': h2 protocol error. " +
  "The gateway may or may not have applied it; read the current policy back before retrying.";

/** Thrown while a sandbox is still starting; the one exception worth re-polling. */
const TRANSIENT_STARTUP_ERROR_MESSAGE = "sandbox not found: sb-9206";

describe("waitForPolicyMutation", () => {
  let clockMs = 0;
  let sleptMs: number[] = [];

  beforeEach(() => {
    // `waitUntil` measures its budget with Date.now and burns it in a blocking
    // Atomics.wait. Driving one synthetic clock from the other keeps the real
    // polling arithmetic while costing no wall-clock time.
    clockMs = 1_700_000_000_000;
    sleptMs = [];
    vi.spyOn(Date, "now").mockImplementation(() => clockMs);
    vi.spyOn(Atomics, "wait").mockImplementation((_typedArray, _index, _value, timeout) => {
      const durationMs = typeof timeout === "number" ? timeout : 0;
      sleptMs.push(durationMs);
      clockMs += durationMs;
      return "timed-out";
    });
  });

  it("attempts a policy submission that OpenShell rejected exactly once (#9206)", () => {
    let attempts = 0;
    const mutate = (): boolean => {
      attempts += 1;
      throw new Error(REJECTION_ERROR_MESSAGE);
    };

    expect(() => waitForPolicyMutation("applyPresets(weather)", mutate)).toThrow(
      REJECTION_ERROR_MESSAGE,
    );
    expect(attempts).toBe(1);
    expect(sleptMs).toEqual([]);
  });

  it("attempts a policy submission with an unconfirmed result exactly once (#9206)", () => {
    let attempts = 0;
    const mutate = (): boolean => {
      attempts += 1;
      throw new Error(UNCONFIRMED_ERROR_MESSAGE);
    };

    expect(() => waitForPolicyMutation("applyPresets(weather)", mutate)).toThrow(
      UNCONFIRMED_ERROR_MESSAGE,
    );
    expect(attempts).toBe(1);
    expect(sleptMs).toEqual([]);
  });

  it("keeps re-polling a sandbox that has not appeared yet until the mutation lands (#9206)", () => {
    const behaviours: ReadonlyArray<() => boolean> = [
      () => {
        throw new Error(TRANSIENT_STARTUP_ERROR_MESSAGE);
      },
      () => {
        throw new Error(TRANSIENT_STARTUP_ERROR_MESSAGE);
      },
      () => true,
    ];
    let attempts = 0;
    const mutate = (): boolean => {
      const behaviour = behaviours[attempts] ?? (() => true);
      attempts += 1;
      return behaviour();
    };

    expect(() => waitForPolicyMutation("applyPreset(slack)", mutate)).not.toThrow();
    expect(attempts).toBe(3);
    expect(sleptMs).toEqual([MUTATION_POLL_INTERVAL_MS, MUTATION_POLL_INTERVAL_MS]);
  });

  it("bounds a readiness poll that keeps returning false (#9206)", () => {
    const startedAtMs = clockMs;
    let attempts = 0;
    const mutate = (): boolean => {
      attempts += 1;
      return false;
    };

    expect(() => waitForPolicyMutation("applyPreset(slack)", mutate)).toThrow(
      "applyPreset(slack) returned false",
    );
    expect(attempts).toBe(MAX_MUTATION_ATTEMPTS);
    expect(attempts).toBeLessThanOrEqual(MUTATION_BUDGET_MS / MUTATION_POLL_INTERVAL_MS);
    expect(clockMs - startedAtMs).toBeLessThanOrEqual(MUTATION_BUDGET_MS);
  });
});
