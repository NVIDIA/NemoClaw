// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitForPolicyMutation } from "./policy-preset-sync";

/**
 * `waitForPolicyMutation` polls through `waitUntil(fn, 10, 2000)`. Only the
 * explicit sandbox-not-found readiness condition reaches the 2-second poll.
 */
const MUTATION_POLL_INTERVAL_MS = 2_000;

/** Produced by `policySetFailure` for an accepted refusal result. */
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
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("attempts a rejected policy submission exactly once (#9206)", async () => {
    let attempts = 0;
    const mutate = async (): Promise<boolean> => {
      attempts += 1;
      throw new Error(REJECTION_ERROR_MESSAGE);
    };

    await expect(
      (async () => await waitForPolicyMutation("applyPresets(weather)", mutate))(),
    ).rejects.toThrow(REJECTION_ERROR_MESSAGE);
    expect(attempts).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("attempts a policy submission with an unconfirmed result exactly once (#9206)", async () => {
    let attempts = 0;
    const mutate = async (): Promise<boolean> => {
      attempts += 1;
      throw new Error(UNCONFIRMED_ERROR_MESSAGE);
    };

    await expect(
      (async () => await waitForPolicyMutation("applyPresets(weather)", mutate))(),
    ).rejects.toThrow(UNCONFIRMED_ERROR_MESSAGE);
    expect(attempts).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps re-polling a sandbox that has not appeared yet until the mutation lands (#9206)", async () => {
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
    const mutate = async (): Promise<boolean> => {
      const behaviour = behaviours[attempts] ?? (() => true);
      attempts += 1;
      return behaviour();
    };

    const pending = waitForPolicyMutation("applyPreset(slack)", mutate);
    await vi.advanceTimersByTimeAsync(2 * MUTATION_POLL_INTERVAL_MS);
    await expect(pending).resolves.toBeUndefined();
    expect(attempts).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("attempts a policy mutation that returns false exactly once (#9206)", async () => {
    let attempts = 0;
    const mutate = async (): Promise<boolean> => {
      attempts += 1;
      return false;
    };

    await expect(
      (async () => await waitForPolicyMutation("applyPreset(slack)", mutate))(),
    ).rejects.toThrow("applyPreset(slack) returned false");
    expect(attempts).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
