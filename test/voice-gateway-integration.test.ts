// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVoiceGatewayServer } from "../src/lib/adapters/http/voice-gateway";
import { OpenClawVoiceAgentClient } from "../src/lib/adapters/openclaw/voice-agent-client";
import { VoiceSessionService } from "../src/lib/domain/voice/session-service";

const admission = "deployment-admission-credential-value-123456";
const openClawCredential = "openclaw-gateway-credential-value-12345678";
const httpServers: ReturnType<typeof createServer>[] = [];

class FakeOpenClawSocket extends EventTarget {
  static readonly OPEN = 1;
  readyState = FakeOpenClawSocket.OPEN;
  close = vi.fn();
  readonly invocations: Record<string, unknown>[] = [];

  start(): void {
    queueMicrotask(() => {
      this.dispatchEvent(new Event("open"));
      this.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "event",
            event: "connect.challenge",
            payload: { nonce: "fixture-challenge" },
          }),
        }),
      );
    });
  }

  send(data: string): void {
    const request = JSON.parse(data) as {
      id: string;
      method: string;
      params: Record<string, unknown>;
    };
    this.invocations.push(request.params);
    const payload =
      request.method === "chat.send" ? { runId: "fixture-run" } : { type: "hello-ok" };
    queueMicrotask(() => {
      this.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "res", id: request.id, ok: true, payload }),
        }),
      );
    });
    if (request.method !== "chat.send") return;
    const sessionKey = request.params.sessionKey;
    queueMicrotask(() => {
      for (const event of [
        {
          sessionKey: "other-session",
          runId: "fixture-run",
          seq: 1,
          state: "delta",
          deltaText: "discarded session",
        },
        {
          sessionKey,
          runId: "other-run",
          seq: 1,
          state: "delta",
          deltaText: "discarded run",
        },
        {
          sessionKey,
          runId: "fixture-run",
          seq: 1,
          state: "delta",
          deltaText: "branch: fixture\n",
        },
        {
          sessionKey,
          runId: "fixture-run",
          seq: 4,
          state: "delta",
          deltaText: "branch: wrong\nstatus: dirty",
          replace: true,
        },
        {
          sessionKey,
          runId: "fixture-run",
          seq: 7,
          state: "delta",
          deltaText: "branch: fixture\nstatus: clean",
          replace: true,
        },
        { sessionKey, runId: "fixture-run", seq: 9, state: "final" },
      ]) {
        this.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify({ type: "event", event: "chat", payload: event }),
          }),
        );
      }
    });
  }
}

async function fixture() {
  const socket = new FakeOpenClawSocket();
  const service = new VoiceSessionService({
    runtimeId: "trusted-runtime",
    runtimeProfile: "voiceclaw-pinned-fixture",
    sandbox: "fixture-sandbox",
    agent: "main",
    sessionLifetimeMs: 60_000,
    turnTimeoutMs: 5_000,
    createAgentClient: () =>
      new OpenClawVoiceAgentClient({
        endpoint: "ws://127.0.0.1:18789/ws",
        credential: openClawCredential,
        requestTimeoutMs: 2_000,
        createSocket: () => {
          socket.start();
          return socket as never;
        },
      }),
  });
  const gateway = createVoiceGatewayServer({
    admissionCredential: admission,
    sessionService: service,
  });
  httpServers.push(gateway);
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`,
    invocations: socket.invocations,
  };
}

async function createSession(base: string) {
  const response = await fetch(`${base}/v1/voice-sessions`, {
    method: "POST",
    headers: { authorization: `Bearer ${admission}`, "content-type": "application/json" },
    body: JSON.stringify({ runtimeConversationId: "fixture-conversation" }),
  });
  return (await response.json()) as { voiceSessionId: string; grant: string };
}

afterEach(async () => {
  await Promise.all(
    httpServers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe("composed experimental voice gateway", () => {
  it("routes a committed fixture turn into the runtime output path without exposing OpenClaw credentials (#8378)", async () => {
    const { base, invocations } = await fixture();
    const session = await createSession(base);
    const response = await fetch(`${base}/v1/voice-sessions/${session.voiceSessionId}/turns`, {
      method: "POST",
      headers: { authorization: `Bearer ${session.grant}`, "content-type": "application/json" },
      body: JSON.stringify({ commitId: "fixture-commit", text: "report repository status" }),
    });
    const raw = await response.text();
    const events = raw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const runtimeOutput: string[] = [];
    for (const event of events) {
      if (event.type === "response.text.delta") runtimeOutput.push(event.text);
    }

    expect(runtimeOutput.join("")).toBe("branch: fixture\nstatus: clean");
    expect(events.filter((event) => event.type === "response.completed")).toHaveLength(1);
    expect(events.filter((event) => event.type === "response.failed")).toHaveLength(0);
    expect(invocations[0]).toMatchObject({ scopes: ["operator.read", "operator.write"] });
    expect(invocations[1]).toMatchObject({ message: "report repository status", deliver: false });
    expect(raw).not.toContain(openClawCredential);
    expect(raw).not.toContain("fixture-run");
    expect(raw).not.toContain("chat.send");
  });
});
