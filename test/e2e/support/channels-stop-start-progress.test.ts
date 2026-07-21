// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  type ChannelsStopStartProgressOptions,
  startChannelsStopStartProgress,
} from "../live/channels-stop-start-progress.ts";

function progressHarness() {
  const state = {
    clearCalls: 0,
    lines: [] as string[],
    timerCallback: null as (() => void) | null,
    unrefCalls: 0,
  };
  const options: ChannelsStopStartProgressOptions = {
    heartbeatIntervalMs: 60_000,
    setTimer: (callback) => {
      state.timerCallback = callback;
      return {
        unref() {
          state.unrefCalls += 1;
        },
      };
    },
    clearTimer: () => {
      state.clearCalls += 1;
    },
    logLine: (line) => state.lines.push(line),
  };
  return { options, state };
}

describe("channels stop/start live progress", () => {
  it("emits secret-free liveness and stops idempotently", () => {
    const { options, state } = progressHarness();
    const progress = startChannelsStopStartProgress("hermes", options);

    state.timerCallback?.();
    progress.stop();
    progress.stop();

    expect(state.unrefCalls).toBe(1);
    expect(state.clearCalls).toBe(1);
    expect(state.lines).toEqual(["[channels-stop-start] live test still running for hermes"]);
  });

  it("keeps diagnostics best-effort when output fails", () => {
    const { options, state } = progressHarness();
    options.logLine = vi.fn(() => {
      throw new Error("closed output");
    });
    const progress = startChannelsStopStartProgress("openclaw", options);

    expect(() => state.timerCallback?.()).not.toThrow();
    progress.stop();
    expect(state.clearCalls).toBe(1);
  });
});
