// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { AgentTurnClient, AgentTurnEvent, VoiceResponseEvent } from "./contracts";
import { VoiceGatewayRequestError } from "./contracts";
import { VoiceSessionService } from "./session-service";

class FakeAgentClient implements AgentTurnClient {
  readonly calls: Array<{
    idempotencyKey: string;
    message: string;
    sessionKey: string;
  }> = [];
  closed = false;
  run: (onEvent: (event: AgentTurnEvent) => void) => ReturnType<AgentTurnClient["runTurn"]> =
    async (onEvent) => {
      onEvent({ type: "started" });
      onEvent({ type: "text", text: "hello" });
      return { outcome: "completed" };
    };

  close(): void {
    this.closed = true;
  }

  runTurn(options: {
    readonly idempotencyKey: string;
    readonly message: string;
    readonly onEvent: (event: AgentTurnEvent) => void;
    readonly sessionKey: string;
  }): ReturnType<AgentTurnClient["runTurn"]> {
    this.calls.push({
      idempotencyKey: options.idempotencyKey,
      message: options.message,
      sessionKey: options.sessionKey,
    });
    return this.run(options.onEvent);
  }
}

function serviceFixture(
  overrides: {
    client?: FakeAgentClient;
    now?: () => number;
    randomIds?: string[];
    sessionLifetimeMs?: number;
    turnTimeoutMs?: number;
    maxResponseBytes?: number;
  } = {},
) {
  const client = overrides.client ?? new FakeAgentClient();
  const diagnostics: unknown[] = [];
  const ids = [...(overrides.randomIds ?? ["voice-session", "agent-session", "turn", "response"])];
  const service = new VoiceSessionService({
    runtimeIdentity: "voiceclaw-local",
    runtimeProfile: "voiceclaw-pinned",
    sandbox: "demo-sandbox",
    agent: "main",
    createClient: () => client,
    diagnostic: (entry) => diagnostics.push(entry),
    randomId: () => ids.shift() ?? "extra-id",
    randomGrant: () => Buffer.alloc(32, 7),
    ...(overrides.now ? { now: overrides.now } : {}),
    ...(overrides.sessionLifetimeMs ? { sessionLifetimeMs: overrides.sessionLifetimeMs } : {}),
    ...(overrides.turnTimeoutMs ? { turnTimeoutMs: overrides.turnTimeoutMs } : {}),
    ...(overrides.maxResponseBytes ? { maxResponseBytes: overrides.maxResponseBytes } : {}),
  });
  return { service, client, diagnostics };
}

