// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type OnboardSessionModule = typeof import("./onboard-session");
type LoadedSession = NonNullable<ReturnType<OnboardSessionModule["loadSession"]>>;
let session: OnboardSessionModule;
let tmpDir: string;

function requireLoadedSession(
  loaded: ReturnType<OnboardSessionModule["loadSession"]>,
): LoadedSession {
  expect(loaded).not.toBeNull();
  return loaded as LoadedSession;
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-session-reasoning-effort-"));
  vi.stubEnv("HOME", tmpDir);
  vi.resetModules();
  session = await import("./onboard-session");
  session.clearSession();
  session.releaseOnboardLock();
});

afterEach(() => {
  session.clearSession();
  session.releaseOnboardLock();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("onboard session reasoning effort", () => {
  it("round-trips only valid compatible-endpoint reasoning effort updates", () => {
    session.saveSession(session.createSession());
    session.markStepComplete("provider_selection", {
      compatibleEndpointReasoningEffort: "high",
    });
    let loaded = requireLoadedSession(session.loadSession());
    expect(loaded.compatibleEndpointReasoningEffort).toBe("high");

    session.markStepComplete("provider_selection", {
      compatibleEndpointReasoningEffort: "extreme",
    } as never);
    loaded = requireLoadedSession(session.loadSession());
    expect(loaded.compatibleEndpointReasoningEffort).toBe("high");

    session.markStepComplete("provider_selection", {
      compatibleEndpointReasoningEffort: null,
    });
    expect(
      requireLoadedSession(session.loadSession()).compatibleEndpointReasoningEffort,
    ).toBeNull();
  });

  it.each([
    "default",
    "extreme",
    42,
  ])("rejects a persisted session with invalid reasoning effort %j", (invalidEffort) => {
    session.saveSession(
      session.createSession({
        compatibleEndpointReasoningEffort: "high",
      }),
    );
    const raw = JSON.parse(fs.readFileSync(session.SESSION_FILE, "utf8"));
    raw.compatibleEndpointReasoningEffort = invalidEffort;
    fs.writeFileSync(session.SESSION_FILE, JSON.stringify(raw));

    expect(session.loadSession()).toBeNull();
  });
});
