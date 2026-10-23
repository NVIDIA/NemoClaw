// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeniedSearchState, SEARCH_DENIAL_RETENTION_MS } from "./denied-search-state.js";

describe("denied-search identity retention", () => {
  let state: DeniedSearchState;
  let warn: () => void;
  beforeEach(() => {
    vi.useFakeTimers();
    warn = vi.fn<() => void>();
    state = new DeniedSearchState(warn, 2);
  });
  afterEach(() => {
    state.clear();
    vi.useRealTimers();
  });

  it("caps admitted identities and rejects excess turns", () => {
    state.deny("run-first");
    state.deny("run-second");
    state.deny("run-overflow");
    expect(state.size).toBe(2);
    expect(vi.getTimerCount()).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(state.blocks("run-first")).toBe(true);
    expect(state.admit("run-overflow")).toBe(false);
    expect(state.hasAdmission("run-overflow")).toBe(false);
    expect(state.blocks(undefined)).toBe(true);
    state.delete("run-first");
    expect(state.size).toBe(1);
    expect(state.blocks("run-first")).toBe(false);
    expect(state.admit("run-overflow")).toBe(true);
  });

  it("releases capacity after retained and excess turns finish", () => {
    state.deny("retained-first");
    state.deny("retained-second");
    state.deny("overflow-first");
    state.deny("overflow-second");
    state.delete("retained-first");
    state.delete("overflow-first");
    state.delete("retained-second");
    state.delete("overflow-second");
    expect(state.blocks("unrelated-run")).toBe(false);
    expect(state.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("expires abandoned admission slots without another tool call", () => {
    state.deny("run-first");
    state.deny("run-second");
    state.deny("run-overflow");
    vi.advanceTimersByTime(SEARCH_DENIAL_RETENTION_MS - 1);
    expect(state.size).toBe(2);
    vi.advanceTimersByTime(1);
    expect(state.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(state.blocks("ordinary-run")).toBe(false);
    expect(state.blocks(undefined)).toBe(true);
    state.deny("new-run");
    expect(state.blocks("new-run")).toBe(true);
    expect(state.size).toBe(1);
  });

  it("preserves active denial when admission repeats and releases capacity on completion", () => {
    expect(state.admit("ordinary")).toBe(true);
    state.deny("denied");
    expect(state.admit("denied")).toBe(true);
    expect(state.blocks("denied")).toBe(true);
    expect(state.blocks("ordinary")).toBe(false);
    expect(state.admit("excess")).toBe(false);
    state.delete("ordinary");
    expect(state.admit("excess")).toBe(true);
    expect(state.blocks("denied")).toBe(true);
    expect(state.size).toBe(2);
  });

  it("learns missing aliases from a known turn without losing its denial", () => {
    state.admit("runId:known");
    expect(
      state.hasAdmission("runId:known", ["runId:known", "sessionKey:session", "sessionId:id"]),
    ).toBe(true);
    state.deny("sessionKey:session");
    expect(state.blocks("runId:known")).toBe(true);
    state.delete(["sessionId:id"]);
    expect(state.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels its last timer after matching cleanup or configuration recovery", () => {
    state.deny("finished");
    state.delete("finished");
    expect(vi.getTimerCount()).toBe(0);
    state.deny("next");
    state.clear();
    expect(state.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(state.blocks("next")).toBe(false);
  });
});
