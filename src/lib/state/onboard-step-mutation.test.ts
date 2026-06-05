// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as eventsModule from "../onboard/machine/events";
import type * as sessionModule from "./onboard-session";

const originalHome = process.env.HOME;
let session: typeof sessionModule;
let machineEvents: typeof eventsModule;
let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-step-mutation-"));
  process.env.HOME = tmpDir;
  vi.resetModules();
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

    session.markStepFailedRecordOnly("gateway", "Gateway failed: NVIDIA_API_KEY=nvapi-secret");
    loaded = requireLoadedSession(session.loadSession());
    expect(loaded.steps.gateway.status).toBe("failed");
    expect(loaded.steps.gateway.error).toBe("Gateway failed: NVIDIA_API_KEY=<REDACTED>");
    expect(loaded.steps.gateway.error).not.toContain("nvapi-secret");
    expect(loaded.status).toBe("in_progress");
    expect(loaded.failure).toBeNull();
    expect(loaded.machine).toMatchObject({ state: "init", revision: 0 });
    expect(emitted.map((event) => event.type)).toEqual(["context.updated"]);
  });
});
