// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Coverage for GPU passthrough session persistence (#1751, #999).
 *
 * GPU passthrough defaults on when an NVIDIA GPU is detected, can be
 * disabled with `--no-gpu`, and persists the resolved intent so resume flows
 * preserve it.
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
    const loaded = session.loadSession()!;
    expect(loaded.gpuPassthrough).toBe(true);
  });

  it("filterSafeUpdates: gpuPassthrough=false is propagated to safe", () => {
    const s = session.createSession({ gpuPassthrough: true });
    session.saveSession(s);
    session.markStepComplete("provider_selection", { gpuPassthrough: false });
    const loaded = session.loadSession()!;
    expect(loaded.gpuPassthrough).toBe(false);
  });

  it("save/load roundtrip preserves gpuPassthrough across reload", () => {
    const created = session.createSession({ gpuPassthrough: true });
    session.saveSession(created);
    const loaded = session.loadSession()!;
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
      const loaded = session.loadSession()!;
      expect(loaded.gpuPassthrough).toBe(true);
    }
  });

  it("default for fresh session is gpuPassthrough=false (no implicit GPU intent)", () => {
    const fresh = session.createSession();
    expect(fresh.gpuPassthrough).toBe(false);
  });

  it("gpuPassthrough can be set to true via createSession override (simulates resolved GPU intent)", () => {
    const s = session.createSession({ gpuPassthrough: true });
    session.saveSession(s);
    const loaded = session.loadSession()!;
    expect(loaded.gpuPassthrough).toBe(true);
    // Verify summarizeForDebug includes it
    const summary = session.summarizeForDebug(loaded);
    expect(summary!.gpuPassthrough).toBe(true);
  });

  it("completeSession persists gpuPassthrough via filterSafeUpdates", () => {
    session.saveSession(session.createSession());
    session.markStepStarted("preflight");
    session.markStepComplete("preflight", { gpuPassthrough: true });
    session.markStepStarted("gateway");
    session.markStepComplete("gateway");
    session.markStepStarted("sandbox");
    session.markStepComplete("sandbox");
    session.completeSession({ gpuPassthrough: true });
    const loaded = session.loadSession()!;
    expect(loaded.gpuPassthrough).toBe(true);
  });

  it("clearSession removes gpuPassthrough along with everything else", () => {
    session.saveSession(session.createSession({ gpuPassthrough: true }));
    session.clearSession();
    const loaded = session.loadSession();
    expect(loaded).toBeNull();
  });

  it("markStepFailed preserves gpuPassthrough", () => {
    session.saveSession(session.createSession({ gpuPassthrough: true }));
    session.markStepStarted("gateway");
    session.markStepFailed("gateway", "test failure");
    const loaded = session.loadSession()!;
    expect(loaded.gpuPassthrough).toBe(true);
    expect(loaded.steps.gateway?.status).toBe("failed");
  });

  it("normalizeSession handles missing gpuPassthrough (pre-GPU-intent sessions)", () => {
    // Simulate a session saved before gpuPassthrough existed
    const s = session.createSession();
    session.saveSession(s);
    const raw = session.loadSession()!;
    // Remove gpuPassthrough to simulate old session data
    delete (raw as unknown as Record<string, unknown>).gpuPassthrough;
    const normalized = session.normalizeSession(raw)!;
    expect(normalized.gpuPassthrough).toBe(false);
  });
});
