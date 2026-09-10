// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { EXTERNAL_COMPONENT_ACTIVATION_TIMEOUT_MS, type PreparedExternalComponent } from "./index";
import {
  activateExternalComponent,
  parseExternalComponentHttpResponse,
  sendExternalComponentActivation,
  type ExternalComponentActivationProof,
} from "./activation";

const policyHash = `sha256:${"a".repeat(64)}`;
const identityFingerprint = `sha256:${"b".repeat(64)}`;

function fixture(
  events: string[] = [],
  activationSocketPath = "/run/user/1000/component/activation.sock",
) {
  const component: PreparedExternalComponent = {
    declaration: {
      schemaVersion: 1,
      componentId: "policy-governance",
      interceptorSocketPath: "/run/user/1000/component/interceptor.sock",
      activationSocketPath,
    },
    revalidateBeforeGateway: vi.fn(),
    revalidateBeforeActivation: vi.fn(() => events.push("socket")),
  };
  const proof: ExternalComponentActivationProof = {
    gatewayName: "nemoclaw",
    sandboxId: "sandbox-123",
    sandboxIdentityFingerprint: identityFingerprint,
    lifecycleGeneration: "generation-1",
    policySource: "sandbox",
    policyHash,
    policyActiveVersion: 7,
    revalidate: vi.fn((operation) => events.push(operation)),
  };
  return { component, proof };
}

function responseFor(body: string, overrides: Record<string, unknown> = {}): string {
  const request = JSON.parse(body) as {
    activationId: string;
    componentId: string;
    sandbox: { id: string };
    policy: { hash: string };
  };
  return JSON.stringify({
    schemaVersion: 1,
    activationId: request.activationId,
    componentId: request.componentId,
    sandboxId: request.sandbox.id,
    policyHash: request.policy.hash,
    result: "activated",
    ...overrides,
  });
}

