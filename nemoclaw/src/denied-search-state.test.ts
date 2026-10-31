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

  it("caps denied identities and rejects excess turns", () => {
    state.admit("run-first");
    state.admit("run-second");
    state.deny("run-first");
    state.deny("run-second");
    expect(state.size).toBe(2);
    expect(vi.getTimerCount()).toBe(1);
    expect(state.blocks("run-first")).toBe(true);
    expect(state.canAdmit("run-overflow")).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(state.blocks("run-overflow")).toBe(true);
    expect(state.blocks(undefined)).toBe(true);
    state.delete("run-first");
    expect(state.size).toBe(1);
    expect(state.blocks("run-first")).toBe(true);
    expect(state.canAdmit("run-overflow")).toBe(true);
  });

  it("keeps supplied-source scope with its admitted turn and clears it on completion", () => {
    state.admit("runId:local", ["sessionKey:local"], { local: true, urls: [] });
    state.deny("runId:local");
    expect(state.blocks("runId:local", [], { kind: "local" })).toBe(false);
    expect(state.blocks("sessionKey:local", [], { kind: "local" })).toBe(false);
    expect(state.blocks("runId:local", [], { kind: "url", url: "https://example.org/" })).toBe(
      true,
    );
    state.admit("runId:external");
    state.deny("runId:external");
    expect(state.blocks("runId:external")).toBe(true);
    expect(state.admit("runId:overflow", [], { local: true, urls: [] })).toBe(false);
    expect(state.blocks("runId:overflow")).toBe(true);
    state.admit("runId:local");
    expect(state.blocks("runId:local", [], { kind: "local" })).toBe(true);
    state.delete("runId:local");
    expect(state.admit("runId:local")).toBe(true);
    state.deny("runId:local");
    expect(state.blocks("runId:local", [], { kind: "local" })).toBe(true);
  });

  it("binds supplied URLs to the admitted turn and replaces them on readmission", () => {
    const urls = [
      "https://DOCS.nvidia.com:443/nemoclaw/#intro",
      "file:///sandbox/README.md",
      "invalid",
    ];
    state.admit("runId:url", ["sessionKey:url"], { local: false, urls });
    urls.push("https://example.org/");
    state.deny("runId:url");
    expect(
      state.blocks("sessionKey:url", [], { kind: "url", url: "https://docs.nvidia.com/nemoclaw/" }),
    ).toBe(false);
    expect(state.blocks("runId:url", [], { kind: "url", url: "https://example.org/" })).toBe(true);
    expect(state.blocks("runId:url", [], { kind: "url", url: "file:///sandbox/README.md" })).toBe(
      true,
    );
    expect(
      state.blocks("runId:url", [], {
        kind: "url",
        url: "https://user:password@docs.nvidia.com/nemoclaw/",
      }),
    ).toBe(true);
    expect(state.blocks("runId:url", [], { kind: "local" })).toBe(true);
    state.admit("runId:url", [], { local: false, urls: ["https://example.org/"] });
    expect(
      state.blocks("runId:url", [], { kind: "url", url: "https://docs.nvidia.com/nemoclaw/" }),
    ).toBe(true);
    expect(state.blocks("runId:url", [], { kind: "url", url: "https://example.org/" })).toBe(false);
    state.admit("runId:url", [], { local: true, urls: ["https://example.org/"] });
    expect(state.blocks("runId:url", [], { kind: "local" })).toBe(false);
    expect(state.blocks("runId:url", [], { kind: "url", url: "https://example.org/" })).toBe(false);
    state.admit("runId:url", [], { local: true, urls: [] });
    expect(state.blocks("runId:url", [], { kind: "local" })).toBe(false);
    expect(state.blocks("runId:url", [], { kind: "url", url: "https://example.org/" })).toBe(true);
    state.delete("runId:url");
    expect(state.blocks("runId:url", [], { kind: "url", url: "https://example.org/" })).toBe(true);
  });

  it("recovers admission after denied turns complete without admitting overflow substitutes", () => {
    state.admit("retained-first");
    state.admit("retained-second");
    state.deny("retained-first");
    state.deny("retained-second");
    state.deny("overflow-first");
    state.deny("overflow-second");
    state.delete("retained-first");
    state.delete("overflow-first");
    state.delete("retained-second");
    state.delete("overflow-second");
    expect(state.blocks("overflow-second")).toBe(true);
    expect(state.canAdmit("unrelated-run")).toBe(true);
    expect(state.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(state.admit("unrelated-run")).toBe(true);
    expect(state.blocks("unrelated-run")).toBe(false);
    expect(state.blocks("overflow-second")).toBe(true);
  });

  it("expires abandoned denials without another tool call", () => {
    state.admit("run-first");
    state.admit("run-second");
    state.deny("run-first");
    state.deny("run-second");
    state.deny("run-overflow");
    vi.advanceTimersByTime(SEARCH_DENIAL_RETENTION_MS - 1);
    expect(state.size).toBe(2);
    vi.advanceTimersByTime(1);
    expect(state.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(state.admit("ordinary-run")).toBe(true);
    expect(state.blocks("ordinary-run")).toBe(false);
    expect(state.blocks(undefined)).toBe(true);
    state.admit("new-run");
    state.deny("new-run");
    expect(state.blocks("new-run")).toBe(true);
    expect(state.size).toBe(2);
  });

  it("preserves active denial when admission repeats and releases capacity on completion", () => {
    expect(state.admit("ordinary")).toBe(true);
    expect(state.blocks("ordinary")).toBe(false);
    state.delete("ordinary");
    state.admit("denied");
    state.deny("denied");
    expect(state.canAdmit("denied")).toBe(true);
    expect(state.blocks("denied")).toBe(true);
    expect(state.blocks("ordinary")).toBe(true);
    expect(state.size).toBe(1);
    state.admit("second-denied");
    state.deny("second-denied");
    expect(state.canAdmit("excess")).toBe(false);
    state.delete("second-denied");
    expect(state.canAdmit("excess")).toBe(true);
    expect(state.blocks("denied")).toBe(true);
    expect(state.size).toBe(1);
  });

  it("learns missing aliases from a known turn without losing its denial", () => {
    state.admit("runId:known");
    state.deny("runId:known");
    expect(state.blocks("runId:known", ["runId:known", "sessionKey:session", "sessionId:id"])).toBe(
      true,
    );
    state.deny("sessionKey:session");
    expect(state.blocks("runId:known")).toBe(true);
    state.delete(["sessionId:id"]);
    expect(state.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels its last timer after matching cleanup or configuration recovery", () => {
    state.admit("finished");
    state.deny("finished");
    state.delete("finished");
    expect(vi.getTimerCount()).toBe(0);
    state.admit("next");
    state.deny("next");
    state.clear();
    expect(state.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(state.blocks("next")).toBe(true);
    expect(state.admit("next")).toBe(true);
    expect(state.blocks("next")).toBe(false);
  });

  it("reserves every concurrent turn before search can exhaust denial ownership", () => {
    expect(state.admit("runId:first")).toBe(true);
    expect(state.admit("runId:second")).toBe(true);
    expect(state.admit("runId:overflow")).toBe(false);
    state.deny("runId:first");
    state.deny("runId:second");
    state.deny("runId:overflow");
    state.delete("runId:first");
    expect(state.blocks("runId:second")).toBe(true);
    expect(state.blocks("runId:overflow")).toBe(true);
    expect(state.admit("runId:ordinary-next")).toBe(true);
    expect(state.blocks("runId:ordinary-next")).toBe(false);
    state.delete("runId:second");
    state.delete("runId:ordinary-next");
    expect(state.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not reserve capacity for a denial without admission", () => {
    state.deny("unadmitted");
    expect(state.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(state.blocks("unadmitted")).toBe(true);
    expect(state.admit("unrelated")).toBe(true);
  });

  it("does not revive expired ownership through a tool denial", () => {
    state.admit("expired", [], { local: true, urls: [] });
    vi.setSystemTime(Date.now() + SEARCH_DENIAL_RETENTION_MS);
    state.deny("expired");
    expect(state.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(state.blocks("expired")).toBe(true);
  });

  it("keeps shared-session denials owned through overflow and partial completion", () => {
    state.admit("runId:first", ["sessionKey:shared"]);
    state.admit("runId:second", ["sessionKey:shared"]);
    state.deny("runId:first");
    state.deny("runId:second");
    state.deny("runId:overflow", ["sessionKey:shared"]);
    state.delete(["runId:overflow", "sessionKey:shared"]);
    state.delete(["sessionKey:shared"]);
    expect(state.size).toBe(2);
    state.delete(["runId:first", "sessionKey:shared"]);
    expect(state.blocks("runId:second")).toBe(true);
    expect(state.blocks("runId:overflow")).toBe(true);
    state.delete(["runId:unrelated", "sessionKey:shared"]);
    expect(state.size).toBe(1);
    state.delete(["runId:second", "sessionKey:shared"]);
    expect(state.admit("runId:ordinary-next")).toBe(true);
    expect(state.blocks("runId:ordinary-next")).toBe(false);
  });

  it("expires abandoned ordinary ownership and warns once again after recovery", () => {
    state.admit("runId:first");
    state.admit("runId:second");
    expect(state.admit("runId:overflow")).toBe(false);
    expect(state.admit("runId:another-overflow")).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(SEARCH_DENIAL_RETENTION_MS);
    expect(state.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    state.admit("runId:next-first");
    state.admit("runId:next-second");
    expect(state.admit("runId:next-overflow")).toBe(false);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
