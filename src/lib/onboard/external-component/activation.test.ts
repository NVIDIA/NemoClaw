// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
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

function fixture(events: string[] = []) {
  const component: PreparedExternalComponent = {
    declaration: {
      schemaVersion: 1,
      componentId: "policy-governance",
      interceptorSocketPath: "/run/user/1000/component/interceptor.sock",
      activationSocketPath: "/run/user/1000/component/activation.sock",
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

  it("uses one HTTP request over the declared activation socket (#11340)", async () => {
    const root = fs.mkdtempSync(path.join("/tmp", "nc-component-http-"));
    const socketPath = path.join(root, "activation.sock");
    let resolveRequest!: (request: string) => void;
    const received = new Promise<string>((resolve) => {
      resolveRequest = resolve;
    });
    const server = net.createServer({ allowHalfOpen: true }, (socket) => {
      const chunks: Buffer[] = [];
      socket.on("data", (chunk: Buffer) => chunks.push(chunk));
      socket.on("end", () => {
        const request = Buffer.concat(chunks).toString("utf-8");
        resolveRequest(request);
        const responseBody = '{"result":"activated"}';
        socket.end(
          `HTTP/1.1 200 OK\r\nContent-Length: ${String(Buffer.byteLength(responseBody))}\r\nConnection: close\r\n\r\n${responseBody}`,
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });

    try {
      const requestBody = '{"schemaVersion":1}';
      await expect(sendExternalComponentActivation(socketPath, requestBody)).resolves.toBe(
        '{"result":"activated"}',
      );
      const request = await received;
      expect(request).toContain("POST /v1/activate HTTP/1.1\r\n");
      expect(request).toContain("Content-Type: application/json\r\n");
      expect(request).toContain(`Content-Length: ${String(Buffer.byteLength(requestBody))}\r\n`);
      expect(request.endsWith(`\r\n\r\n${requestBody}`)).toBe(true);
    } finally {
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
