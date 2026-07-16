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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-express-session-"));
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
});

describe("Station Express onboarding session state", () => {
  it("round-trips only canonical secret-free resume state", () => {
    const stationExpress = {
      version: 1 as const,
      model: "nemotron-3-ultra-550b-a55b",
      sandboxName: "my-assistant",
    };
    session.saveSession(
      session.createSession({ mode: "non-interactive", stationExpressIntent: stationExpress }),
    );

    expect(requireLoadedSession(session.loadSession()).stationExpressIntent).toEqual(
      stationExpress,
    );
    expect(fs.readFileSync(session.SESSION_FILE, "utf8")).not.toContain("token");
  });

  it("accepts legacy sessions without resume state and rejects malformed state", () => {
    const legacy = session.createSession() as unknown as Record<string, unknown>;
    delete legacy.stationExpressIntent;
    expect(
      requireLoadedSession(session.normalizeSession(legacy as never)).stationExpressIntent,
    ).toBeNull();

    const malformed = {
      ...session.createSession({ mode: "non-interactive" }),
      stationExpressIntent: {
        version: 1,
        model: "nemotron-3-ultra-550b-a55b",
        sandboxName: "my-assistant",
        HF_TOKEN: "must-not-persist",
      },
    };
    expect(session.normalizeSession(malformed as never)).toBeNull();
  });

  it("clears resume intent only after successful completion", () => {
    session.saveSession(
      session.createSession({
        mode: "non-interactive",
        stationExpressIntent: {
          version: 1,
          model: "nemotron-3-ultra-550b-a55b",
          sandboxName: "my-assistant",
        },
      }),
    );

    session.completeSession();

    expect(requireLoadedSession(session.loadSession()).stationExpressIntent).toBeNull();
  });
});
