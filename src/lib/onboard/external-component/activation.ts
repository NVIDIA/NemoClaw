// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import net from "node:net";

import {
  EXTERNAL_COMPONENT_ACTIVATION_TIMEOUT_MS,
  EXTERNAL_COMPONENT_MAX_RESPONSE_BYTES,
  EXTERNAL_COMPONENT_SCHEMA_VERSION,
  ExternalComponentContractError,
  parseStrictExternalComponentJson,
  type PreparedExternalComponent,
} from "./index";

const RESPONSE_HEADER_MAX_BYTES = 16 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256_IDENTITY_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export type ExternalComponentActivationResult =
  | { readonly kind: "activated" }
  | { readonly kind: "rejected"; readonly activationId: string }
  | {
      readonly kind: "ambiguous";
      readonly activationId: string;
      readonly reason:
        | "connection"
        | "evidence_mismatch"
        | "response_invalid"
        | "response_oversized"
        | "timeout";
    };

export interface ExternalComponentActivationProof {
  readonly gatewayName: string;
  readonly sandboxId: string;
  readonly sandboxIdentityFingerprint: string;
  readonly lifecycleGeneration: string;
  readonly policySource: "sandbox";
  readonly policyHash: string;
  readonly policyActiveVersion: number;
  revalidate(operation: "before_handoff" | "after_activation"): void | Promise<void>;
}

interface ActivationResponse {
  readonly schemaVersion: typeof EXTERNAL_COMPONENT_SCHEMA_VERSION;
  readonly activationId: string;
  readonly componentId: string;
  readonly sandboxId: string;
  readonly policyHash: string;
  readonly result: "activated" | "rejected";
}

type ActivationTransport = (socketPath: string, body: string) => Promise<string>;

export function createExternalComponentActivationId(): string {
  return randomUUID();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseActivationResponse(source: string): ActivationResponse | null {
  let value: unknown;
  try {
    value = parseStrictExternalComponentJson(source);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const fields = [
    "schemaVersion",
    "activationId",
    "componentId",
    "sandboxId",
    "policyHash",
    "result",
  ];
  if (
    Object.keys(value).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(value, field)) ||
    value.schemaVersion !== EXTERNAL_COMPONENT_SCHEMA_VERSION ||
    typeof value.activationId !== "string" ||
    !UUID_PATTERN.test(value.activationId) ||
    typeof value.componentId !== "string" ||
    typeof value.sandboxId !== "string" ||
    typeof value.policyHash !== "string" ||
    !SHA256_IDENTITY_PATTERN.test(value.policyHash) ||
    (value.result !== "activated" && value.result !== "rejected")
  ) {
    return null;
  }
  return value as unknown as ActivationResponse;
}

function externalComponentHttpResponseBytes(raw: Buffer): number | null {
  const headerEnd = raw.indexOf("\r\n\r\n");
  if (headerEnd < 0) {
    if (raw.length > RESPONSE_HEADER_MAX_BYTES + 4) throw new Error("response_invalid");
    return null;
  }
  if (headerEnd > RESPONSE_HEADER_MAX_BYTES) {
    throw new Error("response_invalid");
  }
  const headerText = raw.subarray(0, headerEnd).toString("ascii");
  const lines = headerText.split("\r\n");
  if (!/^HTTP\/1\.1 200(?: [^\r\n]*)?$/u.test(lines.shift() ?? "")) {
    throw new Error("response_invalid");
  }
  const headers = new Map<string, string>();
  for (const line of lines) {
    const match = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*([^\r\n]*)$/u.exec(line);
    if (!match?.[1] || match[2] === undefined) throw new Error("response_invalid");
    const name = match[1].toLowerCase();
    if (headers.has(name)) throw new Error("response_invalid");
    headers.set(name, match[2].trim());
  }
  if (headers.has("transfer-encoding")) throw new Error("response_invalid");
  const rawLength = headers.get("content-length");
  if (!rawLength || !/^(?:0|[1-9]\d*)$/u.test(rawLength)) {
    throw new Error("response_invalid");
  }
  const length = Number(rawLength);
  if (!Number.isSafeInteger(length) || length > EXTERNAL_COMPONENT_MAX_RESPONSE_BYTES) {
    throw new Error("response_oversized");
  }
  return headerEnd + 4 + length;
}

export function parseExternalComponentHttpResponse(raw: Buffer): string {
  const responseBytes = externalComponentHttpResponseBytes(raw);
  if (responseBytes === null || raw.length !== responseBytes) {
    throw new Error("response_invalid");
  }
  const bodyStart = raw.indexOf("\r\n\r\n") + 4;
  return raw.subarray(bodyStart).toString("utf-8");
}

export function sendExternalComponentActivation(
  socketPath: string,
  body: string,
  route: "/v1/activate" | "/v2/prepare" = "/v1/activate",
): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = Buffer.from(body, "utf-8");
    const socket = net.createConnection({ path: socketPath });
    const chunks: Buffer[] = [];
    let received = 0;
    let responseBytes: number | null = null;
    let settled = false;
    const finish = (error?: Error, response?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      if (error) reject(error);
      else resolve(response ?? "");
    };
    const deadline = setTimeout(
      () => finish(new Error("timeout")),
      EXTERNAL_COMPONENT_ACTIVATION_TIMEOUT_MS,
    );
    deadline.unref();
    socket.once("connect", () => {
      socket.write(
        `POST ${route} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nAccept: application/json\r\nContent-Length: ${String(request.length)}\r\nConnection: close\r\n\r\n${body}`,
      );
    });
    socket.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > RESPONSE_HEADER_MAX_BYTES + EXTERNAL_COMPONENT_MAX_RESPONSE_BYTES + 4) {
        finish(new Error("response_oversized"));
        return;
      }
      chunks.push(chunk);
      try {
        if (responseBytes === null) {
          responseBytes = externalComponentHttpResponseBytes(Buffer.concat(chunks, received));
        }
        if (responseBytes !== null && received > responseBytes) {
          finish(new Error("response_invalid"));
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error("response_invalid"));
      }
    });
    socket.once("end", () => {
      try {
        // EOF proves there is no second response after the declared body.
        finish(undefined, parseExternalComponentHttpResponse(Buffer.concat(chunks, received)));
      } catch (error) {
        finish(error instanceof Error ? error : new Error("response_invalid"));
      }
    });
    socket.once("error", () => finish(new Error("connection")));
  });
}

