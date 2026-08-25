// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import http, { type Server } from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createVoiceGatewayServer } from "../../../src/lib/adapters/http/voice-gateway-server";
import type { AgentTurnClient, AgentTurnEvent } from "../../../src/lib/voice-gateway/contracts";
import { readPrivateBearerDescriptors } from "../../../src/lib/voice-gateway/credential-file";
import { OpenClawVoiceClient } from "../../../src/lib/voice-gateway/openclaw-client";
import { VoiceSessionService } from "../../../src/lib/voice-gateway/session-service";
import { PinnedOpenClawGateway } from "../../fixtures/voice-gateway/pinned-openclaw-gateway";
import { PinnedVoiceRuntimeAdapter } from "../../fixtures/voice-gateway/pinned-runtime-adapter";

const DEPLOYMENT_BEARER = "deployment-bearer-for-voice-gateway-tests";
const OPENCLAW_CREDENTIAL = "openclaw-credential-stays-in-nemoclaw";
const servers = new Set<Server>();

class FakeOpenClawGatewayClient implements AgentTurnClient {
  readonly calls: Array<{
    idempotencyKey: string;
    message: string;
    sessionKey: string;
    credential: string;
  }> = [];
  closed = false;

  constructor(private readonly credential: string) {}

  close(): void {
    this.closed = true;
  }

  async runTurn(options: {
    readonly idempotencyKey: string;
    readonly message: string;
    readonly onEvent: (event: AgentTurnEvent) => void;
    readonly sessionKey: string;
  }): ReturnType<AgentTurnClient["runTurn"]> {
    this.calls.push({
      idempotencyKey: options.idempotencyKey,
      message: options.message,
      sessionKey: options.sessionKey,
      credential: this.credential,
    });
    options.onEvent({ type: "started" });
    options.onEvent({ type: "text", text: "working tree " });
    options.onEvent({ type: "text", text: "is clean" });
    return { outcome: "completed" };
  }
}

async function listen(server: Server): Promise<number> {
  servers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  expect(address).toBeTruthy();
  expect(typeof address).not.toBe("string");
  return (address as { readonly port: number }).port;
}

async function requestJson(options: {
  readonly port: number;
  readonly method: string;
  readonly path: string;
  readonly bearer?: string;
  readonly body?: object;
}): Promise<{ readonly status: number; readonly body: string }> {
  const body = options.body ? JSON.stringify(options.body) : "";
  return new Promise((resolve, reject) => {
    const client = http.request(
      {
        host: "127.0.0.1",
        port: options.port,
        method: options.method,
        path: options.path,
        headers: {
          ...(options.bearer ? { authorization: `Bearer ${options.bearer}` } : {}),
          ...(body
            ? {
                "content-length": String(Buffer.byteLength(body)),
                "content-type": "application/json",
              }
            : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    client.once("error", reject);
    client.end(body);
  });
}

afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve) => {
          servers.delete(server);
          server.listening ? server.close(() => resolve()) : resolve();
        }),
    ),
  );
});

