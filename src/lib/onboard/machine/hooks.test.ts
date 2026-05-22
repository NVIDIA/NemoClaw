// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createSession } from "../../state/onboard-session";
import {
  clearOnboardMachineEventListeners,
  createOnboardMachineEvent,
  emitOnboardMachineEvent,
  type OnboardMachineEvent,
} from "./events";
import { createJsonlOnboardHook, OnboardHookDispatcher, registerOnboardHooks } from "./hooks";

function sampleEvent(): OnboardMachineEvent {
  const session = createSession({
    sessionId: "session-1",
    provider: "nvidia-prod",
    endpointUrl: "https://example.com/v1?token=secret&keep=yes",
  });
  return createOnboardMachineEvent({
    type: "state.entered",
    session,
    state: "gateway",
    step: "gateway",
  });
}

afterEach(() => {
  clearOnboardMachineEventListeners();
});

describe("onboard machine hooks", () => {
  it("dispatches observe-only events and emits hook lifecycle events", async () => {
    const observed: string[] = [];
    const lifecycle: OnboardMachineEvent[] = [];
    const dispatcher = new OnboardHookDispatcher(
      [
        {
          name: "observer",
          onEvent(event) {
            observed.push(event.type);
          },
        },
      ],
      {
        emitEvent: (event) => lifecycle.push(event),
        now: () => "2026-05-19T01:00:00.000Z",
      },
    );

    await dispatcher.dispatch(sampleEvent());

    expect(observed).toEqual(["state.entered"]);
    expect(lifecycle.map((event) => event.type)).toEqual(["hook.started", "hook.completed"]);
    expect(lifecycle[0]).toMatchObject({
      sessionId: "session-1",
      state: "gateway",
      step: "gateway",
      metadata: { hook: "observer", sourceType: "state.entered" },
    });
  });

  it("warns and emits hook.failed without throwing when a hook fails", async () => {
    const warnings: string[] = [];
    const lifecycle: OnboardMachineEvent[] = [];
    const dispatcher = new OnboardHookDispatcher(
      [
        {
          name: "bad-hook",
          async onEvent() {
            throw new Error("Bearer super-secret-token");
          },
        },
      ],
      {
        warn: (message) => warnings.push(message),
        emitEvent: (event) => lifecycle.push(event),
        now: () => "2026-05-19T01:00:00.000Z",
      },
    );

    await expect(dispatcher.dispatch(sampleEvent())).resolves.toBeUndefined();

    expect(lifecycle.map((event) => event.type)).toEqual(["hook.started", "hook.failed"]);
    expect(lifecycle[1]).toMatchObject({
      type: "hook.failed",
      error: "Bearer <REDACTED>",
      metadata: { hook: "bad-hook", sourceType: "state.entered" },
    });
    expect(warnings).toEqual(["Onboard hook 'bad-hook' failed: Bearer <REDACTED>"]);
    expect(JSON.stringify(lifecycle)).not.toContain("super-secret-token");
    expect(warnings.join("\n")).not.toContain("super-secret-token");
  });

  it("writes JSONL hook events to an external sink", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hooks-"));
    try {
      const filePath = path.join(tmpDir, "events.jsonl");
      const hook = createJsonlOnboardHook(filePath);

      await hook.onEvent?.(sampleEvent());
      await hook.onEvent?.(
        createOnboardMachineEvent({
          type: "state.completed",
          session: createSession({ sessionId: "session-1" }),
          state: "gateway",
          step: "gateway",
        }),
      );

      const lines = fs
        .readFileSync(filePath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(lines.map((event) => event.type)).toEqual(["state.entered", "state.completed"]);
      expect(lines[0].context.endpointOrigin).toBe("https://example.com");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("registers hooks on the machine event bus without redispatching hook lifecycle events", async () => {
    const observed: string[] = [];
    const unregister = registerOnboardHooks([
      {
        name: "bus-observer",
        onEvent(event) {
          observed.push(event.type);
        },
      },
    ]);

    emitOnboardMachineEvent(sampleEvent());
    await Promise.resolve();
    emitOnboardMachineEvent({ ...sampleEvent(), type: "hook.failed" });
    await Promise.resolve();
    unregister();
    emitOnboardMachineEvent({ ...sampleEvent(), type: "state.completed" });
    await Promise.resolve();

    expect(observed).toEqual(["state.entered"]);
  });

  it("can observe hook lifecycle events without recursive lifecycle redispatch", async () => {
    const observed: string[] = [];
    const emittedLifecycle: string[] = [];
    const unregister = registerOnboardHooks(
      [
        {
          name: "lifecycle-observer",
          onEvent(event) {
            observed.push(event.type);
          },
        },
      ],
      {
        includeHookEvents: true,
        emitEvent(event) {
          emittedLifecycle.push(event.type);
          emitOnboardMachineEvent(event);
        },
      },
    );

    emitOnboardMachineEvent({ ...sampleEvent(), type: "hook.failed" });
    await Promise.resolve();
    unregister();

    expect(observed).toEqual(["hook.failed"]);
    expect(emittedLifecycle).toEqual([]);
  });
});
