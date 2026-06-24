// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

type OnboardModule = typeof import("../dist/lib/onboard") & {
  onboardSession: typeof import("../dist/lib/state/onboard-session");
  registerIncompleteOnboardExitHandlerForSession: (
    isComplete: () => boolean,
    processLike: { once(event: "exit", listener: (code: number) => void): unknown },
  ) => void;
};

const require = createRequire(import.meta.url);
const onboard = require("../dist/lib/onboard.js") as OnboardModule;
const onboardSession = onboard.onboardSession;
const originalHome = process.env.HOME;
const restoreOriginalHome =
  originalHome === undefined
    ? () => {
        delete process.env.HOME;
      }
    : () => {
        process.env.HOME = originalHome;
      };

function requireLoadedSession() {
  const loaded = onboardSession.loadSession();
  expect(loaded).not.toBeNull();
  return loaded ?? onboardSession.createSession();
}

describe("onboard exit handler registration", () => {
  let tmpDir: string;
  let listeners: Array<(code: number) => void>;
  const processLike = {
    once: (event: "exit", listener: (code: number) => void) => {
      expect(event).toBe("exit");
      listeners.push(listener);
    },
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-exit-handler-"));
    process.env.HOME = tmpDir;
    listeners = [];
    onboardSession.clearSession();
  });

  afterEach(() => {
    onboardSession.clearSession();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    restoreOriginalHome();
  });

  it("onboard marks an incomplete nonzero exit as a terminal machine failure", () => {
    onboardSession.saveSession(onboardSession.createSession({ lastStepStarted: "inference" }));

    onboard.registerIncompleteOnboardExitHandlerForSession(() => false, processLike);
    listeners[0](0);
    expect(requireLoadedSession().status).toBe("in_progress");

    listeners[0](1);

    const loaded = requireLoadedSession();
    expect(loaded.steps.inference.status).toBe("failed");
    expect(loaded.status).toBe("failed");
    expect(loaded.failure?.step).toBe("inference");
    expect(loaded.failure?.message).toBe("Onboarding exited before the step completed.");
    expect(loaded.machine.state).toBe("failed");
  });

  it("onboard leaves completed nonzero exits untouched", () => {
    onboardSession.saveSession(onboardSession.createSession({ lastStepStarted: "inference" }));

    onboard.registerIncompleteOnboardExitHandlerForSession(() => true, processLike);
    listeners[0](1);

    const loaded = requireLoadedSession();
    expect(loaded.steps.inference.status).toBe("pending");
    expect(loaded.status).toBe("in_progress");
    expect(loaded.failure).toBeNull();
    expect(loaded.machine.state).toBe("init");
  });
});