export interface ExternalComponentGatewayPreparation {
  readonly gateway: {
    readonly id: string;
    readonly issuer: string;
    readonly publicKeyPem: string;
    readonly kid: string;
    readonly extensionTokenTtlSecs: 900;
  };
  readonly network: { readonly gatewayIp: string; readonly subnet: string };
  revalidate(): void;
}

export async function prepareExternalComponentGateway(
  component: PreparedExternalComponent,
  gatewayName: string,
  preparation: ExternalComponentGatewayPreparation | void,
  transport: typeof sendExternalComponentActivation = sendExternalComponentActivation,
): Promise<void> {
  if (component.declaration.schemaVersion !== 2) return;
  try {
    if (!preparation || !component.setGatewayRevalidation) throw new Error("missing gateway proof");
    component.setGatewayRevalidation(() => preparation.revalidate());
    component.revalidateBeforeGateway();
    const declaration = component.declaration;
    const preparationId = randomUUID();
    const body = JSON.stringify({
      schemaVersion: 2,
      preparationId,
      componentId: declaration.componentId,
      gateway: { name: gatewayName, ...preparation.gateway },
      network: preparation.network,
      interceptor: declaration.interceptor,
      middleware: declaration.middleware,
      ...(declaration.providerProfileSource
        ? { providerProfileSource: declaration.providerProfileSource }
        : {}),
    });
    const raw = await transport(declaration.activationSocketPath, body, "/v2/prepare");
    const response = parseStrictExternalComponentJson(raw);
    if (
      !isRecord(response) ||
      Object.keys(response).sort().join(",") !== "componentId,preparationId,result,schemaVersion" ||
      response.schemaVersion !== 2 ||
      response.preparationId !== preparationId ||
      response.componentId !== declaration.componentId ||
      response.result !== "prepared"
    ) {
      throw new Error("preparation rejected");
    }
    component.revalidateBeforeGateway();
  } catch {
    throw new ExternalComponentContractError("preparation_failed");
  }
}

export async function activateExternalComponent(
  component: PreparedExternalComponent,
  proof: ExternalComponentActivationProof,
  transport: ActivationTransport = sendExternalComponentActivation,
  activationId = createExternalComponentActivationId(),
): Promise<ExternalComponentActivationResult> {
  const declaration = component.declaration;
  const body = JSON.stringify({
    schemaVersion: EXTERNAL_COMPONENT_SCHEMA_VERSION,
    activationId,
    componentId: declaration.componentId,
    gateway: { name: proof.gatewayName },
    sandbox: {
      id: proof.sandboxId,
      identityFingerprint: proof.sandboxIdentityFingerprint,
      lifecycleGeneration: proof.lifecycleGeneration,
    },
    policy: {
      source: proof.policySource,
      hash: proof.policyHash,
      activeVersion: proof.policyActiveVersion,
    },
  });
  try {
    component.revalidateBeforeActivation();
    await proof.revalidate("before_handoff");
  } catch {
    return { kind: "ambiguous", activationId, reason: "evidence_mismatch" };
  }
  let rawResponse: string;
  try {
    rawResponse = await transport(declaration.activationSocketPath, body);
  } catch (error) {
    const reason =
      error instanceof Error && error.message === "timeout"
        ? "timeout"
        : error instanceof Error && error.message === "response_oversized"
          ? "response_oversized"
          : error instanceof Error && error.message === "response_invalid"
            ? "response_invalid"
            : "connection";
    return { kind: "ambiguous", activationId, reason };
  }
  const response = parseActivationResponse(rawResponse);
  if (
    !response ||
    response.activationId !== activationId ||
    response.componentId !== declaration.componentId ||
    response.sandboxId !== proof.sandboxId ||
    response.policyHash !== proof.policyHash
  ) {
    return { kind: "ambiguous", activationId, reason: "response_invalid" };
  }
  if (response.result === "rejected") return { kind: "rejected", activationId };
  try {
    component.revalidateBeforeActivation();
    await proof.revalidate("after_activation");
  } catch {
    return { kind: "ambiguous", activationId, reason: "evidence_mismatch" };
  }
  return { kind: "activated" };
}
