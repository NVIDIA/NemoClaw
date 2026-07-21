// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { waitForAgentGatewayReady } from "./gateway-readiness";

function clock() {
  let nowMs = 10_000;
  const sleepSeconds = vi.fn((seconds: number) => {
    nowMs += seconds * 1000;
  });
  return { now: () => nowMs, sleepSeconds };
}

describe("waitForAgentGatewayReady", () => {
  it("returns immediately when the agent gateway is already ready", () => {
    const time = clock();
    const probe = vi.fn(() => true);

    expect(waitForAgentGatewayReady({ timeoutSeconds: 60, probe, ...time })).toBe(true);
    expect(probe).toHaveBeenCalledOnce();
    expect(time.sleepSeconds).not.toHaveBeenCalled();
  });

  it("retries quickly and succeeds before the deadline", () => {
    const time = clock();
    const probe = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);

    expect(waitForAgentGatewayReady({ timeoutSeconds: 60, probe, ...time })).toBe(true);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(time.sleepSeconds).toHaveBeenCalledWith(0.25);
  });

  it("uses the full short deadline before timing out", () => {
    const time = clock();
    const probe = vi.fn(() => false);

    expect(waitForAgentGatewayReady({ timeoutSeconds: 0.1, probe, ...time })).toBe(false);
    expect(time.sleepSeconds.mock.calls.reduce((total, [seconds]) => total + seconds, 0)).toBe(0.1);
  });

  it("does not probe when the configured deadline is zero", () => {
    const time = clock();
    const probe = vi.fn(() => true);

    expect(waitForAgentGatewayReady({ timeoutSeconds: 0, probe, ...time })).toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });
});
