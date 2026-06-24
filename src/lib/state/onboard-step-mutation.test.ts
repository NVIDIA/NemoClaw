// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as eventsModule from "../onboard/machine/events";
import type * as sessionModule from "./onboard-session";
import type * as stepMutationModule from "./onboard-step-mutation";

const originalHome = process.env.HOME;
let session: typeof sessionModule;
let stepMutation: typeof stepMutationModule;
let machineEvents: typeof eventsModule;
let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-step-mutation-"));
  process.env.HOME = tmpDir;
  vi.resetModules();
  stepMutation = await import("./onboard-step-mutation");
  session = await import("./onboard-session");
  machineEvents = await import("../onboard/machine/events");
  machineEvents.clearOnboardMachineEventListeners();
  session.clearSession();
  session.releaseOnboardLock();
});

afterEach(() => {
  machineEvents.clearOnboardMachineEventListeners();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
});

function requireLoadedSession(loaded: ReturnType<typeof session.loadSession>) {
  expect(loaded).not.toBeNull();
  if (!loaded) throw new Error("Expected onboard session to be present");
  return loaded;
}

describe("record-only onboard step mutation", () => {
  it("freezes shared mutation option constants and preserves helper behavior", () => {
    expect(Object.isFrozen(stepMutation.LEGACY_MACHINE_STEP_MUTATION_OPTIONS)).toBe(true);
    expect(Object.isFrozen(stepMutation.RECORD_ONLY_STEP_MUTATION_OPTIONS)).toBe(true);
    expect(() => {
      (
        stepMutation.LEGACY_MACHINE_STEP_MUTATION_OPTIONS as { updateMachine?: boolean }
      ).updateMachine = false;
    }).toThrow(TypeError);
    expect(() => {
      (
        stepMutation.RECORD_ONLY_STEP_MUTATION_OPTIONS as { updateMachine?: boolean }
      ).updateMachine = true;
    }).toThrow(TypeError);

    session.saveSession(session.createSession());
    session.markStepStarted("preflight", stepMutation.LEGACY_MACHINE_STEP_MUTATION_OPTIONS);
    let loaded = requireLoadedSession(session.loadSession());
    expect(loaded.machine).toMatchObject({ state: "preflight", revision: 1 });

    session.markStepStartedRecordOnly("gateway");
    loaded = requireLoadedSession(session.loadSession());
    expect(loaded.steps.gateway.status).toBe("in_progress");
    expect(loaded.machine).toMatchObject({ state: "preflight", revision: 1 });
  });

  it("persists step status and per-step failure errors without mutating the machine snapshot", () => {
    const emitted: eventsModule.OnboardMachineEvent[] = [];
    machineEvents.addOnboardMachineEventListener((event) => emitted.push(event));
    session.saveSession(session.createSession());

    session.markStepStartedRecordOnly("preflight");
    let loaded = requireLoadedSession(session.loadSession());
    expect(loaded.steps.preflight.status).toBe("in_progress");
    expect(loaded.status).toBe("in_progress");
    expect(loaded.machine).toMatchObject({ state: "init", revision: 0 });

    session.markStepCompleteRecordOnly("preflight", { sandboxName: "my-assistant" });
    loaded = requireLoadedSession(session.loadSession());
    expect(loaded.steps.preflight.status).toBe("complete");
    expect(loaded.sandboxName).toBe("my-assistant");
    expect(loaded.machine).toMatchObject({ state: "init", revision: 0 });

    session.markStepFailedRecordOnly(
      "gateway",
      "Gateway failed: NVIDIA_INFERENCE_API_KEY=nvapi-secret",
    );
    loaded = requireLoadedSession(session.loadSession());
    expect(loaded.steps.gateway.status).toBe("failed");
    expect(loaded.steps.gateway.error).toBe("Gateway failed: NVIDIA_INFERENCE_API_KEY=<REDACTED>");
    expect(loaded.steps.gateway.error).not.toContain("nvapi-secret");
    expect(loaded.status).toBe("in_progress");
    expect(loaded.failure).toBeNull();
    expect(loaded.machine).toMatchObject({ state: "init", revision: 0 });
    expect(emitted.map((event) => event.type)).toEqual(["context.updated"]);
  });

  it("keeps no-options step helpers on legacy machine mutation", () => {
    const emitted: eventsModule.OnboardMachineEvent[] = [];
    machineEvents.addOnboardMachineEventListener((event) => emitted.push(event));
    session.saveSession(session.createSession());

    session.markStepStarted("preflight");
    let loaded = requireLoadedSession(session.loadSession());
    expect(loaded.machine).toMatchObject({ state: "preflight", revision: 1 });

    session.markStepComplete("preflight");
    loaded = requireLoadedSession(session.loadSession());
    expect(loaded.machine).toMatchObject({ state: "gateway", revision: 2 });

    session.markStepFailed("gateway", "Gateway failed: NVIDIA_INFERENCE_API_KEY=nvapi-secret");
    loaded = requireLoadedSession(session.loadSession());
    expect(loaded.status).toBe("failed");
    expect(loaded.failure?.message).toBe("Gateway failed: NVIDIA_INFERENCE_API_KEY=<REDACTED>");
    expect(loaded.failure?.message).not.toContain("nvapi-secret");
    expect(loaded.machine).toMatchObject({ state: "failed", revision: 3 });
    expect(emitted.map((event) => event.type)).toEqual([
      "state.entered",
      "state.completed",
      "state.failed",
      "onboard.failed",
    ]);
  });
});
