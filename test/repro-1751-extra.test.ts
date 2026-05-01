// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Coverage for GPU passthrough session persistence (#1751, #999).
 *
 * GPU passthrough is auto-detected (enabled when NVIDIA GPU found),
 * but the intent is persisted in the session so resume flows preserve it.
 *
 * What this file locks down:
 *   1. filterSafeUpdates → gpuPassthrough roundtrip.
 *   2. Save/load roundtrip with gpuPassthrough=true persists across reloads.
 *   3. Non-boolean gpuPassthrough updates are filtered out.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as session from "../dist/lib/onboard-session";

const tmpHomes: string[] = [];

beforeEach(() => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-1751-"));
  tmpHomes.push(home);
  process.env.HOME = home;
});

afterEach(() => {
  for (const home of tmpHomes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

describe("Issue #1751 — GPU passthrough session persistence", () => {
  it("filterSafeUpdates: gpuPassthrough=true is propagated to safe", () => {
    session.saveSession(session.createSession());
    session.markStepComplete("provider_selection", { gpuPassthrough: true });
    const loaded = session.loadSession();
    expect(loaded.gpuPassthrough).toBe(true);
  });

  it("filterSafeUpdates: gpuPassthrough=false is propagated to safe", () => {
    const s = session.createSession({ gpuPassthrough: true });
    session.saveSession(s);
    session.markStepComplete("provider_selection", { gpuPassthrough: false });
    const loaded = session.loadSession();
    expect(loaded.gpuPassthrough).toBe(false);
  });

  it("save/load roundtrip preserves gpuPassthrough across reload", () => {
    const created = session.createSession({ gpuPassthrough: true });
    session.saveSession(created);
    const loaded = session.loadSession();
    expect(loaded.gpuPassthrough).toBe(true);
  });

  it("non-boolean gpuPassthrough updates are filtered out (silent-drop guard)", () => {
    session.saveSession(session.createSession({ gpuPassthrough: true }));
    // Garbage shapes: string, number, null. None should clobber the existing true.
    const garbageValues: unknown[] = ["yes", 1, null, undefined, "true"];
    for (const v of garbageValues) {
      session.markStepComplete("provider_selection", {
        gpuPassthrough: v as unknown as boolean,
      });
      const loaded = session.loadSession();
      expect(loaded.gpuPassthrough).toBe(true);
    }
  });

  it("default for fresh session is gpuPassthrough=false (no implicit GPU intent)", () => {
    const fresh = session.createSession();
    expect(fresh.gpuPassthrough).toBe(false);
  });

  it("gpuPassthrough can be set to true via createSession override (simulates auto-detect)", () => {
    const s = session.createSession({ gpuPassthrough: true });
    session.saveSession(s);
    const loaded = session.loadSession();
    expect(loaded.gpuPassthrough).toBe(true);
    // Verify summarizeForDebug includes it
    const summary = session.summarizeForDebug(loaded);
    expect(summary.gpuPassthrough).toBe(true);
  });

  it("normalizeSession handles missing gpuPassthrough (pre-auto-detect sessions)", () => {
    // Simulate a session saved before gpuPassthrough existed
    const s = session.createSession();
    session.saveSession(s);
    const raw = session.loadSession();
    // Remove gpuPassthrough to simulate old session data
    delete (raw as Record<string, unknown>).gpuPassthrough;
    const normalized = session.normalizeSession(raw);
    expect(normalized.gpuPassthrough).toBe(false);
  });
});
