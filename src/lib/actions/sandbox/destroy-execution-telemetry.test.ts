// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ record: vi.fn() }));
vi.mock("../telemetry/operation", () => ({
  finishTelemetryOperation: vi.fn(),
  recordTelemetryTarget: mocks.record,
}));

import { recordDestroyCompletion } from "./destroy-execution";

beforeEach(() => mocks.record.mockReset());

it.each([
  { mutationStarted: false, state: "unchanged" },
  { mutationStarted: true, state: "partial" },
])(
  "reports failed destroy as $state when mutation started is $mutationStarted (#12859)",
  async ({ mutationStarted, state }) => {
    await recordDestroyCompletion(
      "selected",
      "failed",
      undefined,
      "nemoclaw-19000",
      mutationStarted,
    );

    expect(mocks.record).toHaveBeenCalledExactlyOnceWith({
      scope: "sandbox",
      sandboxName: "selected",
      gatewayName: "nemoclaw-19000",
      outcome: "failed",
      state,
    });
  },
);