describe("experimental voice gateway composed boundary", () => {
  it("fails closed when the launcher swaps the fixed credential roles (#9235)", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-voice-swapped-"));
    try {
      const deploymentPath = path.join(directory, "deployment");
      const openClawPath = path.join(directory, "openclaw");
      fs.writeFileSync(deploymentPath, DEPLOYMENT_BEARER, { mode: 0o600 });
      fs.writeFileSync(openClawPath, OPENCLAW_CREDENTIAL, { mode: 0o600 });
      const credentials = readPrivateBearerDescriptors({
        deployment: fs.openSync(
          openClawPath,
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
        ),
        openClaw: fs.openSync(
          deploymentPath,
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
        ),
      });
      let clientsCreated = 0;
      const service = new VoiceSessionService({
        runtimeIdentity: "voiceclaw-local",
        runtimeProfile: "voiceclaw-pinned",
        sandbox: "repository-fixture",
        agent: "main",
        createClient: () => {
          clientsCreated += 1;
          return new FakeOpenClawGatewayClient(credentials.openClawCredential);
        },
      });
      const port = await listen(
        createVoiceGatewayServer({
          deploymentCredential: credentials.deploymentCredential,
          service,
        }),
      );

      const response = await requestJson({
        port,
        method: "POST",
        path: "/v1/voice/sessions",
        bearer: DEPLOYMENT_BEARER,
        body: { runtimeConversationId: "runtime-conversation" },
      });

      expect(response).toEqual({ status: 401, body: '{"error":"authentication_failed"}' });
      expect(clientsCreated).toBe(0);
      expect(JSON.stringify(response)).not.toContain(DEPLOYMENT_BEARER);
      expect(JSON.stringify(response)).not.toContain(OPENCLAW_CREDENTIAL);
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("recovers an omitted delta when a final event repeats the last sequence (#9243)", async () => {
    let pinnedOpenClaw: PinnedOpenClawGateway | undefined;
    const diagnostics: object[] = [];
    const ids = ["voice-session", "turn", "response"];
    const service = new VoiceSessionService({
      runtimeIdentity: "voiceclaw-local",
      runtimeProfile: "voiceclaw-pinned",
      sandbox: "repository-fixture",
      agent: "main",
      createClient: () =>
        new OpenClawVoiceClient({
          gatewayUrl: "ws://127.0.0.1:18789/ws",
          credential: OPENCLAW_CREDENTIAL,
          webSocketFactory: () => {
            pinnedOpenClaw = new PinnedOpenClawGateway();
            return pinnedOpenClaw;
          },
        }),
      diagnostic: (entry) => diagnostics.push(entry),
      randomId: () => ids.shift() ?? "extra",
      randomGrant: () => Buffer.alloc(32, 9),
    });
    const port = await listen(
      createVoiceGatewayServer({
        deploymentCredential: DEPLOYMENT_BEARER,
        service,
      }),
    );
    const output: string[] = [];
    const runtime = new PinnedVoiceRuntimeAdapter(port, DEPLOYMENT_BEARER, (text) =>
      output.push(text),
    );

    const session = await runtime.createSession("runtime-conversation");
    const events = await runtime.commitTurn(session, "runtime-commit", "repository status");
    await runtime.closeSession(session);

    expect(output).toEqual(["Hello world!"]);
    expect(events.map((event) => (event as { type: string }).type)).toEqual([
      "response.started",
      "response.text.delta",
      "response.completed",
    ]);
    expect(
      events.filter((event) => (event as { type: string }).type === "response.completed"),
    ).toHaveLength(1);
    expect(
      events.filter((event) => (event as { type: string }).type === "response.failed"),
    ).toHaveLength(0);
    const runtimeVisible = JSON.stringify({ session, events, output, diagnostics });
    expect(runtimeVisible).not.toContain(OPENCLAW_CREDENTIAL);
    expect(runtimeVisible).not.toContain("pinned-openclaw-run");
    expect(runtimeVisible).not.toContain("must-not-cross");
    expect(runtimeVisible).not.toContain("repository status");
    expect(pinnedOpenClaw?.closed).toBe(true);
  });

  it("routes one committed turn into the pinned runtime output without exposing OpenClaw authority (#8378)", async () => {
    const fakeOpenClaw = new FakeOpenClawGatewayClient(OPENCLAW_CREDENTIAL);
    const ids = ["voice-session", "turn", "response"];
    const service = new VoiceSessionService({
      runtimeIdentity: "voiceclaw-local",
      runtimeProfile: "voiceclaw-pinned",
      sandbox: "repository-fixture",
      agent: "main",
      createClient: () => fakeOpenClaw,
      randomId: () => ids.shift() ?? "extra",
      randomGrant: () => Buffer.alloc(32, 9),
    });
    const server = createVoiceGatewayServer({
      deploymentCredential: DEPLOYMENT_BEARER,
      service,
    });
    const port = await listen(server);
    const output: string[] = [];
    const runtime = new PinnedVoiceRuntimeAdapter(port, DEPLOYMENT_BEARER, (text) =>
      output.push(text),
    );

    const session = await runtime.createSession("runtime-conversation");
    const events = await runtime.commitTurn(session, "runtime-commit", "repository status");
    await runtime.closeSession(session);

    expect(output.join("")).toBe("working tree is clean");
    expect(fakeOpenClaw.calls).toEqual([
      {
        idempotencyKey: "turn",
        message: "repository status",
        sessionKey: expect.stringMatching(/^agent:main:nemoclaw-voice:.+$/u),
        credential: OPENCLAW_CREDENTIAL,
      },
    ]);
    const runtimeVisible = JSON.stringify({ session, events, output });
    expect(runtimeVisible).not.toContain(OPENCLAW_CREDENTIAL);
    expect(runtimeVisible).not.toContain("agent:main:nemoclaw-voice");
    expect(runtimeVisible).not.toContain("runId");
    expect(events.map((event) => (event as { type: string }).type)).toEqual([
      "response.started",
      "response.text.delta",
      "response.text.delta",
      "response.completed",
    ]);
    expect(fakeOpenClaw.closed).toBe(true);
  });

  it("preserves agent context across separate admissions for one runtime conversation (#9411)", async () => {
    const context = new Map<string, string>();
    const pinnedOpenClaws: PinnedOpenClawGateway[] = [];
    const ids = [
      "voice-session-one",
      "turn-one",
      "response-one",
      "voice-session-two",
      "turn-two",
      "response-two",
      "voice-session-three",
      "turn-three",
      "response-three",
    ];
    const service = new VoiceSessionService({
      runtimeIdentity: "voiceclaw-local",
      runtimeProfile: "voiceclaw-pinned",
      sandbox: "repository-fixture",
      agent: "main",
      createClient: () =>
        new OpenClawVoiceClient({
          gatewayUrl: "ws://127.0.0.1:18789/ws",
          credential: OPENCLAW_CREDENTIAL,
          webSocketFactory: () => {
            const pinnedOpenClaw = new PinnedOpenClawGateway(context);
            pinnedOpenClaws.push(pinnedOpenClaw);
            return pinnedOpenClaw;
          },
        }),
      randomId: () => ids.shift() ?? "extra",
      randomGrant: () => Buffer.alloc(32, 9),
    });
    const port = await listen(
      createVoiceGatewayServer({
        deploymentCredential: DEPLOYMENT_BEARER,
        service,
      }),
    );
    const output: string[] = [];
    const runtime = new PinnedVoiceRuntimeAdapter(port, DEPLOYMENT_BEARER, (text) =>
      output.push(text),
    );

    const first = await runtime.createSession("voice-call-one");
    const firstEvents = await runtime.commitTurn(
      first,
      "runtime-commit-one",
      "My project name is Apollo.",
    );
    await runtime.closeSession(first);
    const second = await runtime.createSession("voice-call-one");
    const secondEvents = await runtime.commitTurn(
      second,
      "runtime-commit-two",
      "What is my project name?",
    );
    await runtime.closeSession(second);
    const third = await runtime.createSession("voice-call-two");
    const thirdEvents = await runtime.commitTurn(
      third,
      "runtime-commit-three",
      "What is my project name?",
    );
    await runtime.closeSession(third);

    expect(output).toEqual(["I will remember Apollo.", "Apollo", "I do not know."]);
    const sessionKeys = pinnedOpenClaws.map((gateway) => {
      const request = gateway.sent.find((entry) => entry.method === "chat.send");
      return String(request?.params.sessionKey ?? "");
    });
    expect(sessionKeys).toHaveLength(3);
    expect(sessionKeys[1]).toBe(sessionKeys[0]);
    expect(sessionKeys[2]).not.toBe(sessionKeys[0]);
    expect(pinnedOpenClaws.every((gateway) => gateway.closed)).toBe(true);
    expect(
      JSON.stringify({ first, firstEvents, second, secondEvents, third, thirdEvents }),
    ).not.toContain("nemoclaw-voice");
  });

  it("authenticates before admission parsing and rejects invalid or runtime-selected authority (#9411)", async () => {
    const fakeOpenClaw = new FakeOpenClawGatewayClient(OPENCLAW_CREDENTIAL);
    let clientsCreated = 0;
    const service = new VoiceSessionService({
      runtimeIdentity: "voiceclaw-local",
      runtimeProfile: "voiceclaw-pinned",
      sandbox: "repository-fixture",
      agent: "main",
      createClient: () => {
        clientsCreated += 1;
        return fakeOpenClaw;
      },
      randomGrant: () => Buffer.alloc(32, 9),
    });
    const port = await listen(
      createVoiceGatewayServer({
        deploymentCredential: DEPLOYMENT_BEARER,
        service,
      }),
    );

    const missingAdmission = await requestJson({
      port,
      method: "POST",
      path: "/v1/voice/sessions",
      body: { runtimeConversationId: "runtime-conversation" },
    });
    expect(missingAdmission).toEqual({
      status: 401,
      body: '{"error":"authentication_failed"}',
    });

    const invalidAdmissions = [
      { runtimeConversationId: "../namespace-escape" },
      { runtimeConversationId: "x".repeat(129) },
      {
        runtimeConversationId: "runtime-conversation",
        sessionKey: "agent:main:nemoclaw-voice:runtime-selected",
      },
      {
        runtimeConversationId: "runtime-conversation",
        agent: "runtime-selected",
        gatewayUrl: "ws://attacker.invalid/ws",
      },
    ];
    const rejectedAdmissions = await Promise.all(
      invalidAdmissions.map((body) =>
        requestJson({
          port,
          method: "POST",
          path: "/v1/voice/sessions",
          bearer: DEPLOYMENT_BEARER,
          body,
        }),
      ),
    );
    expect(rejectedAdmissions).toEqual([
      { status: 400, body: '{"error":"invalid_request"}' },
      { status: 400, body: '{"error":"invalid_request"}' },
      { status: 400, body: '{"error":"invalid_request"}' },
      { status: 400, body: '{"error":"invalid_request"}' },
    ]);
    expect(clientsCreated).toBe(0);

    const runtime = new PinnedVoiceRuntimeAdapter(port, DEPLOYMENT_BEARER, () => {});
    const session = await runtime.createSession("runtime-conversation");
    expect(clientsCreated).toBe(1);

    const wrongGrant = await requestJson({
      port,
      method: "POST",
      path: `/v1/voice/sessions/${session.voiceSessionId}/turns`,
      bearer: "wrong-session-grant",
      body: { commitId: "commit-one", text: "must not parse into an invocation" },
    });
    expect(wrongGrant.status).toBe(401);
    expect(fakeOpenClaw.calls).toHaveLength(0);

    const otherSession = await requestJson({
      port,
      method: "POST",
      path: "/v1/voice/sessions/other-session/turns",
      bearer: session.grant,
      body: { commitId: "commit-one", text: "must not invoke" },
    });
    expect(otherSession.status).toBe(404);
    expect(fakeOpenClaw.calls).toHaveLength(0);

    const oversized = await requestJson({
      port,
      method: "POST",
      path: `/v1/voice/sessions/${session.voiceSessionId}/turns`,
      bearer: session.grant,
      body: { commitId: "commit-one", text: "x".repeat(70 * 1024) },
    });
    expect(oversized.status).toBe(413);
    expect(fakeOpenClaw.calls).toHaveLength(0);

    const malformedRoute = await requestJson({
      port,
      method: "POST",
      path: "/v1/voice/sessions/%ZZ/turns",
      bearer: session.grant,
      body: { commitId: "commit-one", text: "must not invoke" },
    });
    expect(malformedRoute).toEqual({ status: 400, body: "" });
    expect(fakeOpenClaw.calls).toHaveLength(0);
    await runtime.closeSession(session);
  });
});
