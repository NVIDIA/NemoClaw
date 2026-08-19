// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { getDockerGpuSupervisorReconnectTimeoutSecs } from "../../../src/lib/onboard/docker-gpu-supervisor-reconnect.ts";
import {
  ONBOARD_COMMAND_TIMEOUT_MS,
  ONBOARD_FINAL_HANDOFF_DIAGNOSTIC_HEADROOM_MS,
  ONBOARD_TEST_DIAGNOSTIC_HEADROOM_MS,
  ONBOARD_TEST_TIMEOUT_MS,
} from "../fixtures/onboard-timeout-contract.ts";

const finalHandoffTimeoutMs = getDockerGpuSupervisorReconnectTimeoutSecs(1, {}) * 1_000;

describe("onboard final-handoff timeout contract", () => {
  it("keeps the command alive through product convergence and its terminal diagnostic", () => {
    expect(ONBOARD_COMMAND_TIMEOUT_MS).toBeGreaterThanOrEqual(
      finalHandoffTimeoutMs + ONBOARD_FINAL_HANDOFF_DIAGNOSTIC_HEADROOM_MS,
    );
  });

  it("keeps the enclosing test alive beyond the command deadline", () => {
    expect(ONBOARD_TEST_TIMEOUT_MS).toBeGreaterThanOrEqual(
      ONBOARD_COMMAND_TIMEOUT_MS + ONBOARD_TEST_DIAGNOSTIC_HEADROOM_MS,
    );
  });

  it.each([
    ONBOARD_COMMAND_TIMEOUT_MS,
    ONBOARD_FINAL_HANDOFF_DIAGNOSTIC_HEADROOM_MS,
    ONBOARD_TEST_DIAGNOSTIC_HEADROOM_MS,
    ONBOARD_TEST_TIMEOUT_MS,
  ])("uses a positive whole-millisecond budget [case %#]", (value) => {
    expect(Number.isSafeInteger(value)).toBe(true);
    expect(value).toBeGreaterThan(0);
  });
});
