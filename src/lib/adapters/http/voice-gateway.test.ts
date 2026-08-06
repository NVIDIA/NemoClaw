// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type VoiceAgentClient, VoiceSessionService } from "../../domain/voice/session-service";
import { createVoiceGatewayServer } from "./voice-gateway";

const admission = "deployment-admission-credential-value-123456";
const servers: ReturnType<typeof createVoiceGatewayServer>[] = [];

function makeService(invoke?: VoiceAgentClient["invoke"]) {
  return new VoiceSessionService({
    runtimeId: "runtime-a",
    runtimeProfile: "voiceclaw-pinned",
    sandbox: "sandbox-a",
    agent: "main",
    sessionLifetimeMs: 60_000,
    turnTimeoutMs: 1_000,
    createAgentClient: () => ({
      close: vi.fn(),
      invoke:
        invoke ??
        (async (request) => {
          request.onRun("expected-run");
          request.onText("fixture output");
        }),
    }),
  });
}

async function start(service = makeService()) {
  const server = createVoiceGatewayServer({
    admissionCredential: admission,
    sessionService: service,
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { service, base: `http://127.0.0.1:${port}` };
}

async function create(
  base: string,
  credential = admission,
  body: Record<string, unknown> = { runtimeConversationId: "conversation-a" },
) {
  const response = await fetch(`${base}/v1/voice-sessions`, {
    method: "POST",
    headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, body: (await response.json()) as Record<string, string> };
}

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe("experimental voice HTTP adapter", () => {
  it("keeps the health check content-free without authenticating (#8378)", async () => {
    const { base } = await start();
    const response = await fetch(`${base}/healthz`);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  it("requires the deployment credential before session admission (#8378)", async () => {
    const { base, service } = await start();
    const missing = await fetch(`${base}/v1/voice-sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runtimeConversationId: "conversation-a" }),
    });
    const incorrect = await create(base, "incorrect-credential-value-with-32-bytes");

    expect(missing.status).toBe(401);
    expect(incorrect.response.status).toBe(401);
    expect(service.getBindingForTest()).toBeUndefined();
  });

  it("rejects runtime-selected forwarding and agent fields (#8378)", async () => {
    const { base, service } = await start();
    const result = await create(base, admission, {
      runtimeConversationId: "conversation-a",
      agent: "attacker-agent",
      openClawEndpoint: "ws://attacker.example",
    });

    expect(result.response.status).toBe(400);
    expect(result.body).toEqual({ error: "invalid_request" });
    expect(service.getBindingForTest()).toBeUndefined();
  });

  it("streams normalized NDJSON and does not expose OpenClaw credentials or frames (#8378)", async () => {
    const { base } = await start();
    const admitted = await create(base);
    const response = await fetch(
      `${base}/v1/voice-sessions/${admitted.body.voiceSessionId}/turns`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${admitted.body.grant}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ commitId: "commit-a", text: "repository status" }),
      },
    );
    const text = await response.text();
    const events = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-ndjson");
    expect(events.map((event) => event.type)).toEqual([
      "response.started",
      "response.text.delta",
      "response.completed",
    ]);
    expect(text).not.toContain("chat.send");
    expect(text).not.toContain("expected-run");
    expect(text).not.toContain(admission);
  });

  it("scopes the session grant and returns bounded conflict results (#8378)", async () => {
    let finish!: () => void;
    const invoke = vi.fn<VoiceAgentClient["invoke"]>(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    const { base } = await start(makeService(invoke));
    const admitted = await create(base);
    const turnUrl = `${base}/v1/voice-sessions/${admitted.body.voiceSessionId}/turns`;
    const first = fetch(turnUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${admitted.body.grant}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ commitId: "commit-a", text: "first" }),
    });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
    const overlapping = await fetch(turnUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${admitted.body.grant}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ commitId: "commit-b", text: "second" }),
    });

    expect(overlapping.status).toBe(409);
    finish();
    await first;
    const duplicate = await fetch(turnUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${admitted.body.grant}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ commitId: "commit-a", text: "first" }),
    });
    expect(duplicate.status).toBe(409);
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("rejects oversized turn requests before invoking the agent (#8378)", async () => {
    const invoke = vi.fn<VoiceAgentClient["invoke"]>();
    const { base } = await start(makeService(invoke));
    const admitted = await create(base);
    const response = await fetch(
      `${base}/v1/voice-sessions/${admitted.body.voiceSessionId}/turns`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${admitted.body.grant}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ commitId: "commit-a", text: "x".repeat(21 * 1024) }),
      },
    );

    expect(response.status).toBe(413);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("revokes the grant when the runtime closes the session (#8378)", async () => {
    const { base, service } = await start();
    const admitted = await create(base);
    const response = await fetch(`${base}/v1/voice-sessions/${admitted.body.voiceSessionId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${admitted.body.grant}` },
    });
    const reuse = await fetch(`${base}/v1/voice-sessions/${admitted.body.voiceSessionId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${admitted.body.grant}` },
    });

    expect(response.status).toBe(204);
    expect(reuse.status).toBe(404);
    expect(service.getBindingForTest()).toBeUndefined();
  });
});
