// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  type VoiceAgentClient,
  VoiceAgentError,
  type VoiceResponseEvent,
  VoiceSessionError,
  VoiceSessionService,
} from "./session-service";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function harness(
  invoke?: VoiceAgentClient["invoke"],
  options: { lifetime?: number; timeout?: number } = {},
) {
  const close = vi.fn();
  const invokeAgent = vi.fn(
    invoke ??
      (async (request) => {
        request.onRun("run-1");
        request.onText("known ");
        request.onText("state");
      }),
  );
  const client: VoiceAgentClient = {
    close,
    invoke: invokeAgent,
  };
  let id = 0;
  const diagnostics: unknown[] = [];
  const service = new VoiceSessionService({
    runtimeId: "runtime-a",
    runtimeProfile: "voiceclaw-pinned",
    sandbox: "sandbox-a",
    agent: "main",
    sessionLifetimeMs: options.lifetime ?? 60_000,
    turnTimeoutMs: options.timeout ?? 1_000,
    createAgentClient: () => client,
    randomId: () => `opaque-${++id}`,
    randomGrant: () => "session-grant-value-with-at-least-32-bytes",
    diagnostic: (value) => diagnostics.push(value),
  });
  return { service, client, close, diagnostics };
}

function create(h: ReturnType<typeof harness>) {
  return h.service.createSession("runtime-conversation-a");
}

function collect() {
  const events: VoiceResponseEvent[] = [];
  return { events, deliver: (event: VoiceResponseEvent) => (events.push(event), true) };
}