describe("voice session and committed turn boundary", () => {
  it("binds trusted configuration and generates internal agent, turn, and response identities (#8378)", async () => {
    const { service, client } = serviceFixture();
    const created = service.createSession("runtime-conversation");
    const events: VoiceResponseEvent[] = [];

    await service.commitTurn({
      voiceSessionId: created.voiceSessionId,
      grant: created.grant,
      commitId: "runtime-commit",
      text: "repository status",
      deliver: (event) => events.push(event),
      deliveryOpen: () => true,
    });

    expect(created).toMatchObject({ voiceSessionId: "voice-session" });
    expect(created.grant).not.toContain("openclaw");
    expect(client.calls).toEqual([
      {
        idempotencyKey: "turn",
        message: "repository status",
        sessionKey: "agent:main:nemoclaw-voice:agent-session",
      },
    ]);
    expect(events).toEqual([
      {
        type: "response.started",
        voiceSessionId: "voice-session",
        turnId: "turn",
        responseId: "response",
      },
      {
        type: "response.text.delta",
        voiceSessionId: "voice-session",
        turnId: "turn",
        responseId: "response",
        sequence: 0,
        text: "hello",
      },
      {
        type: "response.completed",
        voiceSessionId: "voice-session",
        turnId: "turn",
        responseId: "response",
      },
    ]);
    service.closeAll();
  });

  it("rejects duplicate and overlapping runtime commit IDs without another invocation (#8378)", async () => {
    const client = new FakeAgentClient();
    let resolveRun: (value: { outcome: "completed" }) => void = () => {};
    client.run = async (onEvent) => {
      onEvent({ type: "started" });
      return new Promise((resolve) => {
        resolveRun = resolve;
      });
    };
    const { service } = serviceFixture({
      client,
      randomIds: ["voice-session", "agent-session", "turn", "response"],
    });
    const created = service.createSession("runtime-conversation");
    const first = service.commitTurn({
      voiceSessionId: created.voiceSessionId,
      grant: created.grant,
      commitId: "commit-one",
      text: "first",
      deliver: () => {},
      deliveryOpen: () => true,
    });

    await vi.waitFor(() => expect(client.calls).toHaveLength(1));
    await expect(
      service.commitTurn({
        voiceSessionId: created.voiceSessionId,
        grant: created.grant,
        commitId: "commit-one",
        text: "duplicate",
        deliver: () => {},
        deliveryOpen: () => true,
      }),
    ).rejects.toMatchObject({ code: "duplicate_turn" });
    await expect(
      service.commitTurn({
        voiceSessionId: created.voiceSessionId,
        grant: created.grant,
        commitId: "commit-two",
        text: "overlap",
        deliver: () => {},
        deliveryOpen: () => true,
      }),
    ).rejects.toMatchObject({ code: "turn_in_progress" });
    expect(client.calls).toHaveLength(1);
    resolveRun({ outcome: "completed" });
    await first;
    service.closeAll();
  });

  it("revokes the grant and closes the direct agent connection on close (#8378)", () => {
    const { service, client } = serviceFixture();
    const created = service.createSession("runtime-conversation");

    expect(() => service.closeSession(created.voiceSessionId, "wrong-grant")).toThrow(
      VoiceGatewayRequestError,
    );
    expect(client.closed).toBe(false);
    service.closeSession(created.voiceSessionId, created.grant);
    expect(client.closed).toBe(true);
    expect(() => service.closeSession(created.voiceSessionId, created.grant)).toThrow(
      "session_not_found",
    );
  });

  it("stops delivery after disconnect while allowing bounded agent work to finish (#8378)", async () => {
    const { service } = serviceFixture();
    const created = service.createSession("runtime-conversation");
    const events: VoiceResponseEvent[] = [];
    let open = true;

    await service.commitTurn({
      voiceSessionId: created.voiceSessionId,
      grant: created.grant,
      commitId: "runtime-commit",
      text: "repository status",
      deliver: (event) => {
        events.push(event);
        open = false;
      },
      deliveryOpen: () => open,
    });

    expect(events.map((event) => event.type)).toEqual(["response.started"]);
    service.closeAll();
  });

  it("returns one content-free failure when the response exceeds its bound (#8378)", async () => {
    const { service } = serviceFixture({ maxResponseBytes: 4 });
    const created = service.createSession("runtime-conversation");
    const events: VoiceResponseEvent[] = [];

    await service.commitTurn({
      voiceSessionId: created.voiceSessionId,
      grant: created.grant,
      commitId: "runtime-commit",
      text: "repository status",
      deliver: (event) => events.push(event),
      deliveryOpen: () => true,
    });

    expect(events.at(-1)).toMatchObject({
      type: "response.failed",
      reason: "response_too_large",
    });
    expect(events.filter((event) => event.type.endsWith("completed"))).toHaveLength(0);
    service.closeAll();
  });

  it("fails once when an agent client duplicates response.started (#8378)", async () => {
    const client = new FakeAgentClient();
    client.run = async (onEvent) => {
      onEvent({ type: "started" });
      onEvent({ type: "started" });
      return { outcome: "completed" };
    };
    const { service } = serviceFixture({ client });
    const created = service.createSession("runtime-conversation");
    const events: VoiceResponseEvent[] = [];

    await service.commitTurn({
      voiceSessionId: created.voiceSessionId,
      grant: created.grant,
      commitId: "runtime-commit",
      text: "repository status",
      deliver: (event) => events.push(event),
      deliveryOpen: () => true,
    });

    expect(events.filter((event) => event.type === "response.started")).toHaveLength(1);
    expect(events.filter((event) => event.type === "response.failed")).toEqual([
      expect.objectContaining({ reason: "agent_protocol_error" }),
    ]);
    expect(events.some((event) => event.type === "response.completed")).toBe(false);
    service.closeAll();
  });

  it("bounds a disconnected or stalled agent turn with one timeout outcome (#8378)", async () => {
    const client = new FakeAgentClient();
    client.run = async (onEvent) => {
      onEvent({ type: "started" });
      return new Promise(() => {});
    };
    const { service } = serviceFixture({ client, turnTimeoutMs: 5 });
    const created = service.createSession("runtime-conversation");
    const events: VoiceResponseEvent[] = [];

    await service.commitTurn({
      voiceSessionId: created.voiceSessionId,
      grant: created.grant,
      commitId: "runtime-commit",
      text: "repository status",
      deliver: (event) => events.push(event),
      deliveryOpen: () => true,
    });

    expect(client.closed).toBe(true);
    expect(events.filter((event) => event.type === "response.failed")).toEqual([
      expect.objectContaining({ reason: "turn_timeout" }),
    ]);
    expect(events.some((event) => event.type === "response.completed")).toBe(false);
    service.closeAll();
  });

  it("normalizes a thrown agent client into exactly one terminal failure (#8378)", async () => {
    const client = new FakeAgentClient();
    client.run = async () => {
      throw new Error("native error with private details");
    };
    const { service } = serviceFixture({ client });
    const created = service.createSession("runtime-conversation");
    const events: VoiceResponseEvent[] = [];

    await service.commitTurn({
      voiceSessionId: created.voiceSessionId,
      grant: created.grant,
      commitId: "runtime-commit",
      text: "repository status",
      deliver: (event) => events.push(event),
      deliveryOpen: () => true,
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: "response.failed",
        reason: "agent_gateway_unavailable",
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain("private details");
    service.closeAll();
  });

  it("expires the grant, removes the binding, and closes the agent connection (#8378)", () => {
    let now = 0;
    const { service, client } = serviceFixture({
      now: () => now,
      sessionLifetimeMs: 1_000,
    });
    const created = service.createSession("runtime-conversation");
    now = 1_000;

    expect(() => service.closeSession(created.voiceSessionId, created.grant)).toThrow(
      "session_not_found",
    );
    expect(client.closed).toBe(true);
  });

  it("keeps credentials and conversational content out of lifecycle diagnostics (#8378)", async () => {
    const { service, diagnostics } = serviceFixture();
    const created = service.createSession("runtime-conversation");

    await service.commitTurn({
      voiceSessionId: created.voiceSessionId,
      grant: created.grant,
      commitId: "runtime-commit",
      text: "private transcript and prompt",
      deliver: () => {},
      deliveryOpen: () => true,
    });

    const output = JSON.stringify(diagnostics);
    expect(output).not.toContain(created.grant);
    expect(output).not.toContain("private transcript");
    expect(output).not.toContain("hello");
    expect(output).not.toContain("agent:main:nemoclaw-voice");
    service.closeAll();
  });
});
