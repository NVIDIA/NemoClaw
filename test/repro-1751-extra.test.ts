// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Additional coverage on top of the --gpu flag PR (#1751).
 *
 * The PR's own tests cover:
 *   - --gpu flag parsing in onboard-command (37 lines)
 *   - command-registry counts updated for the new flag (8 lines)
 *   - cli.test.ts dispatch (16 lines)
 *
 * What's not covered, that this file locks down:
 *   1. filterSafeUpdates → gpuPassthrough roundtrip. The CR review caught
 *      that gpuPassthrough was declared in SessionUpdates but not applied
 *      in filterSafeUpdates; the fix at session.ts:641-642 is unguarded.
 *      Without this regression test, a future refactor of filterSafeUpdates
 *      could silently drop gpuPassthrough again.
 *   2. Save/load roundtrip with gpuPassthrough=true persists the flag
 *      across session reloads (resume flows depend on this).
 *   3. Non-boolean gpuPassthrough updates are filtered out (defends against
 *      malformed session data resurrecting the silent-drop regression).
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

describe("Issue #1751 — extra coverage on --gpu flag persistence", () => {
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
});
