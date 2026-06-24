// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as sessionModule from "../state/onboard-session";
import { markLastStartedStepFailed } from "./terminal-step-failure";

const originalHome = process.env.HOME;
let tmpDir: string;
let session: typeof sessionModule;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-terminal-step-failure-"));
  process.env.HOME = tmpDir;
  vi.resetModules();
  session = await import("../state/onboard-session");
  session.clearSession();
});

afterEach(() => {
  session.clearSession();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
});

function requireLoadedSession() {
  const loaded = session.loadSession();
  expect(loaded).not.toBeNull();
  if (!loaded) throw new Error("Expected onboard session to be present");
  return loaded;
}

describe("terminal step failure helper", () => {
  it("marks onboard process-exit cleanup failures as terminal machine failures", () => {
    session.saveSession(session.createSession({ lastStepStarted: "inference" }));

    markLastStartedStepFailed(session, "Onboarding exited before the step completed.");

    const loaded = requireLoadedSession();
    expect(loaded.steps.inference.status).toBe("failed");
    expect(loaded.status).toBe("failed");
    expect(loaded.failure?.step).toBe("inference");
    expect(loaded.failure?.message).toBe("Onboarding exited before the step completed.");
    expect(loaded.machine.state).toBe("failed");
  });

  it("marks rebuild recreate cleanup failures as terminal machine failures", () => {
    session.saveSession(session.createSession({ lastStepStarted: "sandbox" }));

    markLastStartedStepFailed(session, "Rebuild recreate failed");

    const loaded = requireLoadedSession();
    expect(loaded.steps.sandbox.status).toBe("failed");
    expect(loaded.status).toBe("failed");
    expect(loaded.failure?.step).toBe("sandbox");
    expect(loaded.failure?.message).toBe("Rebuild recreate failed");
    expect(loaded.machine.state).toBe("failed");
  });

  it("leaves sessions without a started step untouched", () => {
    const markStepFailed = vi.fn(() => session.createSession());

    expect(
      markLastStartedStepFailed(
        { loadSession: () => session.createSession(), markStepFailed },
        "boom",
      ),
    ).toBeNull();
    expect(markStepFailed).not.toHaveBeenCalled();
  });
});