describe("external component activation", () => {
  it("keeps the v1 activation timeout fixed at 30 seconds (#11340)", () => {
    expect(EXTERNAL_COMPONENT_ACTIVATION_TIMEOUT_MS).toBe(30_000);
  });

  it("completes a delayed response without half-closing the request (#11340)", async () => {
    const root = fs.mkdtempSync(path.join("/tmp", "nc-component-http-"));
    const socketPath = path.join(root, "activation.sock");
    let serverSocket: net.Socket | undefined;
    let resolveRequest!: (request: {
      body: string;
      contentType: string | undefined;
      method: string | undefined;
      url: string | undefined;
    }) => void;
    const received = new Promise<Parameters<typeof resolveRequest>[0]>((resolve) => {
      resolveRequest = resolve;
    });
    const server = http.createServer((request, response) => {
      serverSocket = request.socket;
      request.socket.once("error", () => undefined);
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const activationRequest = {
          body: Buffer.concat(chunks).toString("utf-8"),
          contentType: request.headers["content-type"],
          method: request.method,
          url: request.url,
        };
        resolveRequest(activationRequest);
        setTimeout(() => {
          const responseBody = responseFor(activationRequest.body);
          response.writeHead(200, { "Content-Length": String(Buffer.byteLength(responseBody)) });
          response.end(responseBody);
        }, 25);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });

    try {
      const { component, proof } = fixture([], socketPath);
      const activation = activateExternalComponent(component, proof);
      const request = await received;
      await expect(activation).resolves.toEqual({
        kind: "activated",
      });
      expect(request).toMatchObject({
        contentType: "application/json",
        method: "POST",
        url: "/v1/activate",
      });
      expect(request.body).toContain('"componentId":"policy-governance"');
      expect(request.body).toContain('"source":"sandbox"');
    } finally {
      serverSocket?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    { delivery: "one chunk", firstCopies: 2, lastCopies: 0 },
    { delivery: "separate chunks", firstCopies: 1, lastCopies: 1 },
  ])("rejects extra responses in $delivery (#11340)", async ({ firstCopies, lastCopies }) => {
    const root = fs.mkdtempSync("/tmp/nc-extra-response-");
    const socketPath = `${root}/activation.sock`;
    const body = JSON.stringify({
      schemaVersion: 1,
      activationId: "4b5a8e18-f967-4e27-a3b2-f2cc315abe21",
      componentId: "policy-governance",
      sandboxId: "sandbox-123",
      policyHash: `sha256:${"a".repeat(64)}`,
      result: "activated",
    });
    const response = `HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`;
    let serverSocket: net.Socket | undefined;
    let done!: () => void;
    const sent = new Promise<void>((resolve) => {
      done = resolve;
    });
    const server = net.createServer({ allowHalfOpen: true }, (socket) => {
      serverSocket = socket;
      socket.on("error", () => undefined);
      socket.once("data", () => {
        socket.write(response.repeat(firstCopies));
        setTimeout(() => {
          socket.end(response.repeat(lastCopies));
          done();
        }, 20);
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      const result = await sendExternalComponentActivation(socketPath, "{}").catch(
        (error: Error) => error.message,
      );
      await sent;
      expect(result).toBe("response_invalid");
    } finally {
      serverSocket?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it("closes a pending activation socket when the fixed deadline expires (#11340)", async () => {
    const root = fs.mkdtempSync(path.join("/tmp", "nc-component-timeout-"));
    const socketPath = path.join(root, "activation.sock");
    let resolveAccepted!: () => void;
    const accepted = new Promise<void>((resolve) => {
      resolveAccepted = resolve;
    });
    const sockets: { client?: net.Socket; server?: net.Socket } = {};
    const server = net.createServer({ allowHalfOpen: true }, (socket) => {
      sockets.server = socket;
      socket.once("error", () => undefined);
      resolveAccepted();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    let expireDeadline!: () => void;
    const deadline = { unref: vi.fn() } as unknown as NodeJS.Timeout;
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: () => void,
      delay?: number,
    ) => {
      expect(delay).toBe(EXTERNAL_COMPONENT_ACTIVATION_TIMEOUT_MS);
      expireDeadline = callback;
      return deadline;
    }) as typeof setTimeout);
    const clearTimeoutSpy = vi
      .spyOn(globalThis, "clearTimeout")
      .mockImplementation((handle) => expect(handle).toBe(deadline));
    const createConnection = net.createConnection.bind(net);
    const createConnectionSpy = vi.spyOn(net, "createConnection").mockImplementation(((options: {
      path: string;
    }) => {
      const socket = createConnection(options);
      sockets.client = socket;
      return socket;
    }) as typeof net.createConnection);

    try {
      const { component, proof } = fixture([], socketPath);
      const activation = activateExternalComponent(component, proof);
      await accepted;
      expireDeadline();

      await expect(activation).resolves.toMatchObject({ kind: "ambiguous", reason: "timeout" });
      expect(sockets.client?.destroyed).toBe(true);
    } finally {
      createConnectionSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
      setTimeoutSpy.mockRestore();
      sockets.server?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts one bounded HTTP 200 JSON response (#11340)", () => {
    const body = '{"result":"activated"}';
    const raw = Buffer.from(
      `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${String(Buffer.byteLength(body))}\r\nConnection: close\r\n\r\n${body}`,
    );

    expect(parseExternalComponentHttpResponse(raw)).toBe(body);
  });

  it.each([
    ["a non-200 status", "HTTP/1.1 500 Error\r\nContent-Length: 0\r\n\r\n"],
    ["duplicate headers", "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nContent-Length: 0\r\n\r\n"],
    [
      "chunked bodies",
      "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Length: 0\r\n\r\n",
    ],
    [
      "extra responses",
      "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}",
    ],
  ])("rejects %s (#11340)", (_title, raw) => {
    expect(() => parseExternalComponentHttpResponse(Buffer.from(raw))).toThrow("response_invalid");
  });

  it("rejects response bodies above the fixed size limit (#11340)", () => {
    const raw = Buffer.from(
      "HTTP/1.1 200 OK\r\nContent-Length: 1048577\r\nConnection: close\r\n\r\n",
    );

    expect(() => parseExternalComponentHttpResponse(raw)).toThrow("response_oversized");
  });

  it("hands off only verified identity and policy fields and revalidates after success (#11340)", async () => {
    const events: string[] = [];
    const { component, proof } = fixture(events);
    const transport = vi.fn(async (_socketPath: string, body: string) => {
      events.push("request");
      const request = JSON.parse(body) as Record<string, unknown>;
      expect(Object.keys(request)).toEqual([
        "schemaVersion",
        "activationId",
        "componentId",
        "gateway",
        "sandbox",
        "policy",
      ]);
      expect(request).toMatchObject({
        schemaVersion: 1,
        componentId: "policy-governance",
        gateway: { name: "nemoclaw" },
        sandbox: {
          id: "sandbox-123",
          identityFingerprint,
          lifecycleGeneration: "generation-1",
        },
        policy: { source: "sandbox", hash: policyHash, activeVersion: 7 },
      });
      expect(body).not.toMatch(/credential|secret|token|password|api.?key/iu);
      return responseFor(body);
    });

    await expect(activateExternalComponent(component, proof, transport)).resolves.toEqual({
      kind: "activated",
    });
    expect(transport).toHaveBeenCalledWith(
      component.declaration.activationSocketPath,
      expect.any(String),
    );
    expect(events).toEqual(["socket", "before_handoff", "request", "socket", "after_activation"]);
  });

  it("returns failed activation for one exact rejection response (#11340)", async () => {
    const { component, proof } = fixture();
    const transport = async (_socketPath: string, body: string) =>
      responseFor(body, { result: "rejected" });

    const result = await activateExternalComponent(component, proof, transport);

    expect(result).toMatchObject({ kind: "rejected" });
    expect(proof.revalidate).toHaveBeenCalledExactlyOnceWith("before_handoff");
  });

  it.each([
    ["timeouts", new Error("timeout"), "timeout"],
    ["disconnects", new Error("connection"), "connection"],
    ["oversized responses", new Error("response_oversized"), "response_oversized"],
    ["invalid HTTP responses", new Error("response_invalid"), "response_invalid"],
  ])("returns ambiguous activation for %s (#11340)", async (_title, error, reason) => {
    const { component, proof } = fixture();

    await expect(
      activateExternalComponent(component, proof, async () => Promise.reject(error)),
    ).resolves.toMatchObject({ kind: "ambiguous", reason });
  });

  it.each([
    ["malformed JSON", () => "{"],
    ["unknown fields", (body: string) => responseFor(body, { message: "component text" })],
    [
      "duplicate fields",
      (body: string) =>
        responseFor(body).replace(
          '"result":"activated"',
          '"result":"activated","result":"activated"',
        ),
    ],
    ["mismatched evidence", (body: string) => responseFor(body, { sandboxId: "replacement" })],
  ])("returns ambiguous activation for %s (#11340)", async (_title, respond) => {
    const { component, proof } = fixture();

    await expect(
      activateExternalComponent(component, proof, async (_socketPath, body) => respond(body)),
    ).resolves.toMatchObject({ kind: "ambiguous", reason: "response_invalid" });
  });

  it("does not send identity when pre-handoff proof changes (#11340)", async () => {
    const { component, proof } = fixture();
    proof.revalidate = vi.fn(() => {
      throw new Error("changed");
    });
    const transport = vi.fn();

    await expect(activateExternalComponent(component, proof, transport)).resolves.toMatchObject({
      kind: "ambiguous",
      reason: "evidence_mismatch",
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it("does not report success when post-response proof changes (#11340)", async () => {
    const { component, proof } = fixture();
    proof.revalidate = vi
      .fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("changed");
      });

    await expect(
      activateExternalComponent(component, proof, async (_socketPath, body) => responseFor(body)),
    ).resolves.toMatchObject({ kind: "ambiguous", reason: "evidence_mismatch" });
  });
});
