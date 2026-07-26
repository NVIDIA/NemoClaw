// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as sessionModule from "../state/onboard-session";
import {
  markLastStartedStepFailed,
  registerIncompleteOnboardExitFailureHandler,
} from "./exit-step-failure";
import { noteOnboardResumeHintShown, resetOnboardResumeHintForTests } from "./resume-hint";

const originalHome = process.env.HOME;
const restoreOriginalHome =
  originalHome === undefined
    ? () => {
        delete process.env.HOME;
      }
    : () => {
        process.env.HOME = originalHome;
      };
let tmpDir: string;
let session: typeof sessionModule;
let machineEvents: typeof import("./machine/events");

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-exit-step-failure-"));
  process.env.HOME = tmpDir;
  vi.resetModules();
  session = await import("../state/onboard-session");
  machineEvents = await import("./machine/events");
  machineEvents.clearOnboardMachineEventListeners();
  session.clearSession();
  resetOnboardResumeHintForTests();
});

afterEach(() => {
  machineEvents.clearOnboardMachineEventListeners();
  session.clearSession();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  restoreOriginalHome();
});

function missingLoadedSession(): never {
  throw new Error("Expected onboard session to be present");
}

function requireLoadedSession() {
  const loaded = session.loadSession();
  expect(loaded).not.toBeNull();
  return loaded ?? missingLoadedSession();
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

  it("simulates the onboard exit listener and ignores successful or complete exits", () => {
    const listeners: Array<(code: number) => void> = [];
    let complete = false;
    const processLike = {
      once: (event: "exit", listener: (code: number) => void) => {
        expect(event).toBe("exit");
        listeners.push(listener);
      },
    };
    session.saveSession(session.createSession({ lastStepStarted: "inference" }));
    // The incomplete exit also prints the #6003 resume hint; capture it.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    registerIncompleteOnboardExitFailureHandler(
      session,
      () => complete,
      "Onboarding exited before the step completed.",
      processLike,
    );
    listeners[0](0);
    expect(requireLoadedSession().status).toBe("in_progress");

    complete = true;
    listeners[0](1);
    expect(requireLoadedSession().status).toBe("in_progress");

    complete = false;
    listeners[0](1);
    errorSpy.mockRestore();

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
    const finalizeIncompleteOnboardStep = vi.fn(() => session.createSession());

    expect(
      markLastStartedStepFailed(
        { loadSession: () => session.createSession(), finalizeIncompleteOnboardStep },
        "boom",
      ),
    ).toBeNull();
    expect(finalizeIncompleteOnboardStep).not.toHaveBeenCalled();
  });

  it("records exactly one failed transition even if the exit backstop fires twice", () => {
    session.saveSession(session.createSession({ lastStepStarted: "inference" }));
    const emitted: string[] = [];
    machineEvents.addOnboardMachineEventListener((event) => emitted.push(event.type));

    markLastStartedStepFailed(session, "Onboarding exited before the step completed.");
    const afterFirst = requireLoadedSession();
    const revisionAfterFirst = afterFirst.machine.revision;
    expect(afterFirst.machine.state).toBe("failed");

    // A second backstop invocation must not re-transition an already-terminal
    // machine or bump the revision again.
    markLastStartedStepFailed(session, "Onboarding exited before the step completed.");
    const afterSecond = requireLoadedSession();
    expect(afterSecond.machine.state).toBe("failed");
    expect(afterSecond.machine.revision).toBe(revisionAfterFirst);
    expect(emitted).toEqual(["state.failed", "onboard.failed"]);
  });
});

describe("incomplete-onboard --resume backstop (#6003)", () => {
  function runExitHandler(code: number, { complete = false } = {}): string {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((message?: unknown) => {
      lines.push(String(message ?? ""));
    });
    const listeners: Array<(code: number) => void> = [];
    const processLike = {
      once: (_event: "exit", listener: (code: number) => void) => {
        listeners.push(listener);
      },
    };
    registerIncompleteOnboardExitFailureHandler(
      session,
      () => complete,
      "Onboarding exited before the step completed.",
      processLike,
    );
    listeners[0](code);
    spy.mockRestore();
    return lines.join("\n");
  }

  it("prints the resume hint when a step was in progress at exit", () => {
    session.saveSession(session.createSession({ lastStepStarted: "inference" }));
    expect(runExitHandler(1)).toContain("onboard --resume");
  });

  it("stays silent when no step had started", () => {
    session.saveSession(session.createSession());
    expect(runExitHandler(1)).not.toContain("--resume");
  });

  it("stays silent on a successful exit", () => {
    session.saveSession(session.createSession({ lastStepStarted: "inference" }));
    expect(runExitHandler(0)).not.toContain("--resume");
  });

  it("does not duplicate a tailored hint that already printed", () => {
    session.saveSession(session.createSession({ lastStepStarted: "sandbox" }));
    noteOnboardResumeHintShown();
    expect(runExitHandler(1)).not.toContain("--resume");
  });

  it("stays silent when cancel cleanup clears the session before a signal is re-raised", async () => {
    const signalListeners = new Map<"SIGINT" | "SIGTERM", () => void>();
    const kill = vi.fn();
    const processLike = {
      once: vi.fn(),
      on: (signal: "SIGINT" | "SIGTERM", listener: () => void) => {
        signalListeners.set(signal, listener);
      },
      removeListener: (signal: "SIGINT" | "SIGTERM", listener: () => void) => {
        expect(signalListeners.get(signal)).toBe(listener);
        signalListeners.delete(signal);
      },
      kill,
      pid: 4242,
    };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    session.saveSession(session.createSession({ lastStepStarted: "sandbox" }));

    registerIncompleteOnboardExitFailureHandler(
      session,
      () => false,
      "Onboarding exited before the step completed.",
      processLike,
    );
    const onSigterm = signalListeners.get("SIGTERM");
    expect(onSigterm).toBeDefined();
    onSigterm?.();
    session.clearSession();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(errorSpy).not.toHaveBeenCalled();
    expect(kill).toHaveBeenCalledOnce();
    expect(kill).toHaveBeenCalledWith(4242, "SIGTERM");
    errorSpy.mockRestore();
  });

  it.skipIf(process.platform === "win32")(
    "prints the resume hint before re-raising SIGINT in a real subprocess",
    async () => {
      const childDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-resume-signal-"));
      const childScript = path.join(childDir, "signal-resume-hint.cjs");
      const helperPath = path.resolve("src/lib/onboard/exit-step-failure.ts");
      fs.writeFileSync(
        childScript,
        `
const { registerIncompleteOnboardExitFailureHandler } = require(${JSON.stringify(helperPath)});

const resumableSession = { lastStepStarted: "inference" };
registerIncompleteOnboardExitFailureHandler(
  {
    loadSession: () => resumableSession,
    finalizeIncompleteOnboardStep: () => resumableSession,
  },
  () => false,
  "Onboarding exited before the step completed.",
);
process.stdout.write("ready\\n");
setInterval(() => {}, 1_000);
`,
      );

      const child = spawn(process.execPath, ["--require", "tsx/cjs", childScript], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });

      try {
        const [ready] = await once(child.stdout, "data");
        expect(String(ready)).toContain("ready");
        const exited = once(child, "exit");
        child.kill("SIGINT");
        const [code, signal] = await exited;
        expect(code).toBeNull();
        expect(signal).toBe("SIGINT");
        expect(stderr).toContain("onboard --resume");
      } finally {
        child.kill("SIGKILL");
        fs.rmSync(childDir, { recursive: true, force: true });
      }
    },
  );
});