describe("experimental voice session state", () => {
  it("binds trusted runtime and agent configuration to an opaque session (#8378)", () => {
    const h = harness();
    const created = create(h);

    expect(created).toMatchObject({
      voiceSessionId: "opaque-1",
      runtimeId: "runtime-a",
      runtimeProfile: "voiceclaw-pinned",
      runtimeConversationId: "runtime-conversation-a",
      sandbox: "sandbox-a",
      agent: "main",
      agentSessionKey: "agent:main:voice:opaque-2",
    });
    expect(created.grant).toHaveLength(42);
    expect(h.service.getBindingForTest()).not.toHaveProperty("grant");
  });

  it("streams one ordered response with one terminal outcome (#8378)", async () => {
    const h = harness();
    const created = create(h);
    const output = collect();

    await h.service.startTurn(
      created.voiceSessionId,
      created.grant,
      "runtime-commit-a",
      "show repository status",
      output.deliver,
    );

    expect(output.events.map((event) => event.type)).toEqual([
      "response.started",
      "response.text.delta",
      "response.text.delta",
      "response.completed",
    ]);
    expect(output.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
    expect(output.events[1]).toMatchObject({
      text: "known ",
      turnId: "opaque-3",
      responseId: "opaque-4",
    });
    expect(h.client.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        agentSessionKey: "agent:main:voice:opaque-2",
        idempotencyKey: expect.not.stringContaining("runtime-commit-a"),
      }),
    );
    expect(h.close).toHaveBeenCalledOnce();
  });

  it("rejects duplicate and overlapping runtime commits without another invocation (#8378)", async () => {
    const running = deferred<void>();
    const invoke = vi.fn<VoiceAgentClient["invoke"]>((request) => {
      request.onRun("run-1");
      return running.promise;
    });
    const h = harness(invoke);
    const created = create(h);
    const output = collect();
    const first = h.service.startTurn(
      created.voiceSessionId,
      created.grant,
      "commit-a",
      "text",
      output.deliver,
    );
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());

    expect(() =>
      h.service.startTurn(
        created.voiceSessionId,
        created.grant,
        "commit-a",
        "text",
        output.deliver,
      ),
    ).toThrowError(expect.objectContaining({ code: "duplicate_turn" }));
    expect(() =>
      h.service.startTurn(
        created.voiceSessionId,
        created.grant,
        "commit-b",
        "text",
        output.deliver,
      ),
    ).toThrowError(expect.objectContaining({ code: "turn_in_progress" }));
    running.resolve();
    await first;
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("rejects a grant for another or expired voice session (#8378)", () => {
    vi.useFakeTimers();
    const h = harness(undefined, { lifetime: 50 });
    const created = create(h);

    expect(() => h.service.authorize("another-session", created.grant)).toThrowError(
      expect.objectContaining({ code: "session_not_found" }),
    );
    vi.advanceTimersByTime(51);
    expect(() => h.service.authorize(created.voiceSessionId, created.grant)).toThrowError(
      expect.objectContaining({ code: "session_not_found" }),
    );
    expect(h.close).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("bounds a running turn with a stable content-free failure (#8378)", async () => {
    vi.useFakeTimers();
    const h = harness(
      (request) =>
        new Promise((_resolve, reject) => {
          request.signal.addEventListener("abort", () =>
            reject(new VoiceAgentError("agent_unavailable")),
          );
        }),
      { timeout: 25 },
    );
    const created = create(h);
    const output = collect();
    const turn = h.service.startTurn(
      created.voiceSessionId,
      created.grant,
      "commit-a",
      "secret transcript",
      output.deliver,
    );
    await vi.advanceTimersByTimeAsync(26);
    await turn;

    expect(output.events.at(-1)).toMatchObject({ type: "response.failed", reason: "turn_timeout" });
    expect(JSON.stringify(h.diagnostics)).not.toContain("secret transcript");
    vi.useRealTimers();
  });

  it("stops response delivery after the runtime disconnects (#8378)", async () => {
    const h = harness(async (request) => {
      request.onRun("run-1");
      request.onText("first");
      request.onText("must-not-deliver");
    });
    const created = create(h);
    const events: VoiceResponseEvent[] = [];

    await h.service.startTurn(
      created.voiceSessionId,
      created.grant,
      "commit-a",
      "text",
      (event) => {
        events.push(event);
        return event.type !== "response.text.delta";
      },
    );

    expect(events.map((event) => event.type)).toEqual(["response.started", "response.text.delta"]);
  });

  it("closes active agent work when response delivery disconnects (#8378)", async () => {
    const running = deferred<void>();
    const h = harness(() => running.promise);
    const created = create(h);
    const turn = h.service.startTurn(
      created.voiceSessionId,
      created.grant,
      "commit-a",
      "text",
      () => true,
    );
    await vi.waitFor(() => expect(h.service.getBindingForTest()).toBeDefined());

    h.service.disconnectTurn(created.voiceSessionId);
    expect(h.close).toHaveBeenCalled();
    running.resolve();
    await turn;
  });

  it("reports stable reasons without agent error content (#8378)", async () => {
    const h = harness(async () => {
      throw new Error("native payload contains transcript and credential");
    });
    const created = create(h);
    const output = collect();

    await h.service.startTurn(
      created.voiceSessionId,
      created.grant,
      "commit-a",
      "sensitive prompt",
      output.deliver,
    );

    expect(output.events.at(-1)).toMatchObject({
      type: "response.failed",
      reason: "agent_unavailable",
    });
    expect(JSON.stringify(output.events)).not.toContain("native payload");
    expect(JSON.stringify(h.diagnostics)).not.toContain("sensitive prompt");
    expect(JSON.stringify(h.diagnostics)).not.toContain("credential");
  });

  it("closes the agent connection and revokes state when the session closes (#8378)", () => {
    const h = harness();
    const created = create(h);
    h.service.closeSession(created.voiceSessionId, created.grant);

    expect(h.service.getBindingForTest()).toBeUndefined();
    expect(h.close).toHaveBeenCalledOnce();
    expect(() => h.service.authorize(created.voiceSessionId, created.grant)).toThrow(
      VoiceSessionError,
    );
  });
  it("rejects duration values above the security maxima (#8378)", () => {
    expect(() => harness(undefined, { lifetime: 900_001 })).toThrow("between 1 and 900000");
    expect(() => harness(undefined, { timeout: 120_001 })).toThrow("between 1 and 120000");
  });
});
